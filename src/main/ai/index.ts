/** Provider 注册表：新增厂商只需在这里注册一个工厂函数 */
import type { AIConfig } from '@shared/config'
import { OpenAICompatibleProvider } from './openai-compatible'
import type { LLMProvider, ProviderFactory } from './provider'

const registry = new Map<string, ProviderFactory>()

registry.set('openai-compatible', (config) => new OpenAICompatibleProvider(config))

export function createProvider(config: AIConfig): LLMProvider {
  const factory = registry.get(config.provider)
  if (!factory) {
    const known = [...registry.keys()].join(', ')
    throw new Error(`未知的 Provider "${config.provider}"，可选值：${known}`)
  }
  return factory(config)
}

export function registerProvider(kind: string, factory: ProviderFactory): void {
  registry.set(kind, factory)
}

export type { ChatRequest, LLMProvider, ProviderFactory } from './provider'
