/**
 * Live2D 渲染器（PixiJS + pixi-live2d-display）。
 *
 * 三个刻意的设计：
 * 1. Cubism Core 不进仓库（官方有再分发限制，用 `npm run setup:live2d` 单独取），
 *    模型是美术资产、单独放在 `public/models/` 下由托盘菜单扫目录发现。
 *    两者都通过运行时探测：缺 Core、缺模型、模型损坏，都会返回带原因的结果，由上层决定降级还是报错。
 * 2. pixi.js 与 pixi-live2d-display 用动态 import，只有真的要跑 Live2D 时才加载，占位形象路径不背这个包体。
 * 3. 对模型只用结构化类型（Live2DModelLike），不引入该库的类型声明 —— 这层库升级频繁，
 *    把耦合面收窄到「我们真正调用的几个方法」，升级时更不容易被类型变动卡住。
 */
import type * as PixiNS from 'pixi.js'
import type { RendererConfig } from '@shared/config'
import { BlinkScheduler } from './blink'
import { ExpressionDefs, parseExpressionEntries, type ExpressionEntry } from './expressionDefs'
import { ExpressionDirector, type ExpressionCore } from './expressionDirector'
import type { HitBox, PetRenderer } from './types'

/** Cubism Core 由官方单独分发，放在 public/vendor/ 下按需注入 */
const CUBISM_CORE_URL = './vendor/live2dcubismcore.min.js'
/** 命中框收窄比例：模型包围盒包含大量透明区域，直接用会挡住桌面（掩码不可用时的兜底） */
const HIT_INSET = 0.15

/** 命中掩码的横向格数：模型宽度被切成这么多格，纵向格数按比例算 */
const MASK_COLS = 64
/** 掩码里 alpha 到多少算「这里真的画到了东西」（0–255；留点余量给抗锯齿边缘） */
const MASK_ALPHA_MIN = 24
/** 采样邻域半径（格）：琴槌、贴纸这类薄东西不该因为正好落在格子边上就点不中 */
const MASK_SAMPLE_RADIUS = 1
/** 掩码重建间隔：形象一直在动（呼吸、待机、道具），但轮廓变化慢，秒级足够 */
const MASK_REFRESH_MS = 2000

/**
 * 帧率上限。**0 = 不限帧，跟着显示器刷新率走**（这台 60 Hz 面板上就是 60 fps）。
 *
 * 这里刻意不写 60：Pixi 的 maxFPS 是一道「这一帧不够时间就跳过」的闸门，只有它恰好等于
 * 刷新率时才既不掉帧也不空转。实测在 60 Hz 面板上 maxFPS = 60 只能跑出 58.3 fps
 * （约 3% 的帧被丢掉，表现就是时不时一顿），maxFPS = 59 更糟（56.3 fps）；
 * 只有不限帧是干净的 60.0 fps。
 *
 * 曾经把它钉在 30 想省 CPU，那是个错误的取舍 —— 桌宠可以省电，但不能卡。
 * 60 fps 在这台机器上稳定占一个核的 24%（30 fps 是 17%，1 fps 也还有 3.7% 的合成本底）。
 * 那 3.5 ms/帧的开销全在 Cubism 的骨骼/物理/网格更新里，跟分辨率、抗锯齿、画布面积
 * 都无关（三者都实测过，占用没有可测差别），所以除了降帧率没有别的杠杆可用。
 */
const TARGET_FPS = 0

type PixiApplication = InstanceType<typeof PixiNS.Application>
/** 动态 import 进来的 pixi 模块本身（掩码要用它的 RenderTexture / Matrix 这些**值**） */
type PixiModule = typeof import('pixi.js')

