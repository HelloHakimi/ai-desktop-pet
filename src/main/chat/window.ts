/**
 * 对话窗口。
 *
 * 与形象窗口刻意不同：这是一个**常规窗口** —— 有交通灯、可缩放、可被系统正常聚焦，
 * 因为它要承载输入框和可滚动的消息列表，不是桌面上的装饰。
 *
 * 位置不记忆：每次打开都贴着形象重新算。用户永远知道开窗之后窗口会出现在哪，
 * 而「上次拖到屏幕角落」的状态在没有多会话的场景里只会让人困惑。
 */
import { BrowserWindow, app, screen } from 'electron'
import { join } from 'node:path'
import { loadConfig } from '../config'
import { getPetWindow } from '../pet-window'
import { APP_CHAT_URL } from '../protocol'

const CHAT_WIDTH = 380
const CHAT_HEIGHT = 580
/** 与形象窗口之间的间隙，让两个窗口看起来是「一伙的」 */
const GAP_PX = 12

let chatWindow: BrowserWindow | null = null

export function getChatWindow(): BrowserWindow | null {
  return chatWindow !== null && !chatWindow.isDestroyed() ? chatWindow : null
}

/** 托盘「聊聊天」的开关：开着就关，关着就开（形象窗口的双击入口已于 2026-09-20 去掉） */
export function toggleChatWindow(): void {
  const existing = getChatWindow()
  if (existing) {
    existing.close()
    return
  }
  openChatWindow()
}

/**
 * 把对话窗口带到用户面前：没开就开，开着就聚焦。
 *
 * 和 toggleChatWindow() 的分工在「已经开着」的时候：那个是开关（再点一下就关），
 * 这个是「我要看它」。双击气泡时窗口可能正开在别的窗口后面，
 * 此时关掉再开显然不是用户想要的。取 steal 是因为应用隐藏了 Dock 图标，
 * 不抢的话系统不会把窗口带到前台。
 */
export function showChatWindow(): void {
  const existing = getChatWindow()
  if (existing) {
    if (!existing.isVisible()) existing.show()
    app.focus({ steal: true })
    existing.focus()
    return
  }
  openChatWindow()
}

export function openChatWindow(): void {
  if (getChatWindow()) return

  const config = loadConfig()
  const pet = getPetWindow()

  const win = new BrowserWindow({
    width: CHAT_WIDTH,
    height: CHAT_HEIGHT,
    minWidth: 300,
    minHeight: 360,
    title: '对话',
    titleBarStyle: 'hiddenInset',
    // 与渲染层的暗色底一致：开窗瞬间不会闪一下白
    backgroundColor: '#0f1522',
    show: false,
    resizable: true,
    fullscreenable: false,
    skipTaskbar: true,
    // 跟着桌宠「当前」的置顶状态（托盘可以随时改），而不是配置里的初始值
    alwaysOnTop: pet?.isAlwaysOnTop() ?? config.window.alwaysOnTop,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  chatWindow = win
  win.on('closed', () => {
    chatWindow = null
  })

  positionBesidePet(win, pet)

  win.once('ready-to-show', () => {
    win.show()
    // 应用隐藏了 Dock 图标，系统默认不会把它激活到前台，键盘焦点会留在原来那个应用上。
    // 用户点「聊聊天」就是为了打字，这一下必须把焦点抢过来。
    app.focus({ steal: true })
    win.focus()
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    void win.loadURL(`${devServerUrl.replace(/\/+$/, '')}/chat.html`)
  } else {
    void win.loadURL(APP_CHAT_URL)
  }
}

/**
 * 贴着形象窗口放：优先左侧，左边放不下改右侧。
 * 竖直方向底边对齐 —— 形象在屏幕底部时，聊天窗自然向上展开。
 */
function positionBesidePet(win: BrowserWindow, pet: BrowserWindow | null): void {
  if (!pet) {
    win.center()
    return
  }

  const petBounds = pet.getBounds()
  const { workArea } = screen.getDisplayMatching(petBounds)
  const [width, height] = win.getSize()

  let x = petBounds.x - width - GAP_PX
  if (x < workArea.x) x = petBounds.x + petBounds.width + GAP_PX

  win.setPosition(
    Math.round(clamp(x, workArea.x, workArea.x + workArea.width - width)),
    Math.round(
      clamp(petBounds.y + petBounds.height - height, workArea.y, workArea.y + workArea.height - height)
    )
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
