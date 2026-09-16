/**
 * OpenAI 兼容协议的 Provider 实现。
 * DeepSeek / 通义 / Kimi / 本地 vLLM / Ollama 的 OpenAI 兼容端点都能直接复用，
 * 只要在配置里改 ai.baseUrl 与 ai.model。
 *
 * 这里刻意只用 Node 内置 fetch，不引入 openai SDK：
 * 骨架阶段依赖越少越好，而且协议本身只有这一个端点。
 */
import type { ChatResponse, TokenUsage } from '@shared/ai'
import type { AIConfig } from '@shared/config'
import type { ChatRequest, LLMProvider } from './provider'

interface ChatCompletionResponse {
  model?: string
  choices?: Array<{ message?: { content?: string } }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

const ERROR_BODY_LIMIT = 400

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = 'openai-compatible'

  constructor(private readonly config: AIConfig) {}

  async chat({ messages, options }: ChatRequest): Promise<ChatResponse> {
    const { config } = this
    if (config.apiKey.length === 0) {
      return {
        ok: false,
        error:
          '未配置 API Key：请设置环境变量 PET_API_KEY，或写入配置文件的 ai.apiKey 字段'
      }
    }

    const body = {
      model: config.model,
      messages,
      temperature: options?.temperature ?? config.temperature,
      max_tokens: options?.maxTokens ?? config.maxTokens,
      stream: false
    }

    // 放在 try 外面：catch 里报超时也要用同一个值，否则只能说「超时（默认 ms）」
    const timeoutMs = options?.timeoutMs ?? config.timeoutMs

    try {
      const response = await fetch(`${trimTrailingSlash(config.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      })

      const text = await response.text()

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          error: `HTTP ${response.status} ${response.statusText}：${truncate(text, ERROR_BODY_LIMIT)}`
        }
      }

      let data: ChatCompletionResponse
      try {
        data = JSON.parse(text) as ChatCompletionResponse
      } catch {
        return { ok: false, error: `响应不是合法 JSON：${truncate(text, ERROR_BODY_LIMIT)}` }
      }

      const content = data.choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        return { ok: false, error: `响应结构异常，未取到 choices[0].message.content：${truncate(text, ERROR_BODY_LIMIT)}` }
      }

      return {
        ok: true,
        content,
        model: data.model ?? config.model,
        usage: mapUsage(data.usage)
      }
    } catch (error) {
      return { ok: false, error: describeError(error, timeoutMs) }
    }
  }
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function truncate(text: string, limit: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact
}

function mapUsage(usage: ChatCompletionResponse['usage']): TokenUsage | undefined {
  if (!usage) return undefined
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens
  }
}

function describeError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return `请求超时（${timeoutMs} ms）`
    }
    // fetch 的网络层错误通常把原因塞在 cause 里，一并带出来方便排查
    const cause = (error as { cause?: unknown }).cause
    const causeText = cause instanceof Error ? `（原因：${cause.message}）` : ''
    return `${error.message}${causeText}`
  }
  return String(error)
}
