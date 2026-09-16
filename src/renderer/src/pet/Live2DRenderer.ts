/**
 * Live2D 渲染器（PixiJS + pixi-live2d-display）。
 *
 * 三个刻意的设计：
 * 1. Cubism Core 与模型都不进仓库 —— 官方 Cubism Core 有再分发限制，模型是美术资产。
 *    两者都通过运行时探测：缺 Core、缺模型、模型损坏，都会返回带原因的结果，由上层决定降级还是报错。
 * 2. pixi.js 与 pixi-live2d-display 用动态 import，只有真的要跑 Live2D 时才加载，占位形象路径不背这个包体。
 * 3. 对模型只用结构化类型（Live2DModelLike），不引入该库的类型声明 —— 这层库升级频繁，
 *    把耦合面收窄到「我们真正调用的几个方法」，升级时更不容易被类型变动卡住。
 */
import type * as PixiNS from 'pixi.js'
import type { RendererConfig } from '@shared/config'
import type { HitBox, PetRenderer } from './types'

/** Cubism Core 由官方单独分发，放在 public/vendor/ 下按需注入 */
const CUBISM_CORE_URL = './vendor/live2dcubismcore.min.js'
/** 命中框收窄比例：模型包围盒包含大量透明区域，直接用会挡住桌面 */
const HIT_INSET = 0.15

type PixiApplication = InstanceType<typeof PixiNS.Application>

/** 我们实际用到的 Live2DModel 能力面 */
interface Live2DModelLike {
  x: number
  y: number
  width: number
  height: number
  scale: { set(value: number): void }
  anchor: { set(x: number, y: number): void }
  getBounds(): { x: number; y: number; width: number; height: number }
  motion(group: string, index?: number): Promise<unknown>
  expression(name?: string): Promise<unknown>
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

interface ModelProbe {
  ok: boolean
  url: string
  reason?: string
}

/** 探测模型文件是否真的存在且像一份 model3.json */
async function probeModel(relativePath: string): Promise<ModelProbe> {
  const url = `./models/${relativePath.replace(/^\/+/, '')}`
  try {
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) {
      return { ok: false, url, reason: `模型文件不存在（HTTP ${response.status}）：${url}` }
    }
    const json = (await response.json()) as { FileReferences?: { Moc?: unknown } }
    if (typeof json.FileReferences?.Moc !== 'string') {
      return { ok: false, url, reason: `不是有效的 model3.json（缺少 FileReferences.Moc）：${url}` }
    }
    return { ok: true, url }
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
  if (!probe.ok) return { ok: false, reason: probe.reason ?? '模型不可用' }

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
    const { Live2DModel } = await import('pixi-live2d-display/cubism4')

    app = new PIXI.Application({
      width: Math.max(host.clientWidth, 1),
      height: Math.max(host.clientHeight, 1),
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true
    })

    canvas = app.view as unknown as HTMLCanvasElement
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    host.appendChild(canvas)

    const model = (await Live2DModel.from(probe.url, {
      autoInteract: config.model.autoInteract
    })) as unknown as Live2DModelLike

    app.stage.addChild(model as unknown as PixiNS.DisplayObject)

    const renderer = new Live2DRenderer(app, model, host, config)
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

  constructor(
    private readonly app: PixiApplication,
    private readonly model: Live2DModelLike,
    private readonly host: HTMLElement,
    private readonly config: RendererConfig
  ) {
    this.measureNaturalSize()
    this.observer = new ResizeObserver(() => this.refit())
    this.observer.observe(host)
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
  }

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

  playMotion(group?: string): void {
    const target = group ?? this.config.model.idleMotionGroup
    if (target.length === 0) return
    void this.model.motion(target).catch(() => {
      /* 动作组不存在时静默忽略 */
    })
  }

  setExpression(name: string): void {
    void this.model.expression(name).catch(() => {
      /* 表情不存在时静默忽略 */
    })
  }

  destroy(): void {
    this.observer.disconnect()
    try {
      // 必须显式要求一并销毁贴图。库的 destroy() 默认只销毁模型骨架，贴图会继续留在
      // Pixi 的全局 TextureCache 里 —— 于是「切换形象」变成只增不减：实测把 6 个形象
      // 都看过一遍后，渲染进程多背了约 490 MB 的解码贴图，且永远不会释放。
      //
      // 加 texture + baseTexture 两个标志才能既释放解码内存，又把缓存键一起清掉
      // （Pixi 的 Texture.destroy(true) 内部会 removeFromCache）。漏掉任何一半都会出问题：
      // 只销毁不清键，下次切回这个形象会拿到一张已经销毁的贴图，直接渲染成空白。
      this.model.destroy({ texture: true, baseTexture: true })
      this.app.destroy(true)
    } catch (error) {
      console.warn('[pet] 销毁 Live2D 渲染器时出错：', error)
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
