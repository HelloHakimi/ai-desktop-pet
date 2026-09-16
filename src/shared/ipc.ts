/**
 * 主进程 ↔ 渲染进程的 IPC 契约。
 * 通道名集中在此，避免两边写字面量字符串写错。
 */
import type { ChatMessage, ChatOptions, ChatResponse } from './ai'
import type { RendererConfig } from './config'

export const IPC = {
  /** 渲染层拉取窗口/形象配置 */
  getConfig: 'pet:get-config',
  /** 主进程广播：配置已变更 */
  configChanged: 'pet:config-changed',
  /** 开始拖动窗口（主进程轮询鼠标位置，比 -webkit-app-region 更可控） */
  dragStart: 'pet:drag-start',
  /** 结束拖动，返回是否真的发生了位移（用于区分“点击”和“拖拽”） */
  dragEnd: 'pet:drag-end',
  /** 告知主进程当前鼠标是否落在形象上，用于切换点击穿透 */
  setInteractive: 'pet:set-interactive',
  /** 渲染层请求重新加载形象 */
  requestReloadModel: 'pet:request-reload-model',
  /**
   * 主进程通知渲染层重新加载形象。
   * 目前「重新加载形象」走的是 configChanged（配置变了顺带重建形象），
   * 这条留给将来「只有模型资源变了」的场景（例如模型文件被替换时自动重载）。
   */
  modelReloaded: 'pet:model-reloaded',
  /** 一次性对话（流式留待后续里程碑） */
  chat: 'ai:chat',
  /** 退出应用 */
  quit: 'pet:quit'
} as const

export interface DragResult {
  /** 位移超过阈值才为 true */
  moved: boolean
}

/** 挂在 window.pet 上的 API，preload 实现、渲染层消费 */
export interface PetApi {
  getConfig(): Promise<RendererConfig>
  dragStart(): void
  dragEnd(): Promise<DragResult>
  setInteractive(interactive: boolean): void
  requestReloadModel(): void
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>
  onConfigChanged(listener: (config: RendererConfig) => void): () => void
  onModelReloaded(listener: () => void): () => void
  quit(): void
}
