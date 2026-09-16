/** 托盘菜单与渲染层共用的「动作」层，避免两边各写一份逻辑 */
import { toRendererConfig } from '@shared/config'
import { IPC, type ExpressionCommand } from '@shared/ipc'
import { configPath, loadConfig } from './config'
import { getPetWindow } from './pet-window'

/**
 * 重新从磁盘读取配置，并把新配置推给渲染层后重建形象。
 *
 * 只发 configChanged 一条：渲染层拿到新配置就会重建形象，再补一条 modelReloaded
 * 会让它重建两次，两次异步挂载互相覆盖，前一个渲染器的 canvas 与 Pixi ticker 会泄漏。
 * （configChanged 本身就代表「配置变了，重来一遍」，modelReloaded 留给将来「只有模型文件变了」的场景。）
 *
 * 注意：窗口尺寸的改动不会即时生效，需要重启应用（改尺寸涉及透明窗重建，后续再处理）。
 */
export function reloadPet(): void {
  const config = loadConfig({ force: true })
  const win = getPetWindow()
  if (!win) return
  win.webContents.send(IPC.configChanged, toRendererConfig(config))
  console.log(`[pet] 已重新加载配置：${configPath()}`)
}

/**
 * 让当前形象换个表情。
 *
 * 只转发、不在主进程记状态：表情是渲染层的事，主进程这边没有模型，也没法知道
 * 某个名字到底存不存在 —— 校验留给能真正查表的那一层，失败原因也才说得清。
 */
export function applyExpression(command: ExpressionCommand): void {
  const win = getPetWindow()
  if (!win) return
  win.webContents.send(IPC.expression, command)
}
