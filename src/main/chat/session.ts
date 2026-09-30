/**
 * 会话：整个应用只有一份对话状态，住在主进程。
 *
 * 为什么不让渲染层持有历史？
 * 1. 人设（systemPrompt）注入本来就在主进程，历史放在同一侧不需要来回搬运；
 * 2. 流式与持久化都需要一个稳定归属：形象渲染层会随「重载形象」重建，对话窗口会关了再开，
 *    而对话必须接着进行；
 * 3. API Key 与磁盘都只该主进程碰 —— 渲染层能做的只是「发一句话」和「听增量」。
 */
import type {
  ChatDeltaEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatHistorySnapshot,
  ChatMessage,
  ChatResponse,
  ChatSendResult
} from '@shared/ai'
import { explainChatError, withSystemPrompt } from '@shared/ai'
import type { PetConfig } from '@shared/config'
import { applyExpression, noteSaid } from '../actions'
import { createProvider } from '../ai'
import { loadConfig } from '../config'
import { isSleeping, noteActivity } from '../idle'
import { appendRemembered, matchRememberCommand, memoryForPrompt } from '../memory'
import { showPetWindow } from '../pet-window'
import { describePetState } from '../pet-state'
import { afterLocalReply, resetPlay, setLocalTurnSink, tryLocalReply } from '../play'
import { detectEmotion } from './emotion'
import { loadHistory, saveHistory } from './store'

/** send() 的可选项 */
export interface SendOptions {
  /**
   * 用一段一次性的 systemPrompt 顶替配置里的桌宠人设。
   *
   * 「选中即处理」用它：翻译要的是准确，不是可爱 —— 让「你是一只小宠物」去翻译，
   * 出来的是带卖萌语气的译文，粘进文档里还得手动擦。萌的部分由表情承担。
   */
  systemOverride?: string
  /** 临时轮次：只存内存、不落盘（见 store.ts 的 saveHistory） */
  ephemeral?: boolean
  /**
   * 跳过本地陪玩：这不是「用户在跟它说话」，而是「拿选中的这段文字让它干活」。
   * 复制到一句「石头」再按快捷键，不该被正在进行的猜拳接走。
   */
  bypassPlay?: boolean
}

/**
 * 一轮生成需要的全部上下文。
 * `SendOptions` 是调用方给的（任务提示词、是不是临时轮次），`petState` 由 send() 现场算出来 ——
 * 它依赖两个「刚刚」（刚才在不在打盹、这条消息触发了什么情绪），只有那一瞬间问得到。
 */
type TurnContext = SendOptions & {
  /** 给模型看的桌宠状态描述；null = 没什么可说的，那就别往提示词里塞空话 */
  petState: string | null
}

/** 事件出口：由 IPC 层注入，负责把增量广播给所有窗口 */
export interface SessionListener {
  onDelta(event: ChatDeltaEvent): void
  onDone(event: ChatDoneEvent): void
  onError(event: ChatErrorEvent): void
  /** 对话被清空（对话窗口或托盘都走 clear()，两边都要收尾，所以统一从这里出去） */
  onCleared(): void
}

let messages: ChatMessage[] = []
let listener: SessionListener | null = null
/** 正在生成的那一轮的取消控制器；null = 空闲 */
let activeAbort: AbortController | null = null
/** 正在生成的那一轮到目前为止的文本（getSnapshot 用） */
let currentPartial = ''
/**
 * 轮次代号：send() 和 clear() 都会让它 +1。
 * 带着过期代号回来的异步结果一律丢弃 —— 否则「清空时正好有一轮在生成」的话，
 * 上一轮那半句话会自己冒回刚清空的历史里。
 */
let turn = 0

/** 启动时调用一次：把存盘的历史接上，并把「本地回合的出口」交给陪玩（按钮点的回合也走这里） */
export function initSession(): void {
  messages = loadHistory()
  setLocalTurnSink(replyLocally)
}

export function setSessionListener(next: SessionListener): void {
  listener = next
}

/** 给对话窗口的完整历史（副本，外部改不到会话内部） */
function getHistory(): ChatMessage[] {
  return messages.map((message) => ({ ...message }))
}

/**
 * 对话窗口打开时拉取的快照：历史 + 正在生成的那一轮。
 * 关窗不中断生成，所以重开窗口可能正赶上流式中间态，要能接着画。
 */
export function getSnapshot(): ChatHistorySnapshot {
  return {
    messages: getHistory(),
    streaming: activeAbort ? { text: currentPartial } : null
  }
}

/**
 * 接受一轮用户输入并立即返回 —— 生成过程通过事件推进，调用方（IPC）不等它。
 * 文本的合法性由 IPC 层校验（sanitizeUserText），这里拿到的是干净文本。
 */
