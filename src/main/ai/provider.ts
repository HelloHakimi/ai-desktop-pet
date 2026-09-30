/** LLM Provider 抽象：换厂商 = 换一个实现，上层（会话模块 / 对话 UI）不用改 */

import type { ChatMessage, ChatOptions, ChatResponse } from '@shared/ai'
import type { AIConfig } from '@shared/config'

export interface ChatRequest {
  messages: ChatMessage[]
  options?: ChatOptions
}

export interface ChatInvocation {
  /**
   * 流式回调。参数是「到目前为止的完整回复」而不是本次增量片段 ——
   * 上层两个消费方（对话窗口、形象气泡）都只是把整块文本换上去，不各自维护累加状态。
   */
  onDelta?(text: string): void
  /** 用户主动中断。与超时是两条独立信号，实现里不该混为一谈 */
  signal?: AbortSignal
}

export interface LLMProvider {
  /** 便于日志与后续多 Provider 路由 */
  readonly name: string
  chat(request: ChatRequest, invocation?: ChatInvocation): Promise<ChatResponse>
}

export type ProviderFactory = (config: AIConfig) => LLMProvider
