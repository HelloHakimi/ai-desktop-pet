/**
 * 它开口之前的闸门：什么情况下主动说一句是「可爱」，什么情况下是「吵」。
 *
 * 这套判断被三处共用（碎碎念、打招呼、饭点提醒），所以集中在这里 ——
 * 最重要的是它们必须**一致**：碎碎念觉得「人在电脑前可以说」，而打招呼觉得「不能说」，
 * 用户看到的就是一只忽冷忽热的宠物。
 *
 * 与 companion.ts 里那套判断的关系：那边数的是「连续在场多久」（久坐），
 * 用的是同一口井（powerMonitor.getSystemIdleTime），但阈值与用途不同，各自持有。
 */
import { powerMonitor } from 'electron'
import { msSinceLastSay } from './actions'
import { getFocusState } from './focus'
import { getPetWindow } from './pet-window'
import { getRuntimeState } from './runtime-state'

/** 全系统多久没有键鼠输入就算「人不在」。与 companion 的离开判定取同一个值 */
const PRESENT_IDLE_SEC = 300
/** 深夜静音：这个时段只有 companion 的「深夜问候」那一条线可以说话 */
const QUIET_FROM_HOUR = 23
const QUIET_TO_HOUR = 8
/** 距它上一句话至少隔这么久，闲话才插得进去（正在跟它聊的时候不该被碎碎念打断） */
const TALK_GAP_MS = 2 * 60 * 1000

/** 人在电脑前（全系统有没有键鼠输入，不关心是哪个应用收到的） */
export function isUserPresent(): boolean {
  return powerMonitor.getSystemIdleTime() < PRESENT_IDLE_SEC
}

/** 深夜静音时段 */
export function isQuietHours(date: Date = new Date()): boolean {
  const hour = date.getHours()
  return hour >= QUIET_FROM_HOUR || hour < QUIET_TO_HOUR
}

/** 形象窗口正显示着 —— 收起来就是在说「别打扰我」，那之后它一句闲话都不该说 */
export function isPetVisible(): boolean {
  return getPetWindow()?.isVisible() ?? false
}

/** 正在忙：敲琴玩着、或专注进行中（专注就是「请勿打扰」的意思） */
export function isBusy(): boolean {
  return getRuntimeState().game || getFocusState() !== null
}

/** 距它上一句话不足 gapMs（默认 2 分钟） */
export function spokeRecently(gapMs: number = TALK_GAP_MS): boolean {
  return msSinceLastSay() < gapMs
}

/**
 * 不看「人在不在」的那一半闸门。
 *
 * 给「你回来啦」用：那条由锁屏解锁 / 唤醒事件触发，事件本身就证明人回来了，
 * 反而不能再去问系统空闲时间 —— 刚解锁的那一瞬间它可能还没归零。
 */
export function canSpeak(): boolean {
  return isPetVisible() && !isBusy() && !isQuietHours() && !spokeRecently()
}

/** 主动搭话的完整闸门：再加上「人得在电脑前」 */
export function canSmallTalk(): boolean {
  return canSpeak() && isUserPresent()
}
