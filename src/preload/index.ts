/**
 * preload：唯一允许同时接触 Node 与页面的地方。
 * 这里只暴露一组收窄过的、语义明确的 API，不把 ipcRenderer 整个丢给页面。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { ChatMessage, ChatOptions, ChatResponse } from '@shared/ai'
import type { RendererConfig } from '@shared/config'
import { IPC, type DragResult, type PetApi } from '@shared/ipc'

const api: PetApi = {
  getConfig: () => ipcRenderer.invoke(IPC.getConfig) as Promise<RendererConfig>,
  dragStart: () => ipcRenderer.send(IPC.dragStart),
  dragEnd: () => ipcRenderer.invoke(IPC.dragEnd) as Promise<DragResult>,
  setInteractive: (interactive: boolean) => ipcRenderer.send(IPC.setInteractive, interactive),
  requestReloadModel: () => ipcRenderer.send(IPC.requestReloadModel),
  chat: (messages: ChatMessage[], options?: ChatOptions) =>
    ipcRenderer.invoke(IPC.chat, messages, options) as Promise<ChatResponse>,
  onConfigChanged: (listener) => subscribe(IPC.configChanged, listener),
  onModelReloaded: (listener) => subscribe(IPC.modelReloaded, () => listener()),
  quit: () => ipcRenderer.send(IPC.quit)
}

/** 统一的订阅辅助：返回取消订阅函数，避免渲染层重复挂监听导致泄漏 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

contextBridge.exposeInMainWorld('pet', api)
