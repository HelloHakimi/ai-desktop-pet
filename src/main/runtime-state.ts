/**
 * 运行时状态的缓存：渲染层报告「现在挂着哪些表情、敲琴开着没」，这里存一份给主进程消费 ——
 * 托盘菜单据此画勾（勾必须是真的，见 tray.ts 的说明），闲置时钟据此决定要不要打盹。
 *
 * 为什么状态在渲染层、主进程只做缓存：表情分层、限时回落、按键图案顶替都发生在渲染层，
 * 主进程本来就不可能算出「现在挂着什么」。与其两边各维护一套状态再互相对账，
 * 不如让唯一知道真相的那一侧直接报上来。
 */
import type { PetRuntimeState } from '@shared/ipc'

let state: PetRuntimeState = { expressions: [], game: false }
const listeners: Array<(state: PetRuntimeState) => void> = []

export function getRuntimeState(): PetRuntimeState {
  return state
}

/** 只在真的有变化时通知：渲染层是轮询上报的，值没变不该让托盘重建菜单 */
export function setRuntimeState(next: PetRuntimeState): void {
  if (sameState(state, next)) return
  state = next
  for (const listener of listeners) listener(state)
}

export function onRuntimeStateChange(listener: (state: PetRuntimeState) => void): void {
  listeners.push(listener)
}

/**
 * 比集合而不是比数组：上报里表情的先后顺序没有语义（同一组层换个插入顺序还是同一组），
 * 按顺序比会让托盘时不时白重建一次菜单。
 */
function sameState(a: PetRuntimeState, b: PetRuntimeState): boolean {
  if (a.game !== b.game || a.expressions.length !== b.expressions.length) return false
  const left = [...a.expressions].sort()
  const right = [...b.expressions].sort()
  return left.every((name, index) => name === right[index])
}
