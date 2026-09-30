/**
 * 专注计时（番茄钟 / 倒计时）。
 *
 * 计时住在主进程：渲染层会随「重新加载形象」整个重建，而计时不该跟着丢。
 *
 * 与闲置时钟的关系值得写清楚：这里每分钟都调一次 noteActivity()，等于持续告诉
 * 闲置时钟「有人在场」。于是专注期间桌宠专心陪着挂「爆肝」，不会切到打盹脸；
 * 顺便也解决了「正打着盹时开始专注」——noteActivity 会把打盹脸摘掉。
 *
 * 反过来 idle.ts 并不需要知道专注的存在，依赖是单向的：focus → idle。
 */
import { applyExpression, petSay } from './actions'
import { noteActivity } from './idle'

/** 专注期间挂着的脸（当前形象自带） */
const FOCUS_FACE = '爆肝'
/** 到点时的脸：一杯奶茶，等于「歇会儿」 */
const DONE_FACE = '奶茶'
/** 心跳间隔：一分钟一格，够撑住闲置时钟，也够判断到点 */
const TICK_MS = 60_000

let endsAt: number | null = null
/** 这一轮设了多久（菜单要显示它） */
let plannedMinutes = 0
let timer: NodeJS.Timeout | null = null

/** 正在专注就返回这一轮的信息，否则 null（托盘菜单据此决定显示什么） */
export function getFocusState(): { minutes: number; remainingMs: number } | null {
  if (endsAt === null) return null
  return { minutes: plannedMinutes, remainingMs: Math.max(0, endsAt - Date.now()) }
}

export function startFocus(minutes: number): void {
  finish()
  plannedMinutes = minutes
  endsAt = Date.now() + minutes * 60_000
  applyExpression({ kind: 'named', name: FOCUS_FACE })
  // 可能正打着盹，也可能只是很久没碰——两种情况都该先「醒一下」
  noteActivity()
  petSay(`好，${minutes} 分钟，我陪你`)
  timer = setInterval(tick, TICK_MS)
  console.log(`[focus] 开始专注 ${minutes} 分钟`)
}

/** 用户主动停止（没在专注时是空操作） */
export function stopFocus(): void {
  if (endsAt === null) return
  const minutes = plannedMinutes
  finish()
  petSay('不专注了？那就歇会儿')
  console.log(`[focus] 已停止专注（原计划 ${minutes} 分钟）`)
}

function tick(): void {
  // 续一次「有人在场」：专注期间桌宠不打盹
  noteActivity()
  if (endsAt === null || Date.now() < endsAt) return

  const minutes = plannedMinutes
  finish()
  applyExpression({ kind: 'named', name: DONE_FACE, holdMs: 6000 })
  petSay(`${minutes} 分钟到了，站起来动动吧`)
  console.log(`[focus] 专注结束（${minutes} 分钟）`)
}

/** 摘掉专注脸并停表。三条路径（开始新的一轮 / 主动停止 / 到点）共用 */
function finish(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  if (endsAt !== null) applyExpression({ kind: 'clear', name: FOCUS_FACE })
  endsAt = null
}
