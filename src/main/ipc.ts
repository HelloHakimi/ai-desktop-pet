/** IPC 处理：渲染层的请求在这里落地。所有来自渲染层的输入都当作不可信数据校验。 */
import { app, ipcMain } from 'electron'
import { sanitizeMessages, withSystemPrompt, type ChatOptions } from '@shared/ai'
import { toRendererConfig } from '@shared/config'
import { IPC, type DragResult } from '@shared/ipc'
import { createProvider } from './ai'
import { loadConfig } from './config'
import { endDrag, setInteractive, startDrag } from './pet-window'

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.getConfig, () => toRendererConfig(loadConfig()))

  ipcMain.on(IPC.dragStart, () => startDrag())
  ipcMain.handle(IPC.dragEnd, (): DragResult => endDrag())

  ipcMain.on(IPC.setInteractive, (_event, value: unknown) => {
    if (typeof value === 'boolean') setInteractive(value)
  })

  ipcMain.on(IPC.quit, () => app.quit())

  ipcMain.handle(IPC.chat, async (_event, messages: unknown, options: unknown) => {
    const sanitized = sanitizeMessages(messages)
    if (!sanitized) {
      return { ok: false, error: '参数不合法：messages 必须是非空的 { role, content } 数组' }
    }
    try {
      const config = loadConfig()
      return await createProvider(config.ai).chat({
        messages: withSystemPrompt(sanitized, config.ai.systemPrompt),
        options: normalizeOptions(options)
      })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

/** 与配置文件走同一套上下限，避免渲染层塞进负数 / NaN / 离谱的值 */
const OPTION_RANGES = {
  temperature: { min: 0, max: 2 },
  maxTokens: { min: 1, max: 200_000 },
  timeoutMs: { min: 1000, max: 600_000 }
} as const

function normalizeOptions(input: unknown): ChatOptions | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const raw = input as Record<string, unknown>
  const options: ChatOptions = {}
  for (const [key, range] of Object.entries(OPTION_RANGES)) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      options[key as keyof ChatOptions] = Math.min(Math.max(value, range.min), range.max)
    }
  }
  return options
}
