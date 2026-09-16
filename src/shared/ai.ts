/** 对话相关的共享类型：主进程的 Provider 层与渲染层共用同一套契约。 */

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
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

/** 校验来自渲染进程（不可信）的 messages 参数 */
export function sanitizeMessages(input: unknown): ChatMessage[] | null {
  if (!Array.isArray(input) || input.length === 0) return null
  const roles: readonly string[] = ['system', 'user', 'assistant']
  const result: ChatMessage[] = []
  for (const item of input) {
    if (typeof item !== 'object' || item === null) return null
    const { role, content } = item as Record<string, unknown>
    if (typeof role !== 'string' || !roles.includes(role)) return null
    if (typeof content !== 'string') return null
    result.push({ role: role as ChatRole, content })
  }
  return result
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
