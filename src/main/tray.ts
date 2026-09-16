/** 托盘菜单：桌宠的常规入口都收在这里（桌宠本身没有标题栏和菜单栏） */
import { Menu, Tray, app, nativeImage, shell } from 'electron'
import { join } from 'node:path'
import { reloadPet } from './actions'
import { configPath, loadConfig, updateModelSelection } from './config'
import { listModels, modelsRoot, type PetModel } from './models'
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

  // 模型没出现在菜单里时，这两行能直接区分「目录扫错了」和「清单没写对」
  const models = listModels()
  console.log(`[tray] 模型目录：${modelsRoot()}`)
  console.log(
    `[tray] 可用形象 ${models.length} 个：${models.map((m) => m.name).join('、') || '（无）'}`
  )

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
    { label: '切换形象', submenu: modelEntries() },
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
 * 「切换形象」子菜单。
 *
 * 每次都重新扫目录：用户往模型文件夹里丢一个新模型后，不用重启就能在菜单里看到。
 * 模型数量是个位数，这点磁盘开销可以忽略。
 */
function modelEntries(): Electron.MenuItemConstructorOptions[] {
  const models = listModels()
  const current = loadConfig().model.path

  if (models.length === 0) {
    return [
      { label: '（模型文件夹里没有可用的模型）', enabled: false },
      { type: 'separator' },
      { label: '打开模型文件夹…', click: () => openModelsFolder() }
    ]
  }

  const entries: Electron.MenuItemConstructorOptions[] = models.map((model) => ({
    label: model.name,
    type: 'radio',
    checked: model.path === current,
    click: () => selectModel(model)
  }))

  // 配置指向了一个不在列表里的路径时，把现状显示出来，
  // 否则用户会看到一组全都没勾选的单选项而不知道当前到底在用哪个。
  if (!models.some((model) => model.path === current)) {
    entries.push(
      { type: 'separator' },
      { label: `当前：${current}（文件缺失）`, enabled: false }
    )
  }

  entries.push(
    { type: 'separator' },
    { label: '打开模型文件夹…', click: () => openModelsFolder() }
  )
  return entries
}

function selectModel(model: PetModel): void {
  if (loadConfig().model.path === model.path) return

  updateModelSelection({ path: model.path, idleMotionGroup: model.idleMotionGroup })
  reloadPet()
  // 重建菜单让勾选状态立刻跟上（reloadPet 不会碰菜单）
  rebuildMenu()
  console.log(`[tray] 已切换到形象：${model.name}`)
}

function openModelsFolder(): void {
  void shell.openPath(modelsRoot()).then((error) => {
    if (error) console.error(`[tray] 打开模型文件夹失败：${error}`)
  })
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
