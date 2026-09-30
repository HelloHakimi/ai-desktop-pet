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
import { IPC } from '@shared/ipc'

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
  restorePosition(win, config.window.x, config.window.y)

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

/** 窗口至少要有这么大一块落在某块屏上，记下来的位置才算还能用 */
const MIN_VISIBLE_PX = 48

/**
 * 把窗口摆回上次拖动结束时的位置。
 *
 * 必须先验证：记下的坐标可能落在**已经拔掉的显示器**上，那样整窗都在屏幕外，
 * 用户既看不见也拖不回来，只能去删配置文件。位置无效时什么都不做，交给系统摆。
 */
function restorePosition(win: BrowserWindow, x: number | null, y: number | null): void {
  if (x === null || y === null) return

  const [width, height] = win.getSize()
  const visible = screen.getAllDisplays().some(({ workArea }) => {
    const overlapX = Math.min(x + width, workArea.x + workArea.width) - Math.max(x, workArea.x)
    const overlapY = Math.min(y + height, workArea.y + workArea.height) - Math.max(y, workArea.y)
    return overlapX >= MIN_VISIBLE_PX && overlapY >= MIN_VISIBLE_PX
  })
  if (!visible) {
    console.warn(`[pet] 配置里的窗口位置（${x}, ${y}）已经不在任何屏幕上了，本次交给系统摆放`)
    return
  }

  win.setPosition(x, y)
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

/**
 * 收起桌宠（形象上的双指轻点 / 右键走这条路）。
 *
 * 只做「藏起来」，不做别的：恢复入口是托盘里那同一项「显示 / 隐藏」，
 * 所以这里不需要把状态记在哪儿 —— 窗口自己的可见性就是状态。
 */
export function hidePetWindow(): void {
  getPetWindow()?.hide()
}

/**
 * 把藏起来的桌宠叫回来。
 *
 * 恢复入口本来是托盘那一项，但**开始聊天时必须自己出现**：回复是冒在它头顶的气泡上的，
 * 藏着一只桌宠说给谁听？调用点只有聊天的入口（见 chat/session.ts），
 * 助手台词（久坐、专注到点、系统事件）刻意不叫它回来 —— 藏起来就是在说「别打扰我」。
 *
 * 用 `showInactive` 而不是 `show`：用户这一刻多半正在气泡输入框里打字，
 * 而那个窗口失焦即关 —— 抢焦点等于把人家正在用的输入框挤掉。
 */
export function showPetWindow(): void {
  const win = getPetWindow()
  if (win && !win.isVisible()) win.showInactive()
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
    if (!dragMoved) {
      // 位移还没过阈值：这可能是「点击时手抖了一下」，先不动
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      dragMoved = true
      // 拖动真的开始了，通知渲染层 —— 「晕晕」要在拖动过程中就挂上，而不是等松手。
      // 这一刻只有这里知道：渲染层看不见真实光标，判定权在主进程的轮询里。
      target.webContents.send(IPC.dragMoved)
    }
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
