/** IPC 处理：渲染层的请求在这里落地。所有来自渲染层的输入都当作不可信数据校验。 */
import { ipcMain, BrowserWindow } from 'electron'
import { sanitizeUserText } from '@shared/ai'
import { toRendererConfig } from '@shared/config'
import { IPC, type AskDismissReason, type DragResult } from '@shared/ipc'
import { answerAsk, dismissAsk } from './ask'
import { abort, clear, getSnapshot, send, setSessionListener } from './chat/session'
import { showChatWindow } from './chat/window'
import { loadConfig, updateWindowSettings } from './config'
import { noteActivity } from './idle'
import { endDrag, getPetWindow, hidePetWindow, setInteractive, startDrag } from './pet-window'
import { setRuntimeState } from './runtime-state'

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.getConfig, () => toRendererConfig(loadConfig()))

  ipcMain.on(IPC.dragStart, () => startDrag())
  ipcMain.handle(IPC.dragEnd, (): DragResult => {
    const result = endDrag()
    // 拖动结束后把落点写回配置，下次启动就摆在这儿。
    // 窗口位置只有这里知道（拖动是主进程按光标挪的），也只需要在真的挪过之后记。
    if (result.moved) {
      const win = getPetWindow()
      if (win) {
        const [x, y] = win.getPosition()
        updateWindowSettings({ x, y })
      }
    }
    return result
  })

  ipcMain.on(IPC.setInteractive, (_event, value: unknown) => {
    if (typeof value === 'boolean') setInteractive(value)
  })

  // 渲染层上报的状态是「不可信数据」里的特例：它只用于画勾与避让，不参与任何决策链
  // （表情归属、时长都在渲染层），所以这里校验形状后直接收下。
  ipcMain.on(IPC.runtimeState, (_event, value: unknown) => {
    if (typeof value !== 'object' || value === null) return
    const raw = value as Record<string, unknown>
    const expressions = Array.isArray(raw.expressions)
      ? raw.expressions.filter((name): name is string => typeof name === 'string')
      : null
    if (expressions === null || typeof raw.game !== 'boolean') return
    setRuntimeState({ expressions, game: raw.game })
  })

  ipcMain.on(IPC.activity, () => noteActivity())

  // 提问按钮的两条回执。和别的渲染层输入一样先验形状：值不对就整个丢掉，
  // ask.ts 那边还会再核对 id（过期的点击没有意义）。
  ipcMain.on(IPC.askAnswer, (_event, value: unknown) => {
    if (typeof value !== 'object' || value === null) return
    const { id, index } = value as Record<string, unknown>
    if (typeof id !== 'number' || typeof index !== 'number') return
    answerAsk(id, index)
  })

  ipcMain.on(IPC.askDismiss, (_event, value: unknown) => {
    if (typeof value !== 'object' || value === null) return
    const { id, reason } = value as Record<string, unknown>
    if (typeof id !== 'number' || !isDismissReason(reason)) return
    dismissAsk(id, reason)
  })

  // 形象上的双指轻点 / 右键：收起桌宠。留一行日志，因为它消失之后「是被收起来了还是崩了」
  // 只能从这里看 —— 窗口藏起来时没有别的地方会响
  ipcMain.on(IPC.hidePet, () => {
    hidePetWindow()
    console.log('[pet] 已收起（双指轻点 / 右键）')
  })

  // 会话事件的出口：所有窗口都收 —— 对话窗口渲染消息流，形象窗口更新气泡。
  // 两者身份不同但都只是「消费方」，谁在听、听几个，会话层不需要知道。
  setSessionListener({
    onDelta: (event) => broadcast(IPC.chatDelta, event),
    onDone: (event) => broadcast(IPC.chatDone, event),
    onError: (event) => broadcast(IPC.chatError, event),
    onCleared: () => broadcast(IPC.chatCleared, null)
  })

  ipcMain.handle(IPC.chatSend, (_event, text: unknown) => {
    const clean = sanitizeUserText(text)
    if (clean === null) return { ok: false, error: '消息不能为空' }
    return send(clean)
  })

  ipcMain.on(IPC.chatAbort, () => abort())

  // 形象窗口的气泡被双击（内容被截断，用户想看全文）：把对话窗口带到前面
  ipcMain.on(IPC.chatOpen, () => showChatWindow())

  ipcMain.handle(IPC.chatHistory, () => getSnapshot())

  ipcMain.handle(IPC.chatClear, () => {
    clear()
  })
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function isDismissReason(value: unknown): value is AskDismissReason {
  return value === 'timeout' || value === 'replaced' || value === 'hidden'
}
