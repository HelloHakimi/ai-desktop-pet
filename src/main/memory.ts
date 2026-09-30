/**
 * 长期记忆：一份住在配置旁边的 memory.md。
 *
 * 为什么是一个能手改的文本文件，而不是向量库 / 数据库：
 * 1. 记忆必须**看得见、删得掉** —— 打开文件就能读、改、删行，不需要任何界面；
 * 2. 用法是全文注入系统提示（有条数上限），一个小宠物够用了，检索那套是另一个量级的工程；
 * 3. 写入只有两条路、都可控：「记住：…」是用户明说（本地落盘、零 token），
 *    深夜日记是每天一次的小模型调用（拍板定的时刻，见 README）。
 *
 * 位置与对话历史同一套理由（见 chat/store.ts）：放配置文件旁边，
 * PET_CONFIG 指向不同位置的「多宠」场景各记各的。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChatMessage } from '@shared/ai'
import { createProvider } from './ai'
import { loadHistory } from './chat/store'
import { configPath, loadConfig } from './config'

const MEMORY_FILE_NAME = 'memory.md'
const STATE_FILE_NAME = 'memory-state.json'

/** 记忆条数上限：它每轮随系统提示发出去，得有个头；超了丢最旧的一条 */
const MAX_ITEMS = 60
/** 「记住：…」一条最多留这么长（再长就不是一句话，是往文件里塞文章） */
const REMEMBER_MAX_CHARS = 300
/** 摘要一次最多看这么多条对话、这么多字符（都从最近的往前取） */
const SUMMARY_MAX_MESSAGES = 200
const SUMMARY_MAX_CHARS = 12_000
/** 摘要一次最多记几条、每条多长 */
const SUMMARY_MAX_ITEMS = 5
const SUMMARY_ITEM_MAX_CHARS = 60
/** 写日记的时刻：深夜 23:30 之后（拍板定的「深夜写日记」） */
const SUMMARY_FROM_MINUTE = 23 * 60 + 30
/** 时刻检查的粒度：一分钟看一眼足够 */
const TICK_MS = 60_000

/** 文件开头的两句说明。注入系统提示时不含它 —— 那是写给用户的，不是写给模型的 */
const HEADER_LINES = [
  '<!-- 它记得的事：一行一条，可以直接改、直接删。 -->',
  '<!-- 来源：「记住：…」与每晚的日记；清空对话不会动这里。 -->'
]

const SUMMARY_PROMPT = [
  '你在替一只桌面宠物整理长期记忆。读下面这段它和用户的对话，挑出**以后相处还用得上**的事实。',
  '值得记的：怎么称呼对方、喜好与忌讳、重要的人和事、正在做的事、说好的约定。',
  '不值得记的：寒暄、天气、当次闲聊、一次性的问题。不要编造。',
  '输出要求：每条一行，以「用户」作主语，不超过 40 字，最多 5 条；没有值得记的就只回复：无'
].join('\n')

interface MemoryItem {
  /** 文件里的原样一行（含日期） */
  line: string
  /** 去掉日期前缀的正文（去重与比较用它） */
  text: string
}

interface MemoryState {
  version: 1
  /** 已经写进日记的对话条数（对话历史的长度下标） */
  lastSummarizedCount: number
  lastSummarizedAt: string
}

let timer: NodeJS.Timeout | null = null
/** 今天已经尝试过写日记（成没成都算）：失败不重试，明天一起补 —— 免得每分钟敲一次上游 */
let attemptedDay = ''

export function memoryPath(): string {
  return join(dirname(configPath()), MEMORY_FILE_NAME)
}

/**
 * 摆到系统提示里的一段；一条都没有时返回 null（别往提示词里塞一个空标题）。
 * 每轮现读：文件可能刚被「记住」改过、也可能用户正开着编辑器在改。
 */
export function memoryForPrompt(): string | null {
  const items = parseItems(readRawText())
  if (items.length === 0) return null
  return [
    '## 你记得的事（长期记忆）',
    '（相关的时候可以自然提起；不必每逢对话都复述，也不要一条条念）',
    ...items.map((item) => item.line)
  ].join('\n')
}

