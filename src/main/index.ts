/** 应用入口：单实例、创建桌宠窗口、托盘、注册 IPC */
import { BrowserWindow, app, globalShortcut } from 'electron'
import { join } from 'node:path'
import { runAssist } from './assist'
import { initSession } from './chat/session'
import { startClipboardWatch } from './clipboard-watch'
import { startCompanion } from './companion'
import { loadConfig, repairModelSelection } from './config'
import { startDaily } from './daily'
import { startIdleWatch } from './idle'
import { registerIpcHandlers } from './ipc'
import { startMemory } from './memory'
import { createPetWindow, getPetWindow } from './pet-window'
import { registerAppScheme, serveRenderer } from './protocol'
import { startSmalltalk } from './smalltalk'
import { startSystemEvents } from './system-events'
import { toggleBubble } from './chat/bubble'
import { createTray } from './tray'

// 必须早于 app ready：自定义 scheme 的特权只能在这一刻登记
registerAppScheme()

// 桌宠只应存在一只：第二个实例直接把已有窗口唤到前面来
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getPetWindow()
    if (win) {
      if (!win.isVisible()) win.show()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    // 先修配置再读：配置可能指着一个已经被删掉的模型目录（见 repairModelSelection）
    repairModelSelection()
    const config = loadConfig()

    // 接上存盘的对话历史；放这里是因为 configPath() 依赖 app 就绪（userData 目录）
    initSession()

    // 把 out/renderer 挂到 app://bundle/，渲染层与 Live2D 模型资源都从这里加载
    serveRenderer(join(__dirname, '../renderer'))

    // 桌宠常驻托盘即可，Dock 图标会挤占用户的任务栏
    if (process.platform === 'darwin' && config.window.hideDockIcon) {
      app.dock?.hide()
    }

    createPetWindow(config)
    createTray()
    registerIpcHandlers()
    // 闲置时钟：很久没人碰就自己打盹（见 idle.ts）
    startIdleWatch()
    // 剪贴板观察者：「选中即处理」与「剪贴板历史」共用（见 clipboard-watch.ts）
    startClipboardWatch()
    // 主动说话：久坐提醒与深夜问候（见 companion.ts）
    startCompanion()
    // 系统事件：拔插电源、断网时说一句（见 system-events.ts）
    startSystemEvents()
    // 碎碎念与梦话（见 smalltalk.ts）、打招呼 / 饭点 / 节日 / 纪念日（见 daily.ts）
    startSmalltalk()
    startDaily()
    // 长期记忆：每晚 23:30 之后把还没整理的对话写成日记（见 memory.ts）
    startMemory()

    // ⌥⌘+← 全局快捷键：随时召唤/收起气泡输入框。
    // 这是气泡输入框唯一的入口，注册不上得说出来 —— 否则用户只会觉得「这个功能不存在」。
    const shortcutOk = globalShortcut.register('Alt+Command+Left', toggleBubble)
    if (!shortcutOk) {
      console.warn('[pet] 全局快捷键 ⌥⌘+← 注册失败（多半被别的应用占用了），气泡输入框将无法唤出')
    }

    // 「处理剪贴板」的全局快捷键。做成配置项，留空表示不用这个功能；
    // 同样地，注册失败必须说出来 —— 否则用户按半天没反应，只会以为桌宠坏了。
    if (config.assist.shortcut.length > 0) {
      const assistOk = globalShortcut.register(config.assist.shortcut, runAssist)
      if (!assistOk) {
        console.warn(
          `[pet] 全局快捷键 ${config.assist.shortcut} 注册失败（多半被别的应用占用了），` +
            '「处理剪贴板」只能用托盘菜单'
        )
      }
    }

    console.log('[pet] 启动完成，右键托盘图标可打开菜单')

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createPetWindow(loadConfig())
    })
  })

  // macOS 上关掉窗口不退出（托盘还在），其他平台直接退出
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
