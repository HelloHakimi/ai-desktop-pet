/**
 * 有日子味的几句：第一次见面打招呼、离开回来时的问候、饭点、节日与纪念日。
 *
 * 与 companion.ts 的分工：那边看的是「坐太久」「夜深了」这类身体状态，
 * 这里看的是日历 —— 几点、星期几、什么节、第几天。都是预设台词，不走大模型。
 *
 * 「离开」只用来算「回来」：锁屏、合盖时记一笔时间，解锁、唤醒时算差值 ——
 * 黑着屏的那一半不表演（与 system-events 同一套判断）。
 */
import { powerMonitor } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { applyExpression, petSay } from './actions'
import { showAsk } from './ask'
import { configPath, loadConfig } from './config'
import { noteActivity } from './idle'
import { canSmallTalk, canSpeak, isQuietHours } from './presence'

/** 启动后等这么久再打招呼：渲染层刚起来时气泡还没挂上，说早了那句话就丢了 */
const GREETING_DELAY_MS = 6000
/** 节点检查间隔：一分钟粒度足够 */
const NODE_TICK_MS = 60_000
/** 离开多久回来才值得打招呼（顺手锁个屏不该被问候） */
const AWAY_MIN_MS = 10 * 60 * 1000
/** 问候从几点开始：天没亮就不打扰（深夜问候归 companion 那条线） */
const DAY_START_HOUR = 8
/** 值得提一句的纪念日（天） */
const ANNIVERSARY_DAYS = [7, 30, 100, 200, 365, 500, 730, 1000]
/** 打招呼配的脸挂多久 */
const FACE_HOLD_MS = 3000

const STATE_FILE_NAME = 'pet-state.json'

const RETURN_LINES = ['你回来啦', '回来啦！', '（抬起头）欢迎回来', '诶，回来啦']

/**
 * 午饭问句：那句话照旧是本地台词，答案用两个按钮接 ——
 * 「吃了 / 还没」各有几句预设回话，点一下就得，不花 token。
 * 「还没」的回话特意留了台阶：饭点提醒是碎碎念性质的，不追问、不催第二遍。
 */
const LUNCH_ASK = {
  question: '中午了，吃了没？',
  options: ['吃了', '还没'],
  replies: [
    ['好耶，那下午好好过', '吃了就好，我不念叨啦'],
    ['快去吃点，别对付一口', '记得吃呀，我在这儿等你']
  ]
}

const DINNER_LINES = ['六点多了，今天就到这儿吧', '下班时间到，收拾收拾？']

const FRIDAY_LINES = ['周五六点！周末开始啦，撤', '六点了，周末快乐 —— 先下班']

const STATE_VERSION = 1

/** 农历：春节与中秋不用写死日期（写死的那张表过两年就开始说谎） */
const LUNAR = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'numeric', day: 'numeric' })

/** 首次运行日期（纪念日从这里算起）；启动时从状态文件读或写一次 */
let firstRunAt = ''
/** 今天已经问候过；空串 = 还没 */
let greetedDay = ''
let lunchDay = ''
let dinnerDay = ''
/** 离开的开始时间；null = 没在离开状态 */
let awaySince: number | null = null

export function startDaily(): void {
  ensureFirstRunAt()
  setTimeout(greetOnStart, GREETING_DELAY_MS)
  setInterval(tick, NODE_TICK_MS)

  const markAway = (): void => {
    awaySince = Date.now()
  }
  powerMonitor.on('lock-screen', markAway)
  powerMonitor.on('suspend', markAway)
  // 解锁与唤醒都会来：谁先到谁说话，第二个看到的 awaySince 已经是 null，不会重复问候
  powerMonitor.on('unlock-screen', greetOnReturn)
  powerMonitor.on('resume', greetOnReturn)
}

/** 启动后的每日问候：一天只说一次，天没亮就不说 */
function greetOnStart(): void {
  const now = new Date()
  if (now.getHours() < DAY_START_HOUR) return
  if (greetedDay === dayKey(now)) return
  if (!loadConfig().assist.smalltalk) return
  if (!canSmallTalk()) return
  greetedDay = dayKey(now)
  say(greetingLine(now), '开心兴奋')
}

/** 你回来了：先把它叫醒（回来时它多半正打着盹），再打招呼 */
function greetOnReturn(): void {
  const away = awaySince
  awaySince = null
  if (away === null) return
  if (Date.now() - away < AWAY_MIN_MS) return
  if (!loadConfig().assist.smalltalk) return

  const now = new Date()
  if (now.getHours() < DAY_START_HOUR || isQuietHours(now)) return
  // 这里的闸门不看「人在不在电脑前」：这两个事件本身就说明你回来了（见 presence.ts 的 canSpeak）
  if (!canSpeak()) return

  noteActivity()
  if (greetedDay !== dayKey(now)) {
    greetedDay = dayKey(now)
    say(greetingLine(now), '开心兴奋')
    return
  }
  say(pick(RETURN_LINES), '开心兴奋')
}