/**
 * 这句话是不是一条「记住：…」指令：是就返回要记的正文，不是返回 null。
 * 判定只认开头 —— 「刚才让你记住的事」这种半路出现的词不该触发。
 */
export function matchRememberCommand(text: string): string | null {
  const matched = /^记住\s*[:：]\s*([\s\S]+)$/.exec(text.trim())
  if (matched === null) return null
  const content = (matched[1] ?? '').trim().replace(/\s+/g, ' ')
  if (content.length === 0) return null
  return Array.from(content).slice(0, REMEMBER_MAX_CHARS).join('')
}

/** 记一条（「记住：…」用）。已经记过的原样内容不再重复写 */
export function appendRemembered(content: string): boolean {
  const added = addItems([content], dayKey(new Date()))
  if (added > 0) console.log(`[memory] 记下：${content}`)
  else console.log(`[memory] 这条已经记过，跳过：${content}`)
  return added > 0
}

/** 托盘「打开记忆文件…」：文件不在就先写一份带说明的空文件，别让人对着不存在的路径 */
export function ensureMemoryFile(): string {
  const path = memoryPath()
  if (!existsSync(path)) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, renderMemory([]), 'utf-8')
      console.log(`[memory] 已生成记忆文件：${path}`)
    } catch (error) {
      console.error(`[memory] 生成记忆文件失败：`, error)
    }
  }
  return path
}

/** 深夜写日记的时钟。启动时也看一眼：23:30 那一刻机器睡着了 / 应用没开，醒来补上 */
export function startMemory(): void {
  if (timer !== null) return
  timer = setInterval(tick, TICK_MS)
  tick()
}

function tick(): void {
  const now = new Date()
  // 只在 23:30–23:59 这一段动手：它睡前把今天的事记下来
  if (now.getHours() * 60 + now.getMinutes() < SUMMARY_FROM_MINUTE) return
  const day = dayKey(now)
  if (attemptedDay === day) return
  const plan = planSummary()
  if (plan === null) return // 没有新对话：不占一次调用，也不标记今天（深夜再聊起来还来得及）
  attemptedDay = day
  void runSummary(plan)
}

/** 把「还没写进日记的、最近的一段对话」挑出来；没有新内容返回 null */
function planSummary(): { messages: ChatMessage[]; nextCount: number } | null {
  const history = loadHistory()
  if (history.length === 0) return null

  const marker = readState().lastSummarizedCount
  // 历史被清空或替换过（比 marker 还短）时从头算，反正长度上限兜着
  const start = Math.min(Math.max(marker, 0), history.length)
  if (start >= history.length) return null

  const recent = history.slice(Math.max(start, history.length - SUMMARY_MAX_MESSAGES))
  const picked: ChatMessage[] = []
  let size = 0
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const item = recent[i]
    if (item === undefined) continue
    const cost = item.content.length + 8
    if (picked.length > 0 && size + cost > SUMMARY_MAX_CHARS) break
    size += cost
    picked.unshift(item)
  }
  if (picked.length === 0) return null
  return { messages: picked, nextCount: history.length }
}

async function runSummary(plan: {
  messages: ChatMessage[]
  nextCount: number
}): Promise<void> {
  let response
  try {
    const provider = createProvider(loadConfig().ai)
    response = await provider.chat({
      messages: [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: summaryInput(plan.messages) }
      ],
      // 整理记忆要稳不要花：低温度、短输出
      options: { temperature: 0.3, maxTokens: 400 }
    })
  } catch (error) {
    console.warn('[memory] 今晚的日记没写成：', error)
    return
  }
  if (!response.ok) {
    console.warn(`[memory] 今晚的日记没写成：${response.error}`)
    return
  }

  const items = parseSummary(response.content)
  const date = dayKey(new Date())
  const added = items.length > 0 ? addItems(items, date) : 0
  // 写失败了标记不动；写出空结果（模型回「无」）也算写过了，标记要前进
  writeState({
    version: 1,
    lastSummarizedCount: plan.nextCount,
    lastSummarizedAt: new Date().toISOString()
  })
  console.log(
    added > 0
      ? `[memory] 日记写下 ${added} 条：${items.join('；')}`
      : '[memory] 今天没有值得记的事'
  )
}

