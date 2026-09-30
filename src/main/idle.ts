/**
 * 闲置时钟：长时间没人碰就自己打盹。
 *
 * 打盹挂的是「闭眼口水」（深夜换成「阴暗」），醒来只做一件事：把那张脸摘掉。
 * **刻意不给醒来配「开心兴奋」**：醒来总是因为用户做了点什么，而那个动作多半已经带着
 * 自己的反应了（点一下有反应池、发消息有关键词）—— 这里再插一张脸只会把那些盖掉，
 * 还得让所有调用方记住「先上报 activity 再套表情」的顺序。少一张脸，少一处要维护的顺序。
 */
import { applyExpression } from './actions'
import { getRuntimeState } from './runtime-state'

/** 多久没交互算「没人理」 */
const IDLE_AFTER_MS = 5 * 60 * 1000
/** 检查间隔：打盹不是秒级的事，20 秒粒度足够 */
const CHECK_INTERVAL_MS = 20_000

const NIGHT_FACE = '阴暗'
const DAY_FACE = '闭眼口水'

let lastActivityAt = Date.now()
/** 正挂着的那张打盹脸；null = 醒着 */
let sleepingFace: string | null = null
let timer: NodeJS.Timeout | null = null
/** 打盹开始时的通知：smalltalk 用它配一句「好困…」—— 说话（开关、冷却）归那边，这里只管脸 */
let napListener: (() => void) | null = null

export function onNapStart(listener: () => void): void {
  napListener = listener
}

/**
 * 用户做了点什么（打字、点形象、动托盘菜单）。
 * 醒来只摘打盹脸，不动别的层 —— 用户手动套的眼镜不该因为打了个盹就没了。
 */
export function noteActivity(): void {
  lastActivityAt = Date.now()
  if (sleepingFace === null) return
  const face = sleepingFace
  sleepingFace = null
  applyExpression({ kind: 'clear', name: face })
  console.log(`[pet] 已醒来（摘掉「${face}」）`)
}

/**
 * 正打着盹吗。
 *
 * 给对话用：说一句话就会把它叫醒（noteActivity 摘掉打盹脸），
 * 所以「刚才在打盹」这件事**只能在这之前问**，问晚了就永远是否。
 */
export function isSleeping(): boolean {
  return sleepingFace !== null
}

export function startIdleWatch(): void {
  if (timer) return
  timer = setInterval(() => {
    if (sleepingFace !== null) return
    // 敲琴时别睡：用户正在玩，键盘随时会响
    if (getRuntimeState().game) return
    if (Date.now() - lastActivityAt < IDLE_AFTER_MS) return

    const face = isNight() ? NIGHT_FACE : DAY_FACE
    sleepingFace = face
    applyExpression({ kind: 'named', name: face })
    console.log(`[pet] 闲置 ${Math.round(IDLE_AFTER_MS / 60000)} 分钟，切到「${face}」`)
    // 先把脸挂上再通知：那边说的是「我要睡了」，话落在闭上的眼睛之后才对
    napListener?.()
  }, CHECK_INTERVAL_MS)
}

function isNight(): boolean {
  const hour = new Date().getHours()
  return hour >= 23 || hour < 6
}
