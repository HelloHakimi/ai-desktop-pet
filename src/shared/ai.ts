/** 对话相关的共享类型：主进程的 Provider 层与渲染层共用同一套契约。 */

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
  /**
   * 临时轮次：只存在于内存，落盘时被过滤掉（见 main/chat/store.ts 的 saveHistory）。
   *
   * 「选中即处理」用它 —— 喂进去的是剪贴板内容，里面可能是密码、token，
   * 用户明确要求这类东西不写进磁盘。标记只影响落盘，对话上下文与界面照常包含它，
   * 所以「翻成英文」这样的追问仍然接得上。
   */
  ephemeral?: boolean
  /**
   * 本地轮次：这一轮不是大模型回的，而是本地陪玩接住的（点单、猜数字、抛硬币…）。
   *
   * 与 ephemeral 是两回事，别合并：ephemeral 只是不落盘，模型照样看得见
   *（「选中即处理」的语境要接得上）；local 是模型**看不见**的 ——
   * 让它在下一轮读到「user: 石头」，只会莫名其妙地接着猜拳。
   */
  local?: boolean
}

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
}

export interface TokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

/** 成功结果 */
export interface ChatSuccess {
  ok: true
  content: string
  model: string
  usage?: TokenUsage
}

/**
 * 失败结果。
 * 之所以用返回值而不是抛异常，是因为错误要跨 IPC 传递：Electron 序列化 Error 会丢失
 * 细节和堆栈，用可序列化的判别联合更可靠。
 */
export interface ChatFailure {
  ok: false
  error: string
  status?: number
}

export type ChatResponse = ChatSuccess | ChatFailure

/** 说话长度上限：渲染层输入框据此限制，主进程收到超长文本也会截断（边界校验） */
export const MAX_USER_TEXT_LENGTH = 4000

/**
 * 校验来自渲染进程（不可信）的一轮用户输入。
 * 空串（或纯空白）返回 null —— 空消息没有任何意义，也不该进历史。
 */
export function sanitizeUserText(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const text = input.trim()
  if (text.length === 0) return null
  return text.slice(0, MAX_USER_TEXT_LENGTH)
}

/**
 * 流式增量。
 *
 * `text` 是「到目前为止的完整回复」而不是本次增量片段：窗口和气泡都只是把这块文本
 * 整体替换上去，不用各自维护累加状态，漏收一次事件也不会把句子接错位。
 */
export interface ChatDeltaEvent {
  text: string
}

export interface ChatDoneEvent {
  content: string
  model: string
  usage?: TokenUsage
  /** 用户中途点了「停止」：content 是停下时已生成的部分，可能为空 */
  stopped?: boolean
}

export interface ChatErrorEvent {
  error: string
  status?: number
}

/**
 * 把失败翻译成一句人话，厂商原文接在后面（用 · 分隔，和日志文案同一套写法）。
 *
 * 为什么两句都给：只给原文（`HTTP 401 Unauthorized：{"error":…}`）普通用户看不懂，
 * 而这个应用配错 Key / 模型名是**最常见**的失败；只给人话又会把排查线索丢掉 ——
 * 「Key 不对」和「额度用完」在上游那一行里区分得清清楚楚。
 * 人话放在前面还有个实际好处：形象气泡只显示前 60 个字，先看到的必须是能看懂的那句。
 */
export function explainChatError(error: string, status?: number): string {
  const hint = statusHint(status)
  return hint === null ? error : `${hint} · ${error}`
}

function statusHint(status: number | undefined): string | null {
  switch (status) {
    case 400:
      return '上游拒绝了这次请求：多半是模型名不对'
    case 401:
      return 'API Key 不对或没配（PET_API_KEY / ai.apiKey）'
    case 403:
      return '这个 Key 没有访问权限'
    case 404:
      return '接口地址不对：检查 ai.baseUrl 是否带上了 /v1'
    case 429:
      return '请求太频繁，或额度用完了'
    default:
      return status !== undefined && status >= 500 ? '上游服务出错，等会儿再试' : null
  }
}

/** chat:send 的返回值：只表达「请求有没有被接受」，回复内容走事件推送 */
export type ChatSendResult = { ok: true } | { ok: false; error: string }

/**
 * 对话窗口打开时拉取的快照。
 *
 * `streaming` 是「正在生成的那一轮到目前为止的文本」—— 关窗不中断生成，
 * 所以重开窗口时可能正赶上流式的中间态，需要接着画而不是从空的开始等增量。
 */
export interface ChatHistorySnapshot {
  messages: ChatMessage[]
  streaming: { text: string } | null
}

/**
 * 把配置里的 systemPrompt 放到对话最前面。
 *
 * 渲染层的 messages 里带的 system 消息会被剔除：人设由配置文件（用户）决定，
 * 不该由渲染层决定 —— 而渲染层是理论上可被页面脚本影响的一侧。
 * 配置为空时保留原样，此时会话可以完全没有 system 消息。
 */
export function withSystemPrompt(messages: ChatMessage[], systemPrompt: string): ChatMessage[] {
  const rest = messages.filter((message) => message.role !== 'system')
  const prompt = systemPrompt.trim()
  return prompt.length === 0 ? rest : [{ role: 'system', content: prompt }, ...rest]
}