/** 饭点：到点那一分钟说不成（在专注 / 刚说完话 / 人不在）下一分钟还会再试，过了这个钟点就等明天 */
function tick(): void {
  if (!loadConfig().assist.smalltalk) return
  const now = new Date()
  const key = dayKey(now)
  const hour = now.getHours()

  if (hour === 12 && lunchDay !== key && canSmallTalk()) {
    lunchDay = key
    say(LUNCH_ASK.question, '奶茶')
    // 附上「吃了 / 还没」；20 秒没人理就整条收掉，不追问
    showAsk({
      owner: 'daily',
      options: [...LUNCH_ASK.options],
      onAnswer: (index) => {
        const replies = LUNCH_ASK.replies[index] ?? LUNCH_ASK.replies[0]
        if (replies !== undefined) petSay(pick(replies))
      }
    })
    return
  }
  if (hour === 18 && dinnerDay !== key && isWorkday(now) && canSmallTalk()) {
    dinnerDay = key
    say(pick(now.getDay() === 5 ? FRIDAY_LINES : DINNER_LINES), '奶茶')
  }
}

/** 「早上好，今天周五，再撑一下就是周末」 */
function greetingLine(now: Date): string {
  const hour = now.getHours()
  const part = hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好'
  const flavor = dayFlavor(now)
  return flavor === null ? part : `${part}，${flavor}`
}

/** 今天有什么说法：节日 > 纪念日 > 星期；都没有就只问个好 */
function dayFlavor(now: Date): string | null {
  const festival = festivalOf(now)
  if (festival !== null) return festival

  const days = daysSinceFirstRun(now)
  if (ANNIVERSARY_DAYS.includes(days)) return `我们已经认识 ${days} 天啦`

  const weekday = now.getDay()
  if (weekday === 5) return '今天周五，再撑一下就是周末'
  if (weekday === 1) return '又是周一……我陪你'
  if (weekday === 0 || weekday === 6) return '周末诶，今天想做点什么'
  return null
}

function festivalOf(date: Date): string | null {
  const month = date.getMonth() + 1
  const day = date.getDate()
  if (month === 1 && day === 1) return '新年快乐'
  if (month === 6 && day === 1) return '儿童节快乐，你也算小朋友'
  if (month === 10 && day === 1) return '国庆快乐'
  if (month === 12 && day === 25) return '圣诞快乐'

  const [lunarMonth, lunarDay] = LUNAR.format(date).split('-').map(Number)
  if (lunarMonth === 1 && lunarDay === 1) return '新春快乐'
  if (lunarMonth === 8 && lunarDay === 15) return '中秋快乐，吃月饼了吗'
  return null
}

function isWorkday(date: Date): boolean {
  const weekday = date.getDay()
  return weekday !== 0 && weekday !== 6
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

function daysSinceFirstRun(now: Date): number {
  const start = new Date(firstRunAt)
  if (Number.isNaN(start.getTime())) return 0
  return Math.round((startOfDay(now).getTime() - startOfDay(start).getTime()) / 86_400_000) + 1
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function say(text: string, face?: string): void {
  if (face !== undefined) applyExpression({ kind: 'named', name: face, holdMs: FACE_HOLD_MS })
  petSay(text)
  console.log(`[daily] ${text}`)
}

// ---------- 状态文件（只存「第一次见到它是什么时候」） ----------

interface DailyState {
  version: number
  firstRunAt: string
}

/**
 * 位置与对话历史同一套理由：放在配置文件旁边，PET_CONFIG 指向不同位置的「多宠」场景
 * 各带各的纪念日，而不是共用一个 userData 下的文件。
 */
function statePath(): string {
  return join(dirname(configPath()), STATE_FILE_NAME)
}

function ensureFirstRunAt(): void {
  if (firstRunAt.length > 0) return
  const stored = readStoredFirstRunAt()
  if (stored !== null) {
    firstRunAt = stored
    return
  }
  // 之前没有这份记录（这个功能是后加的）：从今天算起，而不是编一个过去的日期
  firstRunAt = new Date().toISOString()
  writeState({ version: STATE_VERSION, firstRunAt })
  console.log(`[daily] 记下首次运行日期：${firstRunAt.slice(0, 10)}`)
}

function readStoredFirstRunAt(): string | null {
  const path = statePath()
  if (!existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const value = (parsed as Record<string, unknown>).firstRunAt
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch (error) {
    console.warn(`[daily] ${path} 读取失败，纪念日从今天算起：`, error)
    return null
  }
}

/** 原子写入（先写 .tmp 再 rename）：和配置、对话历史同一套做法 */
function writeState(state: DailyState): void {
  const path = statePath()
  const tmp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
    renameSync(tmp, path)
  } catch (error) {
    console.warn(`[daily] 写入 ${path} 失败（这次的纪念日记不住）：`, error)
  }
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}
