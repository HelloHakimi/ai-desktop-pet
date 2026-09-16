/** 渲染器工厂：决定用 Live2D 还是占位形象，并保证「配置错/资源缺」时一定有东西显示 */
import { PlaceholderRenderer } from './PlaceholderRenderer'
import { tryCreateLive2DRenderer } from './Live2DRenderer'
import type { PetRenderer, RendererConfig } from './types'

export async function createRenderer(
  host: HTMLElement,
  config: RendererConfig
): Promise<PetRenderer> {
  if (config.model.mode === 'placeholder') {
    return new PlaceholderRenderer(host, '当前为占位形象（配置里 model.mode = "placeholder"）')
  }

  const attempt = await tryCreateLive2DRenderer(host, config)
  if (attempt.ok) return attempt.renderer

  const message = attempt.detail ? `${attempt.reason}：${attempt.detail}` : attempt.reason

  if (config.model.mode === 'live2d') {
    // 用户明确要求 Live2D，就不该悄悄降级，把原因显示在窗口上
    console.error('[pet] Live2D 初始化失败：', message)
    return new PlaceholderRenderer(host, `Live2D 未能启用 —— ${message}`)
  }

  console.info(`[pet] 已降级为占位形象：${message}`)
  return new PlaceholderRenderer(host, `占位形象 · ${message}`)
}
