/**
 * 鼠标触发的反应：点一下、连点、拖动、抚摸，外加右键（= 双指轻点）收起桌宠。
 *
 * 除了「拖动开始」（主进程轮询真实光标判出位移过阈值后推回来）之外，这些反应全在渲染层本地判定
 * 并落地 —— 它们只依赖指针事件和形象自己的命中框，不需要主进程知道（主进程只收一条
 * 「用户碰了形象」的 activity，用来重置闲置时钟）。
 *
 * 判定都放在 pointerup / pointermove 上，不做「按住」之类需要吞事件的手势：
 * 形象窗口的指针事件同时服务于拖动、点击穿透和目光跟随，多一个吞事件的路径就多一处打架。
 *
 * 「气头上」是一条刹车规则（见 pointerUp）：连点攒出来的生气是这段交互里唯一会被后续
 * 点击**续上**的状态，别的反应都是「这一次点击说什么就是什么」。
 */
import { PIANO_KEY_HOLD_MS } from '@shared/piano'

/** 单击的反应池：随机挑一个当前形象有的，点一下就有反应，但不至于每次都一样 */
const TAP_POOL = ['调皮', '星星眼', '脸红', '心跳', '开心兴奋', '爱心眼']
const TAP_HOLD_MS = 1500
/** 两次单击之间的最短间隔：手抖连击不该连着脸变 */
const TAP_MIN_GAP_MS = 180
/** 连点判定：这个窗口内点够 3 次就生气 */
const MULTI_TAP_WINDOW_MS = 1600
const MULTI_TAP_COUNT = 3
const MULTI_TAP_HOLD_MS = 1600
/** 连点攒出来的那张气脸：名字要立成常量，因为「气头上再点」也要按它判（见 pointerUp） */
const ANGRY_NAME = '生气'
/** 拖拽：拖动一开始就晕上，松手后再留一小段，别一放下就清醒 */
const DRAG_TAIL_MS = 800

/** 抚摸：来回移动的方向反转次数与统计窗口 */
const PET_REVERSALS = 3
const PET_WINDOW_MS = 1200
/** 单次采样至少移动这么多像素才算一次「划」，否则是抖动 */
const PET_MIN_STEP_PX = 4
const PET_FIRST_HOLD_MS = 1400
/** 摸够两轮就从脸红升级成爱心眼 */
const PET_LOVE_HOLD_MS = 1600

export interface PetInteractionHooks {
  /** 这个点算不算在形象上（单击/抚摸的判定：Live2D 按 alpha 掩码判，占位形象按命中框判） */
  isOnPet(x: number, y: number): boolean
  hasExpression(name: string): boolean
  /** 这个名字此刻是不是正挂着（气头上再点要续着它，而不是换一张脸） */
  isExpressionActive(name: string): boolean
  play(name: string, holdMs?: number): void
  /** 用户碰了形象（上报主进程，重置闲置时钟） */
  activity(): void
  /** 敲琴模式开着：点按改成显示「左键/右键」图案，其它反应让位 */
  isGameActive(): boolean
  /** 收起桌宠（恢复入口在托盘「显示 / 隐藏」） */
  requestHide(): void
}

export class PetInteraction {
  /** 最近一次单击的时刻（0 = 没有待配对的） */
  private lastTapAt = 0
  /** 连点计数与窗口起点 */
  private tapCount = 0
  private tapWindowStart = 0

  private lastX = 0
  private lastDir: -1 | 0 | 1 = 0
  private reversals = 0
  private strokeStart = 0
  /** 摸够一轮就记一次，下一轮升级成爱心眼 */
  private petRounds = 0

  constructor(private readonly hooks: PetInteractionHooks) {}

  bind(): void {
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('contextmenu', this.onContextMenu)
  }

  /**
   * 拖动真的开始了（主进程判定位移过阈值后通知）。
   * 「晕晕」在这里挂上并常驻 —— 被拎起来的那一刻就该晕，而不是等放下才补一张晕脸。
   */
  dragStarted(): void {
    // 敲琴模式下形象被拖着走没有意义，也就没有反应
    if (this.hooks.isGameActive()) return
    this.play('晕晕')
  }

