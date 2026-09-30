/**
 * 把桌宠「此刻的样子」拼成一句话，交给模型当上下文。
 *
 * 为什么值得告诉模型：桌宠的表情是**分层常驻**的 —— 生气会一直挂在脸上直到回落，
 * 墨镜和奶茶是用户自己给它套上的。模型不知道这些，就会在它瞪着一脸怒气的时候
 * 若无其事地回一句「你好呀」，两边的割裂感很明显。
 *
 * 状态来自三处，前两处是主进程自己就知道的，只有表情层是渲染层报上来的：
 * - 打盹：idle.ts 的 sleepingFace（要在 noteActivity **之前**读，见下面接口的说明）
 * - 专注：focus.ts
 * - 敲琴与表情层：runtime-state.ts 的缓存（渲染层每 400ms 上报一次）
 *
 * 刻意不写进去的东西：
 * - 敲琴的键位层与点击图案（A S D W 1、左键、右键）—— 那是按下即出现、松手就淡出的
 *   即时反馈，不是「它现在是什么样子」；「正在敲琴」这件事由 game 那个标志单独说。
 * - 剩余时间、当前时刻这类一直在变的东西 —— 提示词一变，上游的上下文缓存就整段作废。
 */
import { PIANO_KEYS } from '@shared/piano'
import { getFocusState } from './focus'
import { getRuntimeState } from './runtime-state'

/**
 * 不该当成「样子」的表情层。
 *
 * 键位层从 PIANO_KEYS 取 —— 那份表本来就是主进程与渲染层共用的唯一真相，
 * 手写一份迟早会和实际听键的代码分家。左右键图案是鼠标点击的对应物，
 * 手敲琴本身则由「正在敲琴」表达。
 */
const TRANSIENT_LAYERS = new Set([
  ...PIANO_KEYS.map((key) => key.name),
  '左键',
  '右键',
  '手敲琴'
])

/** 一次对话开始时的状态。两个「刚刚」只有调用方知道，所以要传进来 */
export interface PetStateInput {
  /** 刚才在打盹吗 —— 必须在 noteActivity() 之前问，那一句就会把它叫醒 */
  justWokeUp: boolean
  /** 这条消息刚触发出来的情绪（本地关键词判的，比渲染层上报早一步） */
  mood?: string
}

/** 拼成一句给模型看的状态描述；没什么可说的就返回 null（别往提示词里塞空话） */
export function describePetState(input: PetStateInput): string | null {
  const { expressions, game } = getRuntimeState()
  const layers = expressions.filter((name) => !TRANSIENT_LAYERS.has(name))

  // 刚触发的情绪渲染层还来不及上报（那边是 400ms 轮询 + 一次异步回报），
  // 但主进程手里已经有答案了 —— 补上，让「你刚骂了它」这一轮它就知道自己该生气
  if (input.mood && !layers.includes(input.mood)) layers.push(input.mood)

  const parts: string[] = []
  if (layers.length > 0) parts.push(`挂着的表情/配件：${layers.join('、')}`)
  if (game) parts.push('正在陪用户敲琴')
  if (getFocusState()) parts.push('正陪着用户做一件要专注的事')
  if (input.justWokeUp) parts.push('刚才在打盹，被这一句叫醒了')

  if (parts.length === 0) return null

  return (
    `【你现在的状态】${parts.join('；')}。\n` +
    '回应用户时可以自然地把这个状态带进去（比如正生着气就别装作没事），' +
    '但不必每次都提，也不用向用户解释这些是什么。'
  )
}