/** 我们实际用到的 Live2DModel 能力面 */
interface Live2DModelLike {
  x: number
  y: number
  width: number
  height: number
  rotation: number
  /** 斜切与 pivot（`anchor` 就是通过 pivot 实现的，见库的 onAnchorChange） */
  skew: { x: number; y: number }
  pivot: { x: number; y: number }
  scale: { x: number; y: number; set(x: number, y?: number): void }
  anchor: { set(x: number, y: number): void }
  getBounds(): { x: number; y: number; width: number; height: number }
  /** 模型自身坐标系里的包围盒（不含它自己的位移与缩放）：生成命中掩码时按它开离屏画面 */
  getLocalBounds(): { x: number; y: number; width: number; height: number }
  motion(group: string, index?: number): Promise<unknown>
  /**
   * 让目光/头部看向舞台坐标 (x, y)（内部会换算成模型的本地坐标并做缓动）。
   *
   * 库自带的 autoInteract 走的是 Pixi InteractionManager → canvas 的 DOM 事件，
   * 而我们的 canvas 是 `pointer-events: none`（见 style.css），那条链从头到尾收不到事件，
   * 所以鼠标跟随由渲染层自己从窗口的 pointermove 驱动（见 pet/lookAt.ts）。
   */
  focus(x: number, y: number, instant?: boolean): void
  /**
   * 库的表情槽**不用**：它是单槽语义（一个 currentExpression，新的顶掉旧的），
   * 而我们要的是可叠加的分层（墨镜 + 奶茶 + 生气脸同时成立）。
   * 表情改由 pet/expressionDefs.ts 读 exp3 参数、pet/expressionDirector.ts 每帧写。
   */
  internalModel?: {
    /**
     * 库自带眨眼（CubismEyeBlink）。我们接管后把它置成 undefined —— 它的时序是 0–7 秒的
     * 均匀分布、调不到 4–8 秒，而且只在「本帧没有动作在播」时推进，在循环待机动作下
     * 时钟被饿死（详见 pet/blink.ts 与 README 修复记录）。
     */
    eyeBlink?: unknown
    /** 参数读写通道：眨眼与表情层都在 beforeModelUpdate 时刻经这里写模型 */
    coreModel?: {
      getParameterValueById(id: string): number
      setParameterValueById(id: string, value: number): void
      /** 名字查不到时返回 -1（表情层用它筛掉当前模型没有的参数） */
      getParameterIndex(id: string): number
      /** 部件通道：配置 model.hiddenParts 用它把指定部件压透明（名字查不到时返回 NaN） */
      getPartIndex(id: string): number
      setPartOpacityByIndex(index: number, opacity: number): void
    }
    /** 模型登记的眨眼参数（model3.json 的 Groups.EyeBlink）；没登记就眨不了 */
    settings?: {
      getEyeBlinkParameters(): string[] | undefined
    }
    /** pixi 的 EventEmitter：把眨眼挂到库的参数写入窗口（beforeModelUpdate）上 */
    on(event: string, listener: () => void): void
    off(event: string, listener: () => void): void
  }
  destroy(options?: { texture?: boolean; baseTexture?: boolean }): void
}

declare global {
  interface Window {
    PIXI?: typeof PixiNS
    Live2DCubismCore?: unknown
  }
}

export type Live2DAttempt =
  | { ok: true; renderer: PetRenderer }
  | { ok: false; reason: string; detail?: string }

/**
 * 命中掩码：模型包围盒内的一张小 alpha 网格。
 *
 * 它是「生成那一刻画面的轮廓」，所以只对生成它的那块区域有效 —— 生成时把当时的包围盒
 * 一起记下来，判定时把点按比例映射回格子。模型缩放/重排（refit）之后会重建。
 */
interface AlphaMask {
  alpha: Uint8Array
  cols: number
  rows: number
  /** 掩码覆盖的区域（窗口 CSS 像素） */
  x: number
  y: number
  width: number
  height: number
}

let coreLoader: Promise<boolean> | null = null
let coreAttempts = 0

