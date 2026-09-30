/**
 * 「选中即处理」：把刚复制的那段文字交给模型干一件具体的事，结果由桌宠说出来。
 *
 * 入口是全局快捷键和托盘菜单，都在主进程，不经过渲染层。
 *
 * 三个刻意的选择：
 * 1. **复用对话会话**（走 session.send 而不是自己调 provider）：白拿流式上屏、停止、
 *    错误说人话；而且结果同时进对话窗口 —— 气泡只显示 60 字，看不全时双击气泡就有全文。
 * 2. **整轮不落盘**（ephemeral）：喂进去的是剪贴板内容，可能是密码或 token。
 *    过滤由会话层统一负责（见 chat/store.ts 的 saveHistory），这里只负责打标记。
 * 3. **当场直读剪贴板**，不读轮询缓存：轮询是秒级的，「复制完立刻按快捷键」完全可能
 *    落在两次轮询之间，读缓存就会拿到上一次的内容（见 clipboard-watch.ts 的说明）。
 */
import { petSay } from '../actions'
import { send } from '../chat/session'
import { readClipboardText } from '../clipboard-watch'
import { classify, TASKS } from './tasks'

/**
 * 愿意处理的文本上限，比聊天的输入上限（4000）小得多。
 *
 * 4000 字的段落塞进上下文又慢又贵，而用户按这个键时等的是「按一下就有结果」。
 * 超了就直说，而不是发一个注定超时、或者被悄悄截断的请求。
 */
const MAX_ASSIST_CHARS = 3000

const MODIFIER_GLYPHS: Record<string, string> = {
  alt: '⌥',
  option: '⌥',
  command: '⌘',
  cmd: '⌘',
  control: '⌃',
  ctrl: '⌃',
  shift: '⇧',
  super: '⌘'
}

const KEY_GLYPHS: Record<string, string> = {
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  return: '↩',
  enter: '↩',
  space: '空格',
  esc: 'esc',
  escape: 'esc',
  tab: '⇥'
}

/**
 * 把 Electron 的 accelerator 写法（`Alt+Command+Up`）转成菜单里好看的样子（`⌥⌘↑`）。
 *
 * 快捷键是配置项、可以由用户改，所以提示文案不能写死 —— 写死的那天就会开始说谎。
 * 认不出来的键原样保留，宁可显示得生硬一点，也不要显示错的。
 */
export function prettyAccelerator(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const key = part.toLowerCase()
      return MODIFIER_GLYPHS[key] ?? KEY_GLYPHS[key] ?? part
    })
    .join('')
}

/** 全局快捷键与托盘「处理剪贴板」的共同入口 */
export function runAssist(): void {
  const text = readClipboardText()
  if (text.length === 0) {
    petSay('剪贴板里没有文字，先复制一段再叫我', 'error')
    return
  }

  const length = Array.from(text).length
  if (length > MAX_ASSIST_CHARS) {
    petSay(`这段太长了（${length} 字），先复制短一点的段落吧`, 'error')
    return
  }

  const task = TASKS[classify(text)]
  // bypassPlay：喂进去的是「选中的那段文字」，不是用户在跟它说话 ——
  // 复制到一句「石头」再按快捷键，不该被正在进行的猜拳接走
  const result = send(task.build(text), {
    systemOverride: task.system,
    ephemeral: true,
    bypassPlay: true
  })
  if (!result.ok) {
    // 上一轮还在生成：得说清楚为什么没反应，否则用户只会以为快捷键坏了
    petSay(result.error, 'error')
    return
  }
  console.log(`[assist] ${task.label}：${length} 字`)
}
