/**
 * 对话窗口的渲染层。
 *
 * 这是唯一一个「常规」界面：消息列表 + 输入框，交互全部收敛在这里。
 * 会话状态不在这里 —— 本文件只做两件事：把本地操作翻译成 IPC（发一句话 / 停止 / 清空），
 * 以及把主进程推来的增量画出来。
 */
import './style.css'
import { MAX_USER_TEXT_LENGTH, type ChatMessage } from '@shared/ai'

/** 草稿存在 localStorage 里：关窗（连进程级销毁）也不丢，重开还在 */
const DRAFT_KEY = 'pet-chat-draft'

function requireRoot(): HTMLElement {
  const element = document.getElementById('chat-root')
  if (!element) throw new Error('页面缺少 #chat-root 容器')
  return element
}

const root = requireRoot()

// ---------- DOM 装配 ----------

const topbar = document.createElement('header')
topbar.className = 'topbar'

const title = document.createElement('span')
title.className = 'topbar__title'
title.textContent = '对话'

const clearButton = document.createElement('button')
clearButton.className = 'topbar__clear'
clearButton.type = 'button'
clearButton.textContent = '清空'

topbar.append(title, clearButton)

const list = document.createElement('main')
list.className = 'messages'

const composer = document.createElement('footer')
composer.className = 'composer'

const input = document.createElement('textarea')
input.className = 'composer__input'
input.placeholder = '说点什么…'
input.rows = 1
input.maxLength = MAX_USER_TEXT_LENGTH
input.setAttribute('aria-label', '输入消息')

const sendButton = document.createElement('button')
sendButton.className = 'composer__send'
sendButton.type = 'button'
sendButton.textContent = '发送'

composer.append(input, sendButton)
root.append(topbar, list, composer)

// ---------- 状态 ----------

/** 正在生成：发送按钮显示「停止」，Enter 不再发送 */
let generating = false
/** 正在流式绘制的那条回复；null = 没有在画的 */
let live: { item: HTMLElement; textEl: HTMLElement } | null = null
/** 中文输入法组合中（回车是在选字，不是在发送） */
let composing = false

// ---------- 消息渲染 ----------

function createMessageEl(role: 'user' | 'assistant'): { item: HTMLElement; textEl: HTMLElement } {
  const item = document.createElement('div')
  item.className = `msg msg--${role === 'user' ? 'user' : 'pet'}`

  const bubble = document.createElement('div')
  bubble.className = 'msg__bubble'

  const textEl = document.createElement('div')
  textEl.className = 'msg__text'

  bubble.append(textEl)
  item.append(bubble)
  return { item, textEl }
}

function appendMessage(message: ChatMessage): HTMLElement {
  const { item, textEl } = createMessageEl(message.role === 'user' ? 'user' : 'assistant')
  textEl.textContent = message.content
  list.append(item)
  return item
}

/** 占用气泡：还没贴过文字时显示一个脉动的小点（正在思考） */
function beginLive(text: string): void {
  const { item, textEl } = createMessageEl('assistant')
  item.classList.add('msg--live', text.length > 0 ? 'msg--has-text' : 'msg--pending')
  textEl.textContent = text
  list.append(item)
  live = { item, textEl }
  scrollToBottom(true)
}

function updateLive(text: string): void {
  if (!live) {
    // 兜底：正常路径上 beginLive 先建好了气泡（快照 / 发送时），这里只防「重开窗口恰好赶上增量」
    beginLive(text)
    return
  }
  live.item.classList.remove('msg--pending')
  live.item.classList.add('msg--has-text')
  live.textEl.textContent = text
  scrollToBottom()
}

function finishLive(content: string, stopped?: boolean): void {
  if (!live) {
    // 一个气泡都没建过（极快的一轮）：直接把结果补成正式消息
    if (content.length > 0) appendMessage({ role: 'assistant', content })
    return
  }
  const { item, textEl } = live
  live = null
  item.classList.remove('msg--live', 'msg--pending', 'msg--has-text')

  if (content.length === 0) {
    // 一个字都没说出来（刚开始就被停止 / 模型返回空）：不留一个空气泡
    item.remove()
    return
  }
  textEl.textContent = content
  if (stopped) {
    const note = document.createElement('span')
    note.className = 'msg__note'
    note.textContent = '已停止'
    item.querySelector('.msg__bubble')?.append(note)
  }
}

function showNotice(text: string): void {
  const el = document.createElement('div')
  el.className = 'notice'
  el.textContent = text
  list.append(el)
  scrollToBottom(true)
}

// ---------- 滚动 ----------

/** 贴底跟随：用户往上翻着看时不抢滚动位置 */
let stickToBottom = true

list.addEventListener('scroll', () => {
  stickToBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40
})

function scrollToBottom(force = false): void {
  if (force || stickToBottom) list.scrollTop = list.scrollHeight
}

// ---------- 输入区 ----------

