/**
 * 带选项的提问：主进程这侧的记账。
 *
 * 一条待答在同一时刻至多一个（气泡也只有一条），「谁问的、点了哪个选项怎么办」全在这里；
 * 渲染层只管把按钮画出来、把「点了第几个 / 没理它」报回来 —— 20 秒的倒计时在那边，
 * 因为悬停暂停要跟着指针走，那个状态只有渲染层有。
 *
 * owner 是给取消用的：局收尾时只该撤自己那一条，别把恰好同时在等答案的饭点问句一起撤了。
 */
import { IPC, type AskDismissReason, type AskEvent } from '@shared/ipc'
import { getPetWindow } from './pet-window'

export interface AskRequest {
  /** 谁在问（'play' / 'daily'…），取消时按它匹配 */
  owner: string
  /** 1–3 个选项，顺序即回答里的下标 */
  options: string[]
  /** 用户点了第 index 个选项 */
  onAnswer(index: number): void
  /** 按钮下线（到点没人理、气泡被收起）。被新提问顶替时不叫 */
  onDismiss?(): void
}

/**
 * 渲染层那边的倒计时是 20 秒；这里再兜一层：那条 dismiss 要是没回来
 *（渲染层崩了、页面重载），这个槽不能永久占着 —— 否则之后所有的提问都会被自己挡掉。
 */
const BACKSTOP_MS = 30_000

let nextId = 1
let pending: (AskRequest & { id: number; backstop: NodeJS.Timeout }) | null = null

/** 附上一排按钮；没有桌宠窗口时返回 false（调用方可退回只说话） */
export function showAsk(request: AskRequest): boolean {
  const win = getPetWindow()
  if (!win) return false

  // 顶掉上一条：不叫它的 onDismiss —— 那不是「没人理」，是换了新的问题
  if (pending) clearPending()

  const id = nextId++
  const backstop = setTimeout(() => {
    console.log(`[ask] 渲染层没有回报下线（id=${id}），按超时清掉`)
    const current = pending
    if (current?.id !== id) return
    clearPending()
    current.onDismiss?.()
  }, BACKSTOP_MS)

  pending = { ...request, id, backstop }
  win.webContents.send(IPC.ask, { id, options: request.options } satisfies AskEvent)
  return true
}

/** 用户点了第 index 个（来自渲染层的不可信输入，形状已在 ipc.ts 校验） */
export function answerAsk(id: number, index: number): void {
  const current = pending
  if (current === null || current.id !== id) return
  if (!Number.isInteger(index) || index < 0 || index >= current.options.length) return
  clearPending()
  console.log(`[ask] 选了「${current.options[index]}」（owner=${current.owner}）`)
  current.onAnswer(index)
}

/** 按钮下线（渲染层报的：到点 / 被顶掉 / 气泡收起） */
export function dismissAsk(id: number, reason: AskDismissReason): void {
  const current = pending
  if (current === null || current.id !== id) return
  clearPending()
  console.log(`[ask] 问题没被回答（${reason}，owner=${current.owner}）`)
  current.onDismiss?.()
}

/**
 * 主进程主动撤下（局收尾、清空对话这类）：owner 对得上才撤。
 * 刻意不触发 onDismiss —— 那是「用户没理」，这里是我们自己收摊。
 */
export function cancelAsk(owner: string): void {
  if (pending === null || pending.owner !== owner) return
  clearPending()
}

function clearPending(): void {
  if (pending === null) return
  clearTimeout(pending.backstop)
  pending = null
}
