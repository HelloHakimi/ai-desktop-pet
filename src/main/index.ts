/** 应用入口：单实例、创建桌宠窗口、托盘、注册 IPC */
import { BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import { loadConfig } from './config'
import { registerIpcHandlers } from './ipc'
import { createPetWindow, getPetWindow } from './pet-window'
import { registerAppScheme, serveRenderer } from './protocol'
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
    const config = loadConfig()

    // 把 out/renderer 挂到 app://bundle/，渲染层与 Live2D 模型资源都从这里加载
    serveRenderer(join(__dirname, '../renderer'))

    // 桌宠常驻托盘即可，Dock 图标会挤占用户的任务栏
    if (process.platform === 'darwin' && config.window.hideDockIcon) {
      app.dock?.hide()
    }

    createPetWindow(config)
    createTray()
    registerIpcHandlers()

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
