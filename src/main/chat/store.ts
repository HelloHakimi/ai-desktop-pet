/**
 * 对话历史的落盘与读取（Node IO）。
 *
 * 位置：与配置文件**同目录**。这样 PET_CONFIG 指向不同位置的「多宠」场景
 * 会各自带一份记忆，而不是所有实例共用一个 userData 下的文件。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChatMessage } from '@shared/ai'
import { configPath } from '../config'

const HISTORY_FILE_NAME = 'chat-history.json'
/** 存盘上限：只留最近这么多条，防止文件随时间无限增长（1 条约百字节量级） */
const MAX_STORED_MESSAGES = 1000

interface HistoryFile {
  version: 1
  savedAt: string
  messages: ChatMessage[]
}

export function historyPath(): string {
  return join(dirname(configPath()), HISTORY_FILE_NAME)
}

/**
 * 读取历史。任何读取失败都当成「没有历史」而不是让对话不可用；
 * 坏了也不去删它 —— 下一次正常保存自然会替换，而人工抢救只需要原始文件还在。
 */
export function loadHistory(): ChatMessage[] {
  const path = historyPath()
  if (!existsSync(path)) return []
  try {
    return extractMessages(JSON.parse(readFileSync(path, 'utf-8')))
  } catch (error) {
    console.error(`[chat] ${path} 解析失败，本次从空对话开始：`, error)
    return []
  }
}

/**
 * 把历史的「坏数据」挡在门外：整体结构不对就是空数组，单条不合格就跳过单条。
 * 只认 user / assistant —— system 人设由配置文件决定，不该出现在存盘的历史里。
 */
function extractMessages(raw: unknown): ChatMessage[] {
  if (typeof raw !== 'object' || raw === null) return []
  const list = (raw as { messages?: unknown }).messages
  if (!Array.isArray(list)) return []

  const result: ChatMessage[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const { role, content } = item as Record<string, unknown>
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.length > 0) {
      result.push({ role, content })
    }
  }
  return result.slice(-MAX_STORED_MESSAGES)
}

/** 原子写入（先写 .tmp 再 rename）：中途断电也不会留下半截 JSON */
export function saveHistory(messages: ChatMessage[]): void {
  const path = historyPath()
  // 两类都不落盘：临时轮次（喂过剪贴板内容的那几轮）与本地轮次（陪玩、点单）。
  // 过滤放在这里而不是各个调用点：saveHistory 有六处调用，任何一处漏掉都会把
  // 剪贴板内容写进磁盘，而这个过滤必须是一个「没法被忘掉」的动作。
  const persistable = messages.filter(
    (message) => message.ephemeral !== true && message.local !== true
  )
  const data: HistoryFile = {
    version: 1,
    savedAt: new Date().toISOString(),
    messages: persistable.slice(-MAX_STORED_MESSAGES)
  }
  const tmp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
    renameSync(tmp, path)
  } catch (error) {
    // 写不进去不影响本次对话，只是重启后记不得
    console.error(`[chat] 写入 ${path} 失败，本轮对话不会持久化：`, error)
  }
}