/** 注入 Cubism Core 脚本，成功与否都不抛异常（探测型加载） */
export async function loadCubismCore(): Promise<boolean> {
  if (window.Live2DCubismCore) return true

  if (!coreLoader) {
    // 重试时带上变化的 query：404 属于 Chromium 会启发式缓存的响应，
    // 否则用户装好 Core 之后的重试可能仍然拿到缓存里的那次失败。
    const src = coreAttempts === 0 ? CUBISM_CORE_URL : `${CUBISM_CORE_URL}?retry=${coreAttempts}`
    coreAttempts += 1
    coreLoader = injectScript(src)
      .then(() => Boolean(window.Live2DCubismCore))
      .catch(() => false)
  }

  const ok = await coreLoader
  // 失败不能缓存：用户很可能正是看到提示后才去跑 setup:live2d 的，
  // 如果这里把 false 记死，「重新加载形象」会一直报缺少 Core，只能重启应用。
  if (!ok) coreLoader = null
  return ok
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      // 失败后把节点摘掉，避免反复重试时在 head 里堆积死 script
      script.remove()
      reject(new Error(`无法加载 ${src}`))
    }
    document.head.appendChild(script)
  })
}

type ModelProbe =
  | {
      ok: true
      url: string
      /** 表情文件（exp3）相对 model3.json 的同级目录，拼接用 */
      baseUrl: string
      /** model3.json 里登记的表情清单；取不到就是空数组（这个形象没有表情） */
      expressions: ExpressionEntry[]
    }
  | { ok: false; url: string; reason: string }

/** 探测模型文件是否真的存在且像一份 model3.json，顺带把表情清单带回来 */
async function probeModel(relativePath: string): Promise<ModelProbe> {
  const url = `./models/${relativePath.replace(/^\/+/, '')}`
  try {
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) {
      return { ok: false, url, reason: `模型文件不存在（HTTP ${response.status}）：${url}` }
    }
    const json = (await response.json()) as {
      FileReferences?: { Moc?: unknown; Expressions?: unknown }
    }
    if (typeof json.FileReferences?.Moc !== 'string') {
      return { ok: false, url, reason: `不是有效的 model3.json（缺少 FileReferences.Moc）：${url}` }
    }
    return {
      ok: true,
      url,
      // 表情文件与 model3.json 同级：baseUrl 就是它去掉文件名的目录部分
      baseUrl: url.slice(0, url.lastIndexOf('/') + 1),
      expressions: parseExpressionEntries(json.FileReferences.Expressions)
    }
  } catch (error) {
    return { ok: false, url, reason: `读取模型失败：${describe(error)}` }
  }
}

export async function tryCreateLive2DRenderer(
  host: HTMLElement,
  config: RendererConfig
): Promise<Live2DAttempt> {
  if (!(await loadCubismCore())) {
    return { ok: false, reason: '未找到 Cubism Core，可执行 npm run setup:live2d 获取' }
  }

  const probe = await probeModel(config.model.path)
  if (!probe.ok) return { ok: false, reason: probe.reason }

  let app: PixiApplication | null = null
  let canvas: HTMLCanvasElement | null = null

  try {
    // 顺序很重要：pixi-live2d-display 在模块求值时就会去读 window.PIXI 注册 Ticker
    const PIXI = await import('pixi.js')

    // PixiJS 6 内部用 new Function() 生成 uniform/attribute 同步代码，会被 CSP 的
    // script-src 'self' 拦下并抛「does not allow unsafe-eval」。官方为此提供了这个补丁包：
    // 用预生成的代码路径替换 eval。绝不能靠往 CSP 里加 'unsafe-eval' 来解决。
    const { install } = await import('@pixi/unsafe-eval')
    install(PIXI)

    window.PIXI = PIXI

    // sharedTicker 让 Application 和模型共用同一个 Ticker。默认情况下 app 有自己的 ticker、
    // 而 pixi-live2d-display 把模型更新挂在 Ticker.shared 上，等于每帧跑两个 rAF 循环，
    // 而且限帧得设两处才管用。共用一个之后 maxFPS 一设就能同时管住「更新模型」和「渲染」。
    PIXI.Ticker.shared.maxFPS = TARGET_FPS

    app = new PIXI.Application({
      width: Math.max(host.clientWidth, 1),
      height: Math.max(host.clientHeight, 1),
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      sharedTicker: true
    })

    canvas = app.view as unknown as HTMLCanvasElement
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    host.appendChild(canvas)

    const { Live2DModel } = await import('pixi-live2d-display/cubism4')

    // autoInteract 关掉：库的鼠标跟随挂在 Pixi 的 InteractionManager 上，而那个管理器听的是
    // canvas 的 DOM 事件 —— 我们的 canvas 是 pointer-events: none，那条链收不到任何事件。
    // 跟随改由渲染层自己从窗口的 pointermove 驱动（见 pet/lookAt.ts）。
    // 注意别顺手把 autoUpdate 也关了：模型的 deltaTime 是靠它累加的，关了画面直接冻住。
    const model = (await Live2DModel.from(probe.url, {
      autoInteract: false
    })) as unknown as Live2DModelLike

    app.stage.addChild(model as unknown as PixiNS.DisplayObject)

    const renderer = new Live2DRenderer(app, model, host, config, probe, PIXI)
    renderer.refit()

    if (config.model.idleMotionGroup.length > 0) {
      void model.motion(config.model.idleMotionGroup).catch(() => {
        // 模型里没有这个动作组是常见情况，不值得打断启动流程
      })
    }

    return { ok: true, renderer }
  } catch (error) {
    // 失败要清干净，否则会留下一个空 canvas 盖在占位形象上
    try {
      app?.destroy(true)
    } catch {
      /* 销毁失败无需处理 */
    }
    canvas?.remove()
    return { ok: false, reason: 'Live2D 初始化失败', detail: describe(error) }
  }
}

