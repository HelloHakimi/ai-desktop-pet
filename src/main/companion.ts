/**
 * 主动说话：久坐提醒与深夜问候。
 *
 * 和闲置时钟（idle.ts）共用「时间」这个维度，看的却是相反的东西：
 * - idle.ts 关心「用户多久没碰桌宠」，用来打盹
 * - 这里关心「用户连续多久没离开电脑」，用来提醒歇一歇
 *
 * 后者**不能**用 idle.ts 的 lastActivityAt —— 那个只记录「和桌宠的互动」，
 * 用户在别的应用里敲一整天代码也不会碰桌宠一下，按它算会得出「一直很闲」的反结论。
 * 所以这里用全系统空闲时间（powerMonitor.getSystemIdleTime()）：
 * 它数的是「距上次键鼠输入过了多久」，不关心是哪个应用收到的输入。
 *
 * 克制体现在两处：两类提醒各有冷却；久坐的计时会被一次真正的离开清零 ——
 * 午休回来之后不该立刻又收到「你坐太久了」。文案是预设的，不走大模型：
 * 主动消息要快要稳，而且不该在用户想安静的时候发来一段 AI 生成的话。
 */
import { powerMonitor } from 'electron'
import { petSay } from './actions'
import { loadConfig } from './config'

/** 全系统多久没有键鼠输入就算「真的离开过」：连续久坐计时清零 */
const BREAK_RESET_SEC = 300
/** 连续在场多久提醒一次 */
const SEDENTARY_AFTER_MS = 90 * 60 * 1000
/** 同类提醒之间的最小间隔 */
const SEDENTARY_COOLDOWN_MS = 60 * 60 * 1000
/** 检查间隔：久坐不是秒级的事，一分钟粒度足够 */
const CHECK_INTERVAL_MS = 60_000

const SEDENTARY_LINES = [
  '你已经连着坐了一个半小时了，起来接杯水吧',
  '站起来走两步？我在这儿等你',
  '坐太久啦，抻抻腰'
]

const NIGHT_LINES = [
  '这么晚还没睡呀，明天还长着呢',
  '夜深了，早点休息吧',
  '又熬夜……我陪你，但你也要悠着点'
]

let timer: NodeJS.Timeout | null = null
/** 连续空着的时间从这一刻算起（用户离开过就推到「现在」） */
let activeSince = Date.now()
let lastSedentaryAt = 0
/** 已经问候过的那个夜晚；空串 = 今天还没问候过 */
let greetedNight = ''

export function startCompanion(): void {
  if (timer) return
  timer = setInterval(tick, CHECK_INTERVAL_MS)
}

function tick(): void {
  // 开关放在这里读而不是启动时判断：托盘的勾改完，最多一分钟就生效，不用重启
  if (!loadConfig().assist.companion) return

  const idleSec = powerMonitor.getSystemIdleTime()
  if (idleSec >= BREAK_RESET_SEC) {
    // 用户离开过：久坐计时从零开始，而且此刻不该说话（人不在屏幕前）
    activeSince = Date.now()
    return
  }

  const now = Date.now()
  if (now - activeSince >= SEDENTARY_AFTER_MS && now - lastSedentaryAt >= SEDENTARY_COOLDOWN_MS) {
    lastSedentaryAt = now
    petSay(pick(SEDENTARY_LINES))
    return
  }

  greetNight(new Date(now))
}

/** 深夜问候：一个晚上只说一次 */
function greetNight(now: Date): void {
  if (!isLateNight(now)) return
  const key = nightKey(now)
  if (key === greetedNight) return
  greetedNight = key
  petSay(pick(NIGHT_LINES))
}

/** 深夜窗口：23:30 之后，到次日 6 点 */
function isLateNight(date: Date): boolean {
  const hour = date.getHours()
  if (hour < 6) return true
  return hour === 23 && date.getMinutes() >= 30
}

/**
 * 这个「夜晚」的标识。
 *
 * 凌晨那几个小时算**前一天晚上** —— 否则 23:40 问候过之后，
 * 用户熬到 00:10 会被同一句问候再说一遍。
 */
function nightKey(date: Date): string {
  const day = new Date(date)
  if (day.getHours() < 6) day.setDate(day.getDate() - 1)
  return `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`
}

function pick(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)]
}