export function send(text: string, options: SendOptions = {}): ChatSendResult {
  if (activeAbort) {
    return { ok: false, error: '上一条还在生成中，等它说完或点「停止」' }
  }

  // 「记住：…」先落盘、再照常交给模型：落盘是本地动作（零 token、即时生效），
  // 而回执要的是它自己那句话 —— 拍板选的就是让模型自然回，不是本地念一句固定台词。
  // 顺带跳过本地陪玩：「记住：我不喜欢猜数字」里的「猜数字」不该真开一局。
  const remembered = options.systemOverride === undefined ? matchRememberCommand(text) : null
  const effective: SendOptions =
    remembered === null ? options : { ...options, bypassPlay: true }
  if (remembered !== null) appendRemembered(remembered)

  // 本地陪玩优先：点单、猜数字这些自己就能接的，不惊动大模型 —— 快、不花钱、断网也能玩
  if (effective.bypassPlay !== true) {
    const reply = tryLocalReply(text)
    if (reply !== null) return replyLocally(text, reply)
  }

  const config = loadConfig()
  // 开聊就把藏起来的桌宠叫回来（只在这一刻，助手台词不叫 —— 见 showPetWindow）。
  // 放在「上一条还在生成」那道闸门之后：被拒的那次不算一次开聊。
  showPetWindow()
  // 用户消息先进历史：即使这一轮失败/被停止，它也留在语境里（重试不必重打一遍）
  remember({ role: 'user', content: text }, effective.ephemeral === true)

  // 先变脸再开口：本地关键词判一下这句话该让它什么表情（判不出来就不动脸）
  const emotion = detectEmotion(text)
  if (emotion) {
    applyExpression({ kind: 'named', name: emotion.name, holdMs: emotion.holdMs })
  }
  // 顺序要紧：noteActivity() 会把打盹脸摘掉，摘掉之后再问就问不出「刚才在打盹」了
  const justWokeUp = isSleeping()
  noteActivity()
  // 它此刻的样子要告诉模型：正挂着一脸怒气的时候，不该若无其事地回「你好呀」
  const petState = describePetState({ justWokeUp, mood: emotion?.name })

  const controller = new AbortController()
  activeAbort = controller
  const myTurn = ++turn
  void runTurn(config, controller, myTurn, { ...effective, petState })
  return { ok: true }
}

/** 记一条消息进内存历史；临时轮次打上标记，落盘时会被 store 过滤掉 */
function remember(message: ChatMessage, ephemeral: boolean): void {
  messages.push(ephemeral ? { ...message, ephemeral: true } : message)
}

/**
 * 本地轮次：它的回复不是大模型写的，而是本地陪玩接住的（点单、猜数字…）。
 *
 * 两句都打上 local 标记 —— 界面上照常显示，但不落盘、也不进上下文（见 ai.ts 的说明）。
 * 回复走的是同一套对话事件：气泡与对话窗口都会画，不必为它单开一条通道。
 * noteSaid() 要自己记一次：碎碎念的冷却看的是「它上一次开口是什么时候」，
 * 而不是「上一次开口走了哪条通道」。
 */
function replyLocally(text: string, reply: string): ChatSendResult {
  messages.push({ role: 'user', content: text, local: true })
  messages.push({ role: 'assistant', content: reply, local: true })
  // 和走模型的那一轮同样对待：把藏起来的桌宠叫回来，并且算「有人在场」
  showPetWindow()
  noteActivity()
  noteSaid()
  listener?.onDone({ content: reply, model: 'local' })
  // 说完再问陪玩要不要补按钮（猜拳的下一步）：按钮要挂在刚说完的那句下面，
  // 所以必须等 onDone 发出去之后 —— 反过来先挂按钮、再落字，按钮会被当成挂在旧内容上撤掉
  afterLocalReply()
  return { ok: true }
}

/** 用户点「停止」；没有在生成时是空操作 */
export function abort(): void {
  activeAbort?.abort()
}

/** 清空对话。先取消在生成的那一轮，否则它会把半句话写回刚清空的历史 */
export function clear(): void {
  turn += 1
  activeAbort?.abort()
  activeAbort = null
  currentPartial = ''
  messages = []
  saveHistory(messages)
  // 陪玩也一起复位：进行中的那一局结束、猜表情挂着的脸摘掉（它属于「这段对话」）
  resetPlay()
  listener?.onCleared()
  // 记忆清零，灵魂出窍 —— 这个动作值得一张脸
  applyExpression({ kind: 'named', name: '吐魂', holdMs: 2500 })
  noteActivity()
}