class Live2DRenderer implements PetRenderer {
  readonly kind = 'live2d'
  private readonly observer: ResizeObserver
  /** 模型未缩放时的尺寸，见 measureNaturalSize() 的说明 */
  private naturalWidth = 0
  private naturalHeight = 0
  /** 接管后的眨眼；null = 这个形象没登记眨眼参数，眨不了 */
  private blink: { scheduler: BlinkScheduler; parameterIds: string[] } | null = null
  /** 配置点名要遮掉的部件（已解析成索引）；null = 这个形象没有要遮的部件 */
  private hiddenParts: number[] | null = null
  /** 命中掩码：按真实画出来的像素判「这个点算不算在形象上」；null = 拿不到，退回包围盒 */
  private mask: AlphaMask | null = null
  private maskTimer: number | null = null
  /** 生成失败只抱怨一次：失败是持续性的（驱动/上下文），每两秒刷一行日志没有意义 */
  private maskWarned = false
  /** 表情分层：谁现在挂着、每帧往模型里写什么 */
  private readonly defs: ExpressionDefs
  private readonly expressions: ExpressionDirector

  constructor(
    private readonly app: PixiApplication,
    private readonly model: Live2DModelLike,
    private readonly host: HTMLElement,
    private readonly config: RendererConfig,
    probe: Extract<ModelProbe, { ok: true }>,
    private readonly pixi: PixiModule
  ) {
    this.measureNaturalSize()
    this.observer = new ResizeObserver(() => this.refit())
    this.observer.observe(host)

    this.defs = new ExpressionDefs(probe.expressions, probe.baseUrl, this.requireCore())
    this.expressions = new ExpressionDirector(this.defs)
    // 注册顺序即执行顺序，不能调换：表情层写参数（Add 到动作写好的基准值上）必须早于眨眼，
    // 否则眨眼那次乘法修饰会作用在「还没加上表情增量」的眼睛开合度上（墨镜那种把眼睛压到
    // 闭合的表情就会在眨眼时被反着拉开）。
    this.setupExpressions()
    this.setupEyeBlink()
    this.setupHiddenParts()

    // 命中掩码：先建一次，之后按秒级节奏跟着形象更新（为什么这样刷见 refreshMask）
    this.refreshMask()
    this.maskTimer = window.setInterval(() => this.refreshMask(), MASK_REFRESH_MS)
  }

  /** 参数通道；模型没有 coreModel 时整个渲染器也不成立，所以这里是硬失败 */
  private requireCore(): ExpressionCore {
    const core = this.model.internalModel?.coreModel
    if (!core) throw new Error('模型没有暴露 coreModel，无法读写参数')
    return core
  }

  /**
   * 表情层：每帧在 beforeModelUpdate 时刻写参数 ——
   * 那是库里所有参数写入者（动作/呼吸/物理/目光）之后、model.update() 求值之前的唯一窗口，
   * 写在这里才有「这一帧我说了算」的效果（写一次留不住，动作下一轮就覆盖回去了）。
   */
  private setupExpressions(): void {
    this.model.internalModel?.on('beforeModelUpdate', this.onExpressionFrame)
  }

