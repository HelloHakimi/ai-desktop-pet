/** 托盘菜单：桌宠的常规入口都收在这里（桌宠本身没有标题栏和菜单栏） */
import { Menu, Tray, app, nativeImage, shell } from 'electron'
import { join } from 'node:path'
import { reloadPet } from './actions'
import { configPath } from './config'
import {
  applyAlwaysOnTop,
  isAlwaysOnTop,
  isClickThrough,
  setClickThrough,
  toggleVisible
} from './pet-window'

let tray: Tray | null = null

export function createTray(): Tray {
  const icon = loadTrayIcon()
  const instance = new Tray(icon)
  tray = instance

  instance.setToolTip('AI 桌宠')
  rebuildMenu()

  return instance
}

function rebuildMenu(): void {
  if (!tray) return

  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: () => toggleVisible() },
    { type: 'separator' },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: isAlwaysOnTop(),
      click: (item) => {
        applyAlwaysOnTop(item.checked)
        rebuildMenu()
      }
    },
    {
      label: '点击穿透（不在形象上时鼠标可穿透）',
      type: 'checkbox',
      checked: isClickThrough(),
      click: (item) => {
        setClickThrough(item.checked)
        rebuildMenu()
      }
    },
    { type: 'separator' },
    { label: '重新加载形象', click: () => reloadPet() },
    {
      label: '打开配置文件…',
      click: () => {
        const path = configPath()
        void shell.openPath(path).then((error) => {
          if (error) console.error(`[tray] 打开配置文件失败：${error}`)
        })
      }
    },
    { type: 'separator' },
    ...loginItemEntries(),
    { label: '退出', click: () => app.quit() }
  ])

  tray.setContextMenu(menu)
}

/**
 * 「登录时自动启动」只在打包后出现。
 * 开发模式下注册的是 node_modules 里的 Electron 可执行文件，用户根本不会想要这个开机项，
 * 更糟的是它会真的被写进系统的登录项里。
 */
function loginItemEntries(): Electron.MenuItemConstructorOptions[] {
  if (!app.isPackaged) return []
  return [
    {
      label: '登录时自动启动',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked })
        // 这里刻意不 rebuildMenu()：勾选状态由菜单自己维护，
        // 而 getLoginItemSettings() 在刚写完时未必马上反映新值，重建反而可能画出错的勾。
      }
    },
    { type: 'separator' }
  ]
}

/**
 * 托盘图标放在 resources/ 下（不参与打包构建，out/main 往上两级即项目根目录）。
 * macOS 上使用 Template 后缀的图片，可自动适配深色/浅色菜单栏。
 */
function loadTrayIcon(): Electron.NativeImage {
  const path = join(__dirname, '../../resources/trayTemplate.png')
  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) {
    console.warn(`[tray] 托盘图标加载失败（${path}），托盘将显示为空白图标`)
    return image
  }
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}