  /**
   * 指针松开。由 main.ts 的拖动回调转发：`moved = true` 表示这次是拖拽，
   * 拖拽松手只给「晕晕」补一小段余韵（它早在 dragStarted 就挂上了），点击则进连点计数。
   * `x/y` 是松手的位置，用来排除「点在气泡上」这类落在窗口里、但不是逗形象的动作。
   */
  pointerUp(moved: boolean, x: number, y: number): void {
    this.hooks.activity()

    if (moved) {
      this.resetTaps()
      if (!this.hooks.isGameActive()) this.play('晕晕', DRAG_TAIL_MS)
      return
    }

    // 不在形象上就别反应。窗口的可交互区域不只是形象 —— 内容被截断的气泡也算
    //（双击它能看到全文），但用户那时不是想逗它：少了这一判，单击气泡会换一张脸，
    // 双击两次还会凑够「连点三次」把它惹毛。
    if (!this.hooks.isOnPet(x, y)) return

    if (this.hooks.isGameActive()) {
      // 敲琴里点一下 = 敲一下「左键」，这是模型自带的按键层
      this.play('左键', PIANO_KEY_HOLD_MS)
      return
    }

    // 气头上再点：只续上这张脸，不进反应池。生气是前三次点出来的**结果**，
    // 结果不该被下一次点击随手换掉（旧行为是第四下又从池子里抽一张新脸，像是没气过）。
    // 判定放在连点计数之前：气着的时候那三下不用再数 —— 反复点就是「气还没消」。
    // 续上而不是干等着它到期，是因为用户的动作还在继续：手还在戳，脸却先消了气同样不对劲。
    if (this.hooks.isExpressionActive(ANGRY_NAME)) {
      this.resetTaps()
      this.play(ANGRY_NAME, MULTI_TAP_HOLD_MS)
      return
    }

    const now = performance.now()
    // 间隔太短（双击拆出来的两次、手抖）只该压掉「换一张脸」，不该压掉连点计数 ——
    // 快速连点本来就该被数成连点，只是别让脸在两帧内翻两次。
    const rapid = now - this.lastTapAt < TAP_MIN_GAP_MS
    this.lastTapAt = now

    if (now - this.tapWindowStart > MULTI_TAP_WINDOW_MS) {
      this.tapWindowStart = now
      this.tapCount = 0
    }
    this.tapCount += 1

    if (this.tapCount >= MULTI_TAP_COUNT) {
      this.resetTaps()
      this.play(ANGRY_NAME, MULTI_TAP_HOLD_MS)
      return
    }

    if (rapid) return
    // 每次点击都从反应池里现抽一个：同一个名字连点两次也只会刷新时长，不会叠上去
    this.play(this.pickTapName(), TAP_HOLD_MS)
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.hooks.isGameActive()) return
    // 按着键划过去是拖动，不是抚摸（拖动有自己的反应，别两件事一起触发）
    if (event.buttons !== 0) {
      this.resetStroke()
      return
    }

    const inside = this.hooks.isOnPet(event.clientX, event.clientY)
    if (!inside) {
      this.resetStroke()
      this.petRounds = 0
      return
    }

    const now = performance.now()
    if (this.strokeStart !== 0 && now - this.strokeStart > PET_WINDOW_MS) {
      // 上一轮划动结束了（隔这么久没再划）：递进计数从头来，不然「两轮换爱心眼」
      // 会变成「这辈子总共摸够两轮就永久变心」
      this.resetStroke()
      this.petRounds = 0
    }
    if (this.strokeStart === 0) this.strokeStart = now

    const dx = event.clientX - this.lastX
    this.lastX = event.clientX
    if (Math.abs(dx) < PET_MIN_STEP_PX) return

    const dir = dx > 0 ? 1 : -1
    // 第一次采样只是定方向：从外面移进形象上、或者抖一下，都不算「来回划了一次」
    if (this.lastDir === 0) {
      this.lastDir = dir
      return
    }
    if (dir === this.lastDir) return
    this.lastDir = dir

    this.reversals += 1
    if (this.reversals < PET_REVERSALS) return

    // 一轮摸完就重新开始数：再想触发得重新来回划三次，这本身就是节流
    this.resetStroke()
    this.petRounds = Math.min(this.petRounds + 1, 2)

    // 第一轮脸红，接着再摸就是爱心眼 —— 一次抚摸里能看出「害羞 → 喜欢」的递进
    const loved = this.petRounds >= 2
    this.hooks.activity()
    this.play(loved ? '爱心眼' : '脸红', loved ? PET_LOVE_HOLD_MS : PET_FIRST_HOLD_MS)
  }

  /**
   * 双指轻点 / 右键：收起桌宠。
   *
   * macOS 的「辅助点按」（双指轻点）在系统层面就是一个右键事件，到渲染层已经分不开了 ——
   * 所以鼠标右键、⌃+点按会一起生效。能这么绑是因为它在这堆交互里最不容易误伤：
   * 点形象的任何其它动作都会换一张脸，而「收起」只有一种结果，托盘的「显示 / 隐藏」一秒就能叫回来。
   *
   * 敲琴时右键另有含义（模型自带的「右键」按键层）：玩到一半桌宠突然不见了太吓人，键盘优先。
   */
  private readonly onContextMenu = (event: MouseEvent): void => {
    if (this.hooks.isGameActive()) {
      event.preventDefault()
      this.play('右键', PIANO_KEY_HOLD_MS)
      return
    }
    // 和单击同一个门槛：可交互区域还包括被截断的气泡，而那时用户想的是双击看全文
    if (!this.hooks.isOnPet(event.clientX, event.clientY)) return
    this.hooks.requestHide()
  }

  private pickTapName(): string {
    const available = TAP_POOL.filter((name) => this.hooks.hasExpression(name))
    if (available.length === 0) return TAP_POOL[0]
    return available[Math.floor(Math.random() * available.length)]
  }

  /** holdMs 省略 = 常驻（拖动期间的「晕晕」就是这种） */
  private play(name: string, holdMs?: number): void {
    if (!this.hooks.hasExpression(name)) return
    this.hooks.play(name, holdMs)
  }

  private resetTaps(): void {
    this.tapCount = 0
    this.tapWindowStart = 0
  }

  private resetStroke(): void {
    this.strokeStart = 0
    this.reversals = 0
    this.lastDir = 0
  }
}