  private readonly onExpressionFrame = (): void => {
    const core = this.model.internalModel?.coreModel
    if (!core) return
    this.expressions.applyFrame(core)
  }

  applyExpression(name: string, holdMs?: number): void {
    this.expressions.play(name, holdMs)
  }

  toggleExpression(name: string): void {
    this.expressions.toggle(name)
  }

  removeExpression(name: string): void {
    this.expressions.remove(name)
  }

  clearExpressions(): void {
    this.expressions.clearAll()
  }

  randomExpression(): void {
    this.expressions.random()
  }

  activeExpressions(): string[] {
    return this.expressions.activeNames()
  }

  hasExpression(name: string): boolean {
    return this.defs.has(name)
  }

  /**
   * 遮掉配置里点名的部件（model.hiddenParts）—— 用来去掉形象上不想要的配件，比如翅膀。
   *
   * 为什么每帧写一次而不是设一次就完事：部件透明度是动作与表情的写入对象，设一次会被它们
   * 在下一次求值时盖掉。写在 beforeModelUpdate 上和眨眼同一个窗口 —— 那是所有参数/部件
   * 写入者之后、model.update() 求值之前的最后时机。
   *
   * 名字对不上时只警告不抛错：配置是跨形象复用的，换了个形象就会对不上，那不是错误。
   */
  private setupHiddenParts(): void {
    const core = this.model.internalModel?.coreModel
    const wanted = this.config.model.hiddenParts
    if (!core || wanted.length === 0) return

    const indexes: number[] = []
    const resolved: string[] = []
    for (const id of wanted) {
      // 名字查不到时 getPartIndex 返回的是 **NaN**，不是 -1（库的类型声明里没有这个方法，
      // 行为是从运行中的模型上实测出来的）。写成 `index < 0` 会让 NaN 溜过去 ——
      // 于是打错的部件 id 会被当成有效值传进 setPartOpacityByIndex，报错却是无声的。
      const index = core.getPartIndex(id)
      if (!Number.isInteger(index) || index < 0) {
        console.warn(`[pet] 配置要遮掉的部件不存在：${id} —— 换形象之后这里会对不上，可清空 model.hiddenParts`)
        continue
      }
      indexes.push(index)
      resolved.push(id)
    }
    if (indexes.length === 0) return

    this.hiddenParts = indexes
    console.info(`[pet] 已遮掉 ${indexes.length} 个部件：${resolved.join('、')}`)
    this.model.internalModel?.on('beforeModelUpdate', this.onHidePartsFrame)
  }

  private readonly onHidePartsFrame = (): void => {
    const core = this.model.internalModel?.coreModel
    const parts = this.hiddenParts
    if (!core || !parts) return
    for (const index of parts) core.setPartOpacityByIndex(index, 0)
  }

  /**
   * 接管眨眼：每 4–8 秒随机眨一次（调度逻辑与「为什么不用库自带」见 pet/blink.ts）。
   *
   * 参数写在 beforeModelUpdate 时刻：那是库里所有参数写入者（动作/表情/呼吸/物理/目光）
   * 之后、model.update() 求值之前的唯一窗口。写在这里的值和库自己写眨眼一样，帧尾会被
   * loadParameters() 回滚，是「只作用于本帧」的修饰，我们不需要事后清理。
   */
  private setupEyeBlink(): void {
    const internal = this.model.internalModel
    const ids = internal?.settings?.getEyeBlinkParameters() ?? []
    if (!internal || ids.length === 0) return

    internal.eyeBlink = undefined
    this.blink = { scheduler: new BlinkScheduler(), parameterIds: ids }
    internal.on('beforeModelUpdate', this.onBlinkFrame)
  }