async function runTurn(
  config: PetConfig,
  controller: AbortController,
  myTurn: number,
  // 名字刻意不叫 turn：模块级的轮次计数器就叫 turn，同名会把那个数字遮住，
  // 于是 `myTurn !== turn` 变成拿数字比对象、永远成立 —— 每一轮回复都会被当成过期丢掉
  ctx: TurnContext
): Promise<void> {
  /** 本轮是不是临时轮次（喂过剪贴板内容的那种）：助手回复要跟着打同样的标记 */
  const ephemeral = ctx.ephemeral === true
  /** 从增量里累计出的部分回复：被停止时要靠它保住「已经说出来的那半句」 */
  let partial = ''
  let response: ChatResponse | null = null
  let thrown: string | null = null

  try {
    const provider = createProvider(config.ai)
    // 本地轮次（陪玩、点单）先剔掉再发：ephemeral 只是不落盘，模型照样看得见
    //（「选中即处理」的语境要接得上）；local 是模型看不见的 ——
    // 让它读到「user: 石头」，下一轮它只会莫名其妙地接着猜拳。
    // 先剔再截：不然刚玩过几局，真正的上文就被挤出窗口了。
    const history = trimContext(
      messages.filter((message) => message.local !== true),
      config.ai.contextLimit
    ).map(({ role, content }) => ({
      role,
      content
    }))
    // 人设后面接一句它此刻的样子，再跟上长期记忆；带 systemOverride 的任务轮次（选中即处理）不接：
    // 那些要的是干净的指令，不是角色状态，也不该把主人的私事塞进一次翻译里
    const system = ctx.systemOverride ?? withMemory(appendPetState(config.ai.systemPrompt, ctx.petState))
    response = await provider.chat(
      {
        messages: withSystemPrompt(history, system)
      },
      {
        onDelta: (text) => {
          partial = text
          currentPartial = text
          // 代号的另一处守卫：清空之后紧接着到的增量不该再画到界面上
          if (myTurn === turn) listener?.onDelta({ text })
        },
        signal: controller.signal
      }
    )
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error)
  }

  // 这一轮已被 clear() 作废：不落盘、不通知，也不能碰 activeAbort（那个位置已经换人/清空了）
  if (myTurn !== turn) return
  activeAbort = null
  currentPartial = ''

  if (controller.signal.aborted) {
    if (partial.length > 0) remember({ role: 'assistant', content: partial }, ephemeral)
    saveHistory(messages)
    // 被中途打断：一脸「咦？」比面无表情诚实
    applyExpression({ kind: 'named', name: '问号', holdMs: 2000 })
    listener?.onDone({ content: partial, model: config.ai.model, stopped: true })
    return
  }

  if (thrown !== null) {
    // 失败也落盘：用户那条消息要留下，修好配置后能顺着这个语境接着聊
    saveHistory(messages)
    applyExpression({ kind: 'named', name: '流汗', holdMs: 2500 })
    listener?.onError({ error: explainChatError(thrown) })
    return
  }

  if (!response) {
    // 理论不可达（chat 要么返回要么抛），兜底成一条错误事件而不是静默失败
    listener?.onError({ error: '内部错误：Provider 没有返回结果' })
    return
  }

  if (!response.ok) {
    saveHistory(messages)
    // HTTP 层的失败（401、500…）和网络层抛出来的失败走的是两条路，脸得是同一张；
    // 文案也一样：状态码翻译成人话，厂商原文附在后面
    applyExpression({ kind: 'named', name: '流汗', holdMs: 2500 })
    listener?.onError({
      error: explainChatError(response.error, response.status),
      status: response.status
    })
    return
  }

  // 空回复（模型偶尔会吐一个空串）不入历史：一条空的 assistant 消息留在上下文里，
  // 下一轮发给模型只会添乱；界面上那一轮本来也不会留下空气泡
  if (response.content.length > 0) {
    remember({ role: 'assistant', content: response.content }, ephemeral)
  }
  saveHistory(messages)
  listener?.onDone({
    content: response.content,
    model: response.model,
    usage: response.usage
  })
}

/** 把人设和桌宠此刻的状态接起来；没有状态可写时原样返回人设 */
function appendPetState(persona: string, petState: string | null): string {
  return petState === null ? persona : `${persona}\n\n${petState}`
}

/** 再接上长期记忆（没有记忆时原样返回）。每轮现读文件，刚「记住」的事这一轮就在了 */
function withMemory(persona: string): string {
  const memory = memoryForPrompt()
  return memory === null ? persona : `${persona}\n\n${memory}`
}

/** 只把最近 limit 条发给模型（systemPrompt 由 withSystemPrompt 注入在最前） */
function trimContext(all: ChatMessage[], limit: number): ChatMessage[] {
  return all.length <= limit ? all : all.slice(-limit)
}
