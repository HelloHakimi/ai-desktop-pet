/**
 * preload：唯一允许同时接触 Node 与页面的地方。
 * 这里只暴露一组收窄过的、语义明确的 API，不把 ipcRenderer 整个丢给页面。
 *
 * 形象窗口与对话窗口共用这一份 preload：两边拿到的 API 是同一套，
 * 各自按需使用（形象窗口消费 onChatDelta 画气泡，对话窗口消费全部）。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  ChatDeltaEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatHistorySnapshot,
  ChatSendResult
} from '@shared/ai'
import type { RendererConfig } from '@shared/config'
import {
  IPC,
  type AskAnswer,
  type AskDismiss,
  type AskEvent,
  type DragResult,
  type ExpressionCommand,
  type GameCommand,
  type PetApi,
  type PetRuntimeState,
  type SayEvent
} from '@shared/ipc'

const api: PetApi = {
  getConfig: () => ipcRenderer.invoke(IPC.getConfig) as Promise<RendererConfig>,
  dragStart: () => ipcRenderer.send(IPC.dragStart),
  dragEnd: () => ipcRenderer.invoke(IPC.dragEnd) as Promise<DragResult>,
  onDragMoved: (listener) => subscribe(IPC.dragMoved, listener),
  setInteractive: (interactive: boolean) => ipcRenderer.send(IPC.setInteractive, interactive),
  onConfigChanged: (listener) => subscribe(IPC.configChanged, listener),
  onExpression: (listener) => subscribe<ExpressionCommand>(IPC.expression, listener),
  onGame: (listener) => subscribe<GameCommand>(IPC.game, listener),
  reportRuntimeState: (state: PetRuntimeState) => ipcRenderer.send(IPC.runtimeState, state),
  reportActivity: () => ipcRenderer.send(IPC.activity),
  onSay: (listener) => subscribe<SayEvent>(IPC.say, listener),
  onAsk: (listener) => subscribe<AskEvent>(IPC.ask, listener),
  answerAsk: (answer: AskAnswer) => ipcRenderer.send(IPC.askAnswer, answer),
  dismissAsk: (dismiss: AskDismiss) => ipcRenderer.send(IPC.askDismiss, dismiss),
  hidePet: () => ipcRenderer.send(IPC.hidePet),
  sendChat: (text: string) => ipcRenderer.invoke(IPC.chatSend, text) as Promise<ChatSendResult>,
  abortChat: () => ipcRenderer.send(IPC.chatAbort),
  getChatSnapshot: () => ipcRenderer.invoke(IPC.chatHistory) as Promise<ChatHistorySnapshot>,
  clearChat: () => ipcRenderer.invoke(IPC.chatClear) as Promise<void>,
  openChat: () => ipcRenderer.send(IPC.chatOpen),
  onChatCleared: (listener) => subscribe(IPC.chatCleared, listener),
  onChatDelta: (listener) => subscribe<ChatDeltaEvent>(IPC.chatDelta, listener),
  onChatDone: (listener) => subscribe<ChatDoneEvent>(IPC.chatDone, listener),
  onChatError: (listener) => subscribe<ChatErrorEvent>(IPC.chatError, listener)
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