  private readonly onBlinkFrame = (): void => {
    const blink = this.blink
    const core = this.model.internalModel?.coreModel
    if (!blink || !core) return

    const open = blink.scheduler.advance(performance.now())
    if (open === null) return

    // 乘法修饰而不是绝对值覆盖：基准值可能已经是 0（`墨镜` 表情会把眼睛按到闭合），
    // 直接写绝对值等于把闭着的眼睛拉开 —— 眨眼只该让睁着的眼睛闭上，不该反过来。
    // 库的动作曲线对眨眼用的也是乘法（`value *= eyeBlinkValue`）。
    for (const id of blink.parameterIds) {
      core.setParameterValueById(id, core.getParameterValueById(id) * open)
    }
  }

  /**
   * 量取模型的原始尺寸。
   *
   * 必须先把 scale 归 1 再量：Pixi 的 `model.width` 拿到的是**已缩放**尺寸
   * （`scale.x * 本地包围盒宽度`），如果带着上一次的缩放去量，算出来的「原始尺寸」里就含着
   * 当前缩放，refit 会把自己上一次的结果当输入 —— 每次重算都把缩放再乘一遍，
   * 最终模型会停在 modelScale 上而不是铺满窗口，缩放配置彻底失效。
   *
   * 而 refit 一定会被调用多次（ResizeObserver 注册后立刻会回调一次），
   * 所以这个自我反馈不是理论问题，是必然触发的。
   */
  private measureNaturalSize(): void {
    this.model.scale.set(1)
    this.naturalWidth = this.model.width
    this.naturalHeight = this.model.height
  }

  /** 按窗口大小重新摆放模型：底部居中、等比缩放。多次调用结果一致（幂等）。 */
  refit(): void {
    const width = this.host.clientWidth
    const height = this.host.clientHeight
    if (width <= 0 || height <= 0) return

    this.app.renderer.resize(width, height)

    // 构造时量不到（尺寸尚未就绪）就现在补量一次
    if (this.naturalWidth <= 0 || this.naturalHeight <= 0) this.measureNaturalSize()
    const { naturalWidth, naturalHeight } = this
    if (naturalWidth <= 0 || naturalHeight <= 0) return

    const fit = Math.min(width / naturalWidth, height / naturalHeight)
    this.model.scale.set(fit * this.config.window.modelScale)
    this.model.anchor.set(0.5, 1)
    this.model.x = width / 2
    this.model.y = height

    // 缩放/位置变了，掩码记的那块区域跟着作废，立刻重建一张
    this.refreshMask()
  }

  /**
   * 命中框（包围盒内缩）。现在只用在两处：气泡的定位锚点，以及掩码不可用时的兜底判定。
   * 点击穿透与抚摸走的是下面的 hitTest —— 那个按真实像素判。
   */
  getHitBox(): HitBox | null {
    const bounds = this.model.getBounds()
    if (bounds.width <= 0 || bounds.height <= 0) return null
    const insetX = bounds.width * HIT_INSET
    const insetY = bounds.height * HIT_INSET
    return {
      x: bounds.x + insetX,
      y: bounds.y + insetY,
      width: bounds.width - insetX * 2,
      height: bounds.height - insetY * 2
    }
  }

  /**
   * 这个点算不算「在形象上」：点击穿透与抚摸都由它说了算。
   *
   * 先用包围盒挡一道（绝大多数指针位置在这一步就出局，比查掩码便宜），盒内再查 alpha 掩码 ——
   * 形象轮廓之外的透明区域不该挡住桌面。掩码不可用时退回「包围盒内缩」的老语义：
   * 判错的代价是形象点不动、拖不动，比多挡一点鼠标严重得多。
   */
  hitTest(x: number, y: number): boolean {
    const bounds = this.model.getBounds()
    if (bounds.width <= 0 || bounds.height <= 0) return false

    const mask = this.mask
    if (!mask) {
      const box = this.getHitBox()
      if (!box) return false
      return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height
    }

    if (x < bounds.x || x > bounds.x + bounds.width) return false
    if (y < bounds.y || y > bounds.y + bounds.height) return false
    return this.maskHit(mask, x, y)
  }

