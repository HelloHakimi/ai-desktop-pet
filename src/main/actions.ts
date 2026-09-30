/** 托盘菜单与渲染层共用的「动作」层，避免两边各写一份逻辑 */
import { toRendererConfig } from '@shared/config'
import { IPC, type ExpressionCommand, type SayEvent } from '@shared/ipc'
import { configPath, loadConfig } from './config'
import { getPetWindow } from './pet-window'

/**
 * 重新从磁盘读取配置，并把新配置推给渲染层后重建形象。
 *
 * 只发 `configChanged` 一条：渲染层拿到新配置就会重建形象。这里刻意**不**再补一条
 * 「模型变了」的通知 —— 那会让渲染层把形象重建两次，两次异步挂载互相覆盖，
 * 先完成的那个渲染器的 canvas 与 Pixi ticker 会泄漏（这个坑踩过一次，见 README 修复记录）。
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

/**
 * 开/关敲琴模式（入口只在托盘）。
 *
 * 开始时要**把形象窗口聚焦起来**：键盘事件只会送到有焦点的窗口，而桌宠平时是
 * 点击穿透、不抢焦点的。这是这个功能唯一一处「抢」用户键盘的地方，所以它必须由用户在
 * 托盘里明确发起 —— 顺带也让「怎么退出」有个一眼能看见的答案。
 */
export function applyGame(active: boolean): void {
  const win = getPetWindow()
  if (!win) return
  win.webContents.send(IPC.game, { active })
  if (active) {
    if (!win.isVisible()) win.show()
    win.focus()
  }
}

/** 上一句话说出去的时刻；0 = 还没说过 */
let lastSaidAt = 0

/**
 * 距上一句话过了多久（毫秒）。**从没说过时返回 Infinity**，调用方直接比大小即可，
 * 不用再判一次「到底说没说过」。
 *
 * 给的是跨模块的护栏：久坐提醒、深夜问候、专注到点、系统事件都会说话，
 * 其中任意两条撞在一起（深夜问候完下一秒又「拔了电源」）就像复读机。
 * 谁需要安静一下就自己来问这个值，见 system-events.ts。
 */
export function msSinceLastSay(): number {
  return lastSaidAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - lastSaidAt
}

/**
 * 记一笔「它刚开了口」。
 *
 * petSay 自己会调它；本地陪玩的回复走的是对话事件（那两个窗口都要画），
 * 不经过 petSay，得自己来记一次 —— 碎碎念的冷却看的是「上一次开口是什么时候」，
 * 而不是「上一次开口走了哪条通道」。
 */
export function noteSaid(): void {
  lastSaidAt = Date.now()
}

/**
 * 让桌宠说一句现成的话（不走大模型）。
 *
 * 番茄钟到点、久坐提醒、「剪贴板里没有文字」都走这里。
 * 刻意不塞进对话流：这些话不该进上下文，也不该在对话窗口的历史里留下痕迹 ——
 * 它们只是桌宠在说话，不是一轮对话。
 */
export function petSay(text: string, tone: SayEvent['tone'] = 'normal'): void {
  const win = getPetWindow()
  if (!win) return
  // 没有窗口时上面就返回了：那句没真的说出去，不该算进「刚说过话」
  noteSaid()
  win.webContents.send(IPC.say, { text, tone })
}