function autoSize(): void {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`
}

function updateComposer(): void {
  sendButton.textContent = generating ? '停止' : '发送'
  sendButton.classList.toggle('composer__send--stop', generating)
  sendButton.disabled = !generating && input.value.trim().length === 0
}

function saveDraft(): void {
  try {
    localStorage.setItem(DRAFT_KEY, input.value)
  } catch {
    /* 存储不可用时静默放弃：草稿保不住不影响聊天 */
  }
}

function restoreDraft(): void {
  try {
    const draft = localStorage.getItem(DRAFT_KEY)
    if (draft) input.value = draft
  } catch {
    /* 同上 */
  }
}

async function submit(): Promise<void> {
  const text = input.value.trim()
  if (text.length === 0 || generating) return

  // 乐观上屏：先画自己的话再等主进程确认 —— 被拒只可能是并发（本地已经挡住了），
  // 真被拒了再把气泡收回来
  input.value = ''
  autoSize()
  saveDraft()
  updateComposer()
  const userItem = appendMessage({ role: 'user', content: text })
  scrollToBottom(true)

  generating = true
  updateComposer()

  const result = await window.pet.sendChat(text)
  if (!result.ok) {
    generating = false
    updateComposer()
    userItem.remove()
    input.value = text
    autoSize()
    saveDraft()
    showNotice(result.error)
    return
  }

  // 增量有可能先于 invoke 的返回值到达：那时 updateLive 已经建好气泡了。
  // 反过来的情况也要挡住：**done 先到**（本地陪玩的回复是同步生成的，就是这么快），
  // 那时 generating 已经放回 false —— 再建一个「正在思考」的气泡，它会永远停在那儿等一个不会来的结果。
  if (!live && generating) beginLive('')
}

// ---------- 事件接线 ----------

input.addEventListener('input', () => {
  autoSize()
  updateComposer()
  saveDraft()
})

input.addEventListener('compositionstart', () => {
  composing = true
})

input.addEventListener('compositionend', () => {
  composing = false
})

input.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !event.isComposing) {
    // ESC 只关窗，不中断生成 —— 生成中的回复会以气泡的形式出现在形象那边
    event.preventDefault()
    window.close()
    return
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    if (event.isComposing || composing) return // 组合期的回车是在选字
    event.preventDefault()
    if (!generating) void submit()
  }
})

sendButton.addEventListener('click', () => {
  if (generating) {
    window.pet.abortChat() // 等 done(stopped) 回来收尾，不在这里改状态
    return
  }
  void submit()
})

// ---------- 清空（两次点击确认，4 秒后自动解除） ----------

let clearArmed = false
let clearTimer: number | null = null

function disarmClear(): void {
  clearArmed = false
  if (clearTimer !== null) {
    clearTimeout(clearTimer)
    clearTimer = null
  }
  clearButton.textContent = '清空'
  clearButton.classList.remove('topbar__clear--armed')
}

clearButton.addEventListener('click', () => {
  if (!clearArmed) {
    clearArmed = true
    clearButton.textContent = '确认清空'
    clearButton.classList.add('topbar__clear--armed')
    clearTimer = window.setTimeout(disarmClear, 4000)
    return
  }
  disarmClear()
  // 界面的收尾交给 onChatCleared：清空也可能来自托盘，两条路走同一段代码
  void window.pet.clearChat()
})

// ---------- 启动 ----------

async function boot(): Promise<void> {
  if (!window.pet) {
    document.body.textContent = '未检测到 preload 注入的 API，请通过 npm run dev 启动 Electron'
    return
  }

  // 先挂监听、再取快照：快照之后发生的事件一个都不会漏。
  // 反过来的顺序会有一个空窗 —— 恰好在这中间结束的那一轮，既不在快照里，也没人通知。
  window.pet.onChatDelta((event) => {
    if (generating) updateLive(event.text)
  })
  window.pet.onChatDone((event) => {
    if (!generating) return
    generating = false
    updateComposer()
    finishLive(event.content, event.stopped)
  })
  window.pet.onChatError((event) => {
    if (!generating) return
    generating = false
    updateComposer()
    live?.item.remove()
    live = null
    showNotice(event.error)
  })
  // 清空可能从托盘发起（那时这个窗口正开着），所以收尾统一挂在这条广播上
  window.pet.onChatCleared(() => {
    generating = false
    live = null
    updateComposer()
    list.replaceChildren()
    input.focus()
  })

  const snapshot = await window.pet.getChatSnapshot()
  for (const message of snapshot.messages) appendMessage(message)

  // 关窗不中断生成：重开时可能正赶上流式的中间态，接着画
  if (snapshot.streaming) {
    generating = true
    beginLive(snapshot.streaming.text)
  }

  restoreDraft()
  autoSize()
  updateComposer()
  scrollToBottom(true)

  input.focus()
  console.info('[chat] 对话窗口已就绪')
}

// 窗口被系统重新激活时（点回窗口）把焦点还给输入框，省一次点击
window.addEventListener('focus', () => input.focus())

void boot()