/** 摘要的输入：已经记得的事先摆出来（免得重复记），再给要整理的对话 */
function summaryInput(messages: ChatMessage[]): string {
  const known = parseItems(readRawText())
  const parts: string[] = []
  if (known.length > 0) {
    parts.push(`已经记得的事（不要重复记）：\n${known.map((item) => item.line).join('\n')}`)
  }
  parts.push(
    `最近的对话：\n${messages
      .map((message) => `${message.role === 'user' ? '用户' : '它'}：${message.content}`)
      .join('\n')}`
  )
  return parts.join('\n\n')
}

/** 模型给的几条：削掉列表符与空行，滤掉「无」，按上限截断 */
function parseSummary(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
    .filter((line) => line.length > 0 && !/^(无|none|n\/a)[。.！!]?$/i.test(line))
    .map((line) =>
      Array.from(line).length > SUMMARY_ITEM_MAX_CHARS
        ? `${Array.from(line).slice(0, SUMMARY_ITEM_MAX_CHARS).join('')}…`
        : line
    )
    .slice(0, SUMMARY_MAX_ITEMS)
}

// ---------- 文件读写 ----------

function readRawText(): string {
  const path = memoryPath()
  if (!existsSync(path)) return ''
  try {
    return readFileSync(path, 'utf-8')
  } catch (error) {
    console.warn(`[memory] ${path} 读取失败，本次当它没有记忆：`, error)
    return ''
  }
}

/** 文件里的条目行（`- ` 开的才算；说明行、空行、用户随便写的字都不算） */
function parseItems(raw: string): MemoryItem[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => ({
      line,
      text: line.replace(/^-\s*(?:\d{4}-\d{2}-\d{2}\s+)?/, '').trim()
    }))
}

/** 追加若干条（重复的不再写），超上限丢最旧的；返回真正写进去的条数 */
function addItems(texts: string[], date: string): number {
  const items = parseItems(readRawText())
  const known = new Set(items.map((item) => item.text))
  const fresh = texts.filter((text) => text.length > 0 && !known.has(text))
  if (fresh.length === 0) return 0

  const lines = [...items.map((item) => item.line), ...fresh.map((text) => `- ${date} ${text}`)]
  writeMemory(lines.slice(-MAX_ITEMS))
  return fresh.length
}

/** 原子写入（先写 .tmp 再 rename）：和配置、对话历史同一套做法 */
function writeMemory(lines: string[]): void {
  const path = memoryPath()
  const tmp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, renderMemory(lines), 'utf-8')
    renameSync(tmp, path)
  } catch (error) {
    console.error(`[memory] 写入 ${path} 失败，这次的事记不住了：`, error)
  }
}

function renderMemory(lines: string[]): string {
  const body = lines.length > 0 ? `${lines.join('\n')}\n` : ''
  return `${HEADER_LINES.join('\n')}\n\n${body}`
}

// ---------- 日记的进度（只存「写到对话历史的哪一条」） ----------

function statePath(): string {
  return join(dirname(configPath()), STATE_FILE_NAME)
}

function readState(): MemoryState {
  const path = statePath()
  if (!existsSync(path)) return { version: 1, lastSummarizedCount: 0, lastSummarizedAt: '' }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) throw new Error('顶层不是对象')
    const count = (parsed as Record<string, unknown>).lastSummarizedCount
    return {
      version: 1,
      lastSummarizedCount: typeof count === 'number' && Number.isFinite(count) ? count : 0,
      lastSummarizedAt: ''
    }
  } catch (error) {
    // 坏了就从零算：最多把最近的对话再整理一遍（去重会挡住重复条目），比不写强
    console.warn(`[memory] ${path} 读取失败，日记进度从零算：`, error)
    return { version: 1, lastSummarizedCount: 0, lastSummarizedAt: '' }
  }
}

function writeState(state: MemoryState): void {
  const path = statePath()
  const tmp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
    renameSync(tmp, path)
  } catch (error) {
    console.warn(`[memory] 写入 ${path} 失败（下次可能重复整理一段对话，去重会挡住）：`, error)
  }
}

function dayKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}
