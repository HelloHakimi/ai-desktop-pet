/**
 * 气泡输入框：Spotlight 风格的悬浮窗口。
 *
 * 与对话窗口不同 —— 气泡只是一个纯输入框，回复仍走对话窗口（在宠物上方）。
 * 定位在 Dock 上方居中，失焦或 Esc 关闭，Enter 发送后保持打开。
 */
import { BrowserWindow, app, screen } from 'electron'
import { join } from 'node:path'
import { APP_BUBBLE_URL } from '../protocol'

let bubbleWindow: BrowserWindow | null = null

export function getBubbleWindow(): BrowserWindow | null {
  return bubbleWindow !== null && !bubbleWindow.isDestroyed() ? bubbleWindow : null
}

/** 打开/关闭气泡：有就关，没有就开 */
export function toggleBubble(): void {
  const existing = getBubbleWindow()
  if (existing) {
    existing.close()
    return
  }
  openBubble()
}

export function openBubble(): void {
  if (getBubbleWindow()) return
  console.log('[bubble] 正在创建气泡窗口...')

  const win = new BrowserWindow({
    width: 560,
    height: 56,
    // 无边框、完全透明，只靠 CSS 画气泡
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  bubbleWindow = win
  win.on('closed', () => {
    bubbleWindow = null
  })

  // 失焦即关
  win.on('blur', () => {
    win.close()
  })

  positionAboveDock(win)

  win.once('ready-to-show', () => {
    win.show()
    app.focus({ steal: true })
    win.focus()
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    void win.loadURL(`${devServerUrl.replace(/\/+$/, '')}/bubble.html`).catch((err) => {
      console.error('[bubble] 加载 dev URL 失败:', err)
    })
  } else {
    void win.loadURL(APP_BUBBLE_URL).catch((err) => {
      console.error('[bubble] 加载 app URL 失败:', err)
    })
  }
}

/**
 * 定位在 Dock 上方居中。
 * macOS 的 Dock 默认在屏幕底部，气泡水平居中、紧贴 Dock 上沿。
 */
function positionAboveDock(win: BrowserWindow): void {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { workArea, bounds } = primaryDisplay
  const [width, height] = win.getSize()

  // 水平居中
  const x = Math.round(bounds.x + (bounds.width - width) / 2)

  // Dock 高度估算：workArea 和 bounds 的差值就是 Dock 占的空间
  const dockHeight = bounds.height - workArea.height
  // 气泡放在 Dock 上沿再往上一点（8px 间隙）
  const y = Math.round(bounds.y + bounds.height - dockHeight - height - 8)

  win.setPosition(x, y)
}
