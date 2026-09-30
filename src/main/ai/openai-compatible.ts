/**
 * OpenAI 兼容协议的 Provider 实现（流式）。
 * DeepSeek / 通义 / Kimi / 本地 vLLM / Ollama 的 OpenAI 兼容端点都能直接复用，
 * 只要在配置里改 ai.baseUrl 与 ai.model。
 *
 * 这里刻意只用 Node 内置 fetch，不引入 openai SDK：
 * 骨架阶段依赖越少越好，而且协议本身只有这一个端点。
 *
 * 一律走流式（stream: true）：这是对话 UI 的唯一形态，留一条非流式的旁路
 * 只会多一套要维护、要验证的分支。不发 `stream_options.include_usage` ——
 * 部分兼容端点不认识这个参数会直接 400；usage 有就取、没有就算了。
 */
import type { ChatResponse, TokenUsage } from '@shared/ai'
import type { AIConfig } from '@shared/config'
import type { ChatInvocation, ChatRequest, LLMProvider } from './provider'

interface ChatCompletionChunk {
  model?: string
  choices?: Array<{ delta?: { content?: string } }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
  error?: { message?: string }
}

const ERROR_BODY_LIMIT = 400

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = 'openai-compatible'

  constructor(private readonly config: AIConfig) {}

  async chat(
    { messages, options }: ChatRequest,
    invocation: ChatInvocation = {}
  ): Promise<ChatResponse> {
    const { config } = this
    const { onDelta, signal } = invocation
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
      stream: true
    }

    // 放在 try 外面：catch 里报超时也要用同一个值，否则只能说「超时（默认 ms）」
    const timeoutMs = options?.timeoutMs ?? config.timeoutMs
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    // 用户中断与超时合并成一条信号；谁先触发就是谁
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

    try {
      const response = await fetch(`${trimTrailingSlash(config.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify(body),
        signal: requestSignal
      })

      if (!response.ok) {
        // HTTP 层面的错误发生在流开始之前，body 就是一段普通的错误 JSON
        const text = await response.text()
        return {
          ok: false,
          status: response.status,
          error: `HTTP ${response.status} ${response.statusText}：${truncate(text, ERROR_BODY_LIMIT)}`
        }
      }

      const reader = response.body?.getReader()
      if (!reader) {
        return {
          ok: false,
          error: '响应没有可读的流：中间层（代理 / 网关）可能把流式响应整体缓冲了'
        }
      }

      const decoder = new TextDecoder()
      let buffer = ''
      let content = ''
      let model = config.model
      let usage: TokenUsage | undefined

      /** 处理一行 SSE；返回 true 表示流已正常结束（收到 [DONE]） */
      const consumeLine = (rawLine: string): boolean => {
        const line = rawLine.trim()
        if (!line.startsWith('data:')) return false
        const payload = line.slice('data:'.length).trim()
        if (payload === '[DONE]') return true
        if (payload.length === 0) return false

        let chunk: ChatCompletionChunk
        try {
          chunk = JSON.parse(payload) as ChatCompletionChunk
        } catch {
          // 静默跳过会让句子悄悄断掉，不如带着现场报错 —— 这通常意味着上游根本不是
          // OpenAI 兼容端点，或者中间有东西在改写响应体。
          throw new Error(`流式响应里有无法解析的数据：${truncate(payload, ERROR_BODY_LIMIT)}`)
        }

        // 少数端点会把错误塞在 SSE 数据里而不是 HTTP 状态码上
        if (chunk.error) {
          throw new Error(`上游返回错误：${truncate(chunk.error.message ?? payload, ERROR_BODY_LIMIT)}`)
        }

        if (chunk.model) model = chunk.model
        if (chunk.usage) usage = mapUsage(chunk.usage)

        const delta = chunk.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta.length > 0) {
          content += delta
          onDelta?.(content)
        }
        return false
      }

      let finished = false
      while (!finished) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // 最后一段未必是完整行（TCP 分片可能从句子中间断开），留在 buffer 里等下一块
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (consumeLine(line)) {
            finished = true
            break
          }
        }
      }
      // 有些服务端最后一行不以换行结尾；再把 TextDecoder 里可能在多字节字符中间
      // 停下的残留吐出来（流被截断时末尾那个半个字符会被丢弃，这是有意的）
      buffer += decoder.decode()
      if (!finished && buffer.trim().length > 0) consumeLine(buffer)
      // 提前结束（收到 [DONE]）时把剩余流读干，避免连接悬挂
      if (finished) await reader.cancel().catch(() => undefined)

      return { ok: true, content, model, usage }
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

function mapUsage(usage: NonNullable<ChatCompletionChunk['usage']>): TokenUsage {
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens
  }
}

function describeError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') {
      return `请求超时（${timeoutMs} ms）`
    }
    // 用户点「停止」触发的是 AbortError，和超时不是一回事，不该报成超时
    if (error.name === 'AbortError') {
      return '请求已中断'
    }
    // fetch 的网络层错误通常把原因塞在 cause 里，一并带出来方便排查
    const cause = (error as { cause?: unknown }).cause
    const causeText = cause instanceof Error ? `（原因：${cause.message}）` : ''
    return `${error.message}${causeText}`
  }
  return String(error)
}