  /** 把点映射回掩码的格子，看邻域里有没有「画到了东西」的格子 */
  private maskHit(mask: AlphaMask, x: number, y: number): boolean {
    const col = Math.floor(((x - mask.x) / mask.width) * mask.cols)
    const row = Math.floor(((y - mask.y) / mask.height) * mask.rows)

    for (let dr = -MASK_SAMPLE_RADIUS; dr <= MASK_SAMPLE_RADIUS; dr += 1) {
      const r = row + dr
      if (r < 0 || r >= mask.rows) continue
      for (let dc = -MASK_SAMPLE_RADIUS; dc <= MASK_SAMPLE_RADIUS; dc += 1) {
        const c = col + dc
        if (c < 0 || c >= mask.cols) continue
        if (mask.alpha[r * mask.cols + c] >= MASK_ALPHA_MIN) return true
      }
    }
    return false
  }

  /**
   * 重建命中掩码：把模型**离屏**画一遍，缩成一张小网格，记下每格里有没有画到东西。
   *
   * 为什么不用 `renderer.generateTexture` / `extract.canvas(model)` 那条现成的路：
   * 1. 它按模型的**本地尺寸**开离屏画面 —— 这个形象的本地尺寸是 4068²，
   *    一次 GPU 回读几十 MB，为了判一个点代价荒谬（这里自己给 resolution，压到 MASK_COLS 宽，几 KB）。
   * 2. 更要命的是它带着 `skipUpdateTransform: true` 渲染，于是模型在窗口里的**位置和缩放**
   *    一起被画进那张小画面里 —— 人物会被缩成一个点，掩码几乎全空。
   *    实测（探针）：按那条路得到的掩码只有 0.2% 的格子有东西，而真实画面是 38.5%。
   *
   * 所以这里自己做三件事：把模型自身变换临时归零 → 强制重算世界矩阵地画进离屏纹理 → 还原变换。
   * 画完再回读，掩码对应的就是「模型的本地画面」，与 getBounds() 只差一个等比缩放。
   *
   * 为什么按秒级刷新而不是每帧：轮廓（有没有琴槌、有没有戴帽子）变得很慢，而指针位置每帧都在变。
   * 实时性要求在这边，不在掩码那边 —— 每帧回读 GPU 会让动画在移动鼠标时卡顿，
   * 而每两秒回读一次小画面是察觉不到的。
   */
  private refreshMask(): void {
    // 窗口不可见时 rAF 都停了，没必要花这次回读
    if (document.visibilityState !== 'visible') return

    try {
      const local = this.model.getLocalBounds()
      if (!(local.width >= 1) || !(local.height >= 1)) return

      // app.renderer 的静态类型是 Renderer | AbstractRenderer 的联合（Application 允许两种渲染器），
      // 而 extract 插件只在 WebGL 的 Renderer 上 —— 我们建的就是它
      const renderer = this.app.renderer as PixiNS.Renderer
      const texture = this.pixi.RenderTexture.create({
        width: Math.ceil(local.width),
        height: Math.ceil(local.height),
        resolution: MASK_COLS / local.width
      })

      // 模型自身变换的快照：位置 / 缩放 / 旋转 / 斜切 / pivot 全都要归零，
      // 少归零一项，画面里就会留着那一项的偏移或缩放
      const savedTransform = {
        x: this.model.x,
        y: this.model.y,
        rotation: this.model.rotation,
        scaleX: this.model.scale.x,
        scaleY: this.model.scale.y,
        skewX: this.model.skew.x,
        skewY: this.model.skew.y,
        pivotX: this.model.pivot.x,
        pivotY: this.model.pivot.y
      }

      let source: HTMLCanvasElement
      try {
        this.model.x = 0
        this.model.y = 0
        this.model.rotation = 0
        this.model.scale.set(1, 1)
        this.model.skew.x = 0
        this.model.skew.y = 0
        this.model.pivot.x = 0
        this.model.pivot.y = 0

        const matrix = new this.pixi.Matrix()
        matrix.tx = -local.x
        matrix.ty = -local.y
        renderer.render(this.model as unknown as PixiNS.DisplayObject, {
          renderTexture: texture,
          clear: true,
          transform: matrix,
          // 必须是 false：只有让 render 重算世界矩阵，上面那次归零才生效
          // （库内部那条 generateTexture 路径恰恰是 true，这是它在这里不能用的第二个原因）
          skipUpdateTransform: false
        })
      } finally {
        this.model.x = savedTransform.x
        this.model.y = savedTransform.y
        this.model.rotation = savedTransform.rotation
        this.model.scale.set(savedTransform.scaleX, savedTransform.scaleY)
        this.model.skew.x = savedTransform.skewX
        this.model.skew.y = savedTransform.skewY
        this.model.pivot.x = savedTransform.pivotX
        this.model.pivot.y = savedTransform.pivotY
      }

      try {
        source = renderer.extract.canvas(texture) as HTMLCanvasElement
      } finally {
        texture.destroy(true)
      }

      // 尺寸应该就在 MASK_COLS 附近。差太远说明 Pixi 的 frame/resolution 约定不是这里假设的样子，
      // 与其拿一张错的掩码去判（那会让形象某半边点不动），不如不判 —— 上层会退回包围盒
      if (source.width < 8 || source.width > 1024) {
        throw new Error(`离屏画面尺寸异常：${source.width}×${source.height}`)
      }

      const cols = MASK_COLS
      const rows = Math.max(1, Math.round((source.height / source.width) * cols))
      const small = document.createElement('canvas')
      small.width = cols
      small.height = rows
      const context = small.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('拿不到 2D 上下文')

      context.drawImage(source, 0, 0, cols, rows)
      const rgba = context.getImageData(0, 0, cols, rows).data
      const alpha = new Uint8Array(cols * rows)
      for (let i = 0; i < alpha.length; i += 1) alpha[i] = rgba[i * 4 + 3]

      const bounds = this.model.getBounds()
      this.mask = {
        alpha,
        cols,
        rows,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height
      }
      this.maskWarned = false
    } catch (error) {
      this.mask = null
      if (!this.maskWarned) {
        this.maskWarned = true
        console.warn(
          '[pet] 命中掩码生成失败，回退到包围盒判定（形象轮廓外的透明区域仍会挡住鼠标）：',
          error
        )
      }
    }
  }

