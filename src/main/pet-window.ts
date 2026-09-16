/**
 * 桌宠窗口：透明、无边框、置顶，以及拖动与点击穿透两套鼠标行为。
 *
 * 拖动为什么不用 CSS 的 -webkit-app-region: drag？
 * 因为它会吞掉元素的鼠标事件，后续想加「点击形象触发动作/对话」就没法做了。
 * 这里改成：渲染层只负责报告 pointerdown/pointerup，主进程用定时器轮询鼠标位置来移动窗口，
 * 窗口移动过程中依然能拿到 mouseup，点击与拖拽也能区分（位移超过阈值才算拖拽）。
 */
import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { loadConfig } from './config'
import { APP_ENTRY_URL } from './protocol'
import type { PetConfig } from '@shared/config'

const DRAG_POLL_MS = 16
/** 位移超过这个像素数才算拖拽，否则视作点击 */
const DRAG_THRESHOLD_PX = 3

let petWindow: BrowserWindow | null = null
let dragTimer: NodeJS.Timeout | null = null
let dragAnchor: { cursorX: number; cursorY: number; winX: number; winY: number } | null = null
let dragMoved = false
/** 用户配置：是否启用点击穿透 */
let clickThroughEnabled = true
/** 当前鼠标是否停在形象上 */
let interactive = true

export function createPetWindow(config: PetConfig): BrowserWindow {
  const win = new BrowserWindow({
    width: config.window.width,
    height: config.window.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: config.window.alwaysOnTop,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  petWindow = win
  clickThroughEnabled = config.window.clickThrough
  interactive = !clickThroughEnabled

  applyAlwaysOnTop(config.window.alwaysOnTop)
  // 让桌宠跟随用户切换到任何 Space（含全屏应用之上）
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  applyClickThrough()

  // ready-to-show 是主要时机，did-finish-load 作为兜底，避免极端情况下窗口一直不显示
  const reveal = (): void => {
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  }
  win.once('ready-to-show', reveal)
  win.webContents.once('did-finish-load', reveal)

  win.on('closed', () => {
    stopDrag()
    petWindow = null
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    // 走自定义协议而非 file://：file:// 下 Chromium 不允许 fetch 本地模型文件
    void win.loadURL(APP_ENTRY_URL)
  }

  return win
}

export function getPetWindow(): BrowserWindow | null {
  return petWindow !== null && !petWindow.isDestroyed() ? petWindow : null
}

export function toggleVisible(): void {
  const win = getPetWindow()
  // 窗口没了（比如用默认菜单的 Cmd+W 关掉）就重新建一个，
  // 否则托盘菜单会变成一个点了没反应的死按钮，应用只剩托盘图标。
  if (!win) {
    createPetWindow(loadConfig())
    return
  }
  if (win.isVisible()) win.hide()
  else win.show()
}

export function isAlwaysOnTop(): boolean {
  return getPetWindow()?.isAlwaysOnTop() ?? false
}

export function applyAlwaysOnTop(enabled: boolean): void {
  const win = getPetWindow()
  if (!win) return
  // 'floating' 足以浮在普通窗口之上，又不会盖住系统级弹窗
  win.setAlwaysOnTop(enabled, enabled ? 'floating' : 'normal')
}

export function isClickThrough(): boolean {
  return clickThroughEnabled
}

export function setClickThrough(enabled: boolean): void {
  clickThroughEnabled = enabled
  if (!enabled) interactive = true
  applyClickThrough()
}

/** 把「鼠标是否在形象上」同步给窗口：不在形象上就整窗穿透，桌面才点得动 */
export function setInteractive(next: boolean): void {
  if (interactive === next) return
  interactive = next
  applyClickThrough()
}

function applyClickThrough(): void {
  const win = getPetWindow()
  if (!win) return
  if (!clickThroughEnabled) {
    win.setIgnoreMouseEvents(false)
    return
  }
  // forward: true 让窗口在穿透状态下仍能收到 mousemove，否则鼠标移回形象上就无法重新接管
  win.setIgnoreMouseEvents(!interactive, { forward: true })
}

export function startDrag(): void {
  const win = getPetWindow()
  if (!win) return
  stopDrag()

  const cursor = screen.getCursorScreenPoint()
  const [winX, winY] = win.getPosition()
  dragAnchor = { cursorX: cursor.x, cursorY: cursor.y, winX, winY }
  dragMoved = false

  dragTimer = setInterval(() => {
    const target = getPetWindow()
    if (!dragAnchor || !target) {
      stopDrag()
      return
    }
    const point = screen.getCursorScreenPoint()
    const dx = point.x - dragAnchor.cursorX
    const dy = point.y - dragAnchor.cursorY
    if (!dragMoved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    dragMoved = true
    target.setPosition(Math.round(dragAnchor.winX + dx), Math.round(dragAnchor.winY + dy))
  }, DRAG_POLL_MS)
}

export function endDrag(): { moved: boolean } {
  const moved = dragMoved
  stopDrag()
  return { moved }
}

function stopDrag(): void {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
  }
  dragAnchor = null
}
