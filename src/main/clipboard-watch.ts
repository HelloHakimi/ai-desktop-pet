/**
 * 剪贴板观察者：读剪贴板里的纯文本，记下最近几段。
 *
 * 两个功能共用它：
 * - 「选中即处理」把当前这段当输入（用户刚复制的那段文字）
 * - 「剪贴板历史」把最近几段列给托盘
 *
 * **只存内存，不落盘。** 剪贴板里经常是密码、token、验证码，这类东西没有理由写进磁盘，
 * 所以这里连一个「要不要落盘」的开关都不提供 —— 没有开关，就没有被写错的配置。
 *
 * 为什么是轮询：Electron 在 macOS 上拿不到剪贴板变更事件，只能定时看。
 * 只读文本、不读图片 —— 图片那一次回读是 MB 级的，而这两个功能都只关心文字。
 *
 * 一处关键约定：**想用剪贴板内容的调用方要直接调 readClipboardText()，不要读缓存**。
 * 轮询是秒级的，用户「复制 → 立刻按快捷键」完全可能跑在两次轮询之间，
 * 读缓存就会拿到上一次的内容 —— 那是个会让人莫名其妙翻译错东西的 bug。
 */
import { clipboard } from 'electron'
import { loadConfig } from './config'

/** 轮询间隔：剪贴板变化是人的操作，一秒粒度足够，再密也没意义 */
const POLL_MS = 1000

let timer: NodeJS.Timeout | null = null
/** 最近几段文本，[0] 是最新的。只存内存，重启即忘 */
let recent: string[] = []

export function startClipboardWatch(): void {
  if (timer) return
  timer = setInterval(() => {
    readClipboardText()
  }, POLL_MS)
}

/** 当场读一次剪贴板，顺手记进历史；返回读到的文本（空串 = 剪贴板里没有文字） */
export function readClipboardText(): string {
  // readText 在剪贴板里是图片/文件时返回空串，正好就是我们要的语义
  const text = clipboard.readText().trim()
  if (text.length > 0) remember(text)
  return text
}

/** 最近几段，最新的在前（托盘「剪贴板历史」用） */
export function recentClipboardTexts(): string[] {
  return [...recent]
}

function remember(text: string): void {
  // 同一段文字被重新复制（在别处粘过一次又复制回来）不再记一条：
  // 历史里连着两条一样的内容只是噪音，而且会让「换回上一条」变得没法用
  if (recent[0] === text) return
  const limit = loadConfig().assist.clipboardHistory
  recent = [text, ...recent.filter((item) => item !== text)].slice(0, limit)
}