  /**
   * 目光跟随指针。收的是窗口内的 CSS 像素坐标 —— 舞台没有额外变换，
   * 所以它和 Pixi 的舞台坐标是同一个东西（模型自己会换算成本地坐标）。
   */
  lookAt(x: number, y: number): void {
    this.model.focus(x, y)
  }

  /** 指针离开窗口：把目光收回窗口正中，否则它会一直盯着最后停下的那个角落 */
  lookAtAway(): void {
    this.model.focus(this.host.clientWidth / 2, this.host.clientHeight / 2)
  }

  destroy(): void {
    this.observer.disconnect()
    if (this.maskTimer !== null) {
      window.clearInterval(this.maskTimer)
      this.maskTimer = null
    }
    try {
      this.model.internalModel?.off('beforeModelUpdate', this.onExpressionFrame)
      this.model.internalModel?.off('beforeModelUpdate', this.onBlinkFrame)
      this.model.internalModel?.off('beforeModelUpdate', this.onHidePartsFrame)
      // 必须显式要求一并销毁贴图。库的 destroy() 默认只销毁模型骨架，贴图会继续留在
      // Pixi 的全局 TextureCache 里 —— 于是「切换形象」变成只增不减：把这批模型都浏览
      // 一遍之后，渲染进程会一直背着几百 MB 的解码贴图，且永远不会释放。
      //
      // 加 texture + baseTexture 两个标志才能既释放解码内存，又把缓存键一起清掉
      // （Pixi 的 Texture.destroy(true) 内部会 removeFromCache）。漏掉任何一半都会出问题：
      // 只销毁不清键，下次切回这个形象会拿到一张已经销毁的贴图，直接渲染成空白。
      this.model.destroy({ texture: true, baseTexture: true })
      // app 与模型共用 Ticker.shared（sharedTicker: true）。TickerPlugin 的 destroy 会摘掉
      // 渲染回调，而 Ticker.shared 是 protected 的，destroy() 对它无效，不会被误杀。
      this.app.destroy(true)
    } catch (error) {
      console.warn('[pet] 销毁 Live2D 渲染器时出错：', error)
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
