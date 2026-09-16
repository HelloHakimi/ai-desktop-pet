/** LLM Provider 抽象：换厂商 = 换一个实现，上层（IPC / 未来的对话 UI）不用改 */

import type { ChatMessage, ChatOptions, ChatResponse } from '@shared/ai'
import type { AIConfig } from '@shared/config'

export interface ChatRequest {
  messages: ChatMessage[]
  options?: ChatOptions
}

export interface LLMProvider {
  /** 便于日志与后续多 Provider 路由 */
  readonly name: string
  chat(request: ChatRequest): Promise<ChatResponse>
}

export type ProviderFactory = (config: AIConfig) => LLMProvider
