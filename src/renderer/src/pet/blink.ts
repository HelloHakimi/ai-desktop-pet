/**
 * 眨眼调度：每 4–8 秒随机眨一次眼。
 *
 * 为什么不直接用库自带的 CubismEyeBlink？两条原因，任一条单独成立都不够用：
 *
 * 1. 时序调不了。它的间隔是 `random() * (2 * interval - 1)` 的均匀分布（interval 默认 4，
 *    即 0–7 秒），没有「4–8 秒」这种区间的表达方式。
 * 2. 时钟被饿死。库只在「本帧没有动作在播」时才推进眨眼，而待机动作 4 秒一轮、播完立刻
 *    重启，每轮只漏出 1 帧空档。实测 75 秒里 4500 帧只有 19 帧（0.42%）能让它推进，
 *    时钟一共攒了 0.382 秒，而它给自己抽的阈值是 0–7 秒 —— 首次眨眼要等约 4 分钟，
 *    之后平均十几分钟一次，等于不眨。
 *
 * 所以这里自己接管：本文件只负责「什么时候眨、眨到哪一相位」，
 * 参数写入由 Live2DRenderer 接在 beforeModelUpdate 上完成。
 *
 * 相位时长照抄 Cubism SDK 的默认值（闭 0.1s / 合 0.05s / 开 0.15s，一次眨眼约 0.3 秒）。
 */

/** 一次眨眼的三个相位时长（毫秒） */
const CLOSING_MS = 100
const CLOSED_MS = 50
const OPENING_MS = 150

/** 两次眨眼之间的间隔范围（毫秒） */
const MIN_GAP_MS = 4000
const MAX_GAP_MS = 8000

type Phase = 'idle' | 'closing' | 'closed' | 'opening'

export class BlinkScheduler {
  private phase: Phase = 'idle'
  private phaseStart = 0
  /** 下一次眨眼时刻；null = 还没排过（首帧到来时排） */
  private nextBlinkAt: number | null = null

  /**
   * 推进到 nowMs，返回本帧眼睛开合度（0 = 完全闭合，1 = 睁开）。
   * 返回 null 表示不在眨眼过程中 —— 调用方不该写参数，让其他参数源说话。
   */
  advance(nowMs: number): number | null {
    if (this.phase === 'idle') {
      if (this.nextBlinkAt === null) {
        this.nextBlinkAt = nowMs + this.nextGap()
        return null
      }
      if (nowMs < this.nextBlinkAt) return null
      this.phase = 'closing'
      this.phaseStart = nowMs
      // 不 return：本帧就和下面的相位推进共用一套逻辑
    }

    const elapsed = nowMs - this.phaseStart

    if (this.phase === 'closing') {
      const t = elapsed / CLOSING_MS
      if (t >= 1) {
        this.phase = 'closed'
        this.phaseStart = nowMs
        return 0
      }
      return 1 - t
    }

    if (this.phase === 'closed') {
      if (elapsed >= CLOSED_MS) {
        this.phase = 'opening'
        this.phaseStart = nowMs
      }
      return 0
    }

    // opening：开眼结束就回到 idle，并排下一次
    const t = elapsed / OPENING_MS
    if (t >= 1) {
      this.phase = 'idle'
      this.nextBlinkAt = nowMs + this.nextGap()
      return 1
    }
    return t
  }

  private nextGap(): number {
    return MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS)
  }
}
