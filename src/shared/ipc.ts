/**
 * 主进程 ↔ 渲染进程的 IPC 契约。
 * 通道名集中在此，避免两边写字面量字符串写错。
 */
import type {
  ChatDeltaEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatHistorySnapshot,
  ChatSendResult
} from './ai'
import type { RendererConfig } from './config'

export const IPC = {
  /** 渲染层拉取窗口/形象配置 */
  getConfig: 'pet:get-config',
  /** 主进程广播：配置已变更 */
  configChanged: 'pet:config-changed',
  /** 开始拖动窗口（主进程轮询鼠标位置，比 -webkit-app-region 更可控） */
  dragStart: 'pet:drag-start',
  /** 结束拖动，返回是否真的发生了位移（用于区分“点击”和“拖拽”） */
  dragEnd: 'pet:drag-end',
  /** 主进程 → 渲染层：位移过了阈值，拖动真的开始了（渲染层从这一刻起挂「晕晕」） */
  dragMoved: 'pet:drag-moved',
  /** 告知主进程当前鼠标是否落在形象上，用于切换点击穿透 */
  setInteractive: 'pet:set-interactive',
  /** 主进程通知渲染层换表情 / 清表情（托盘与聊天触发） */
  expression: 'pet:expression',
  /** 主进程通知渲染层开/关敲琴模式（入口只在托盘） */
  game: 'pet:game',
  /** 渲染层 → 主进程：当前生效的表情与敲琴状态（托盘据此打勾，闲置时钟据此判断） */
  runtimeState: 'pet:runtime-state',
  /** 渲染层 → 主进程：用户碰了形象，重置闲置时钟 */
  activity: 'pet:activity',
  /** 主进程 → 渲染层：让桌宠说一句现成的话（不走大模型） */
  say: 'pet:say',
  /** 主进程 → 渲染层：给气泡附上一排选项按钮（见 main/ask.ts） */
  ask: 'pet:ask',
  /** 渲染层 → 主进程：用户点了某个选项 */
  askAnswer: 'pet:ask-answer',
  /** 渲染层 → 主进程：按钮下线了（到点收掉 / 被新内容顶掉 / 气泡整个收起） */
  askDismiss: 'pet:ask-dismiss',
  /** 渲染层 → 主进程：收起桌宠（形象上的双指轻点 / 右键）。恢复入口在托盘 */
  hidePet: 'pet:hide',
  /** 发送一轮用户输入；返回是否被接受，回复走下面的推送通道 */
  chatSend: 'chat:send',
  /** 中断正在生成的回复 */
  chatAbort: 'chat:abort',
  /** 拉取完整对话历史（对话窗口启动时用） */
  chatHistory: 'chat:history',
  /** 清空对话历史 */
  chatClear: 'chat:clear',
  /**
   * 渲染层 → 主进程：把对话窗口带到前面来。
   * 目前只有形象窗口的气泡双击会发 —— 气泡内容被截断了，用户想看全文
   */
  chatOpen: 'chat:open',
  /** 主进程 → 渲染层：对话已被清空。清空可能来自对话窗口，也可能来自托盘，两边都靠这条事件收尾 */
  chatCleared: 'chat:cleared',
  /** 主进程 → 渲染层：流式增量（对话窗口与形象窗口都收，后者用来更新气泡） */
  chatDelta: 'chat:delta',
  /** 主进程 → 渲染层：本轮回复完成 */
  chatDone: 'chat:done',
  /** 主进程 → 渲染层：本轮回复失败 */
  chatError: 'chat:error'
} as const

/**
 * 表情指令。
 *
 * 用可辨识联合，而不是「传空字符串表示还原」这类约定 ——
 * 表情名字本身就可能含空格和奇怪字符（当前形象里就有「真 左键」），靠哨兵值迟早会撞上。
 *
 * 分层由渲染层决定（名字 → 情绪 / 配件 / 道具 / 按键层的归属表在那边），
 * 主进程只管「要哪个名字、挂多久」，两边不各存一份分类。
 */
export type ExpressionCommand =
  | { kind: 'named'; name: string; holdMs?: number }
  /** 再点一次取消：已生效就摘掉，否则常驻套上（托盘「试个表情」的勾选语义） */
  | { kind: 'toggle'; name: string }
  /** 按名字摘掉一层（闲置醒来时清掉「闭眼口水」，不动别的层） */
  | { kind: 'clear'; name: string }
  /** 随机抽一个（当前形象自带 40 个表情，随机很有用） */
  | { kind: 'random' }
  /** 回到没有任何表情的默认状态（清掉所有层） */
  | { kind: 'reset' }

/** 敲琴模式开关 */
export interface GameCommand {
  active: boolean
}

/**
 * 让桌宠说一句现成的话。
 *
 * 与对话事件分开：这条不走大模型，文本由主进程给全（番茄钟到点、久坐提醒、
 * 「剪贴板里没有文字」这类反馈）。之所以不把它塞进对话流里 —— 这些话不该进上下文，
 * 也不该在对话窗口里留下痕迹，它们只是桌宠在说话。
 */
export interface SayEvent {
  text: string
  /** error 走气泡的错误配色（红边）。默认 normal */
  tone?: 'normal' | 'error'
}

/**
 * 带选项的提问：气泡下方附一排按钮（最多 3 个）。
 *
 * 刻意**不带文本** —— 问题走既有的说话通道（petSay 或对话事件），按钮只是挂上去。
 * 这样「先说一句再问」「回答完接着说」都不用第二条通道，先后顺序也不敏感：
 * 按钮挂在气泡当时的内容上，内容一换就自动撤（见渲染层 pet/bubble.ts）。
 */
export interface AskEvent {
  id: number
  options: string[]
}

export interface AskAnswer {
  id: number
  index: number
}

/** 按钮下线的原因。只用于日志 —— 主进程对三种的处理相同：清掉这条待答 */
export type AskDismissReason = 'timeout' | 'replaced' | 'hidden'

export interface AskDismiss {
  id: number
  reason: AskDismissReason
}

/**
 * 渲染层报告给主进程的运行时状态。
 *
 * 表情分层后「当前套着什么」只有渲染层知道（瞬态到期、按键层顶替都发生在那边），
 * 而托盘菜单要打勾、闲置时钟要避让敲琴 —— 所以由渲染层上报，主进程只做缓存与展示。
 */
export interface PetRuntimeState {
  /** 当前生效的表情名（可能有多个：叠加出来的组合） */
  expressions: string[]
  /** 敲琴模式是否开着 */
  game: boolean
}

export interface DragResult {
  /** 位移超过阈值才为 true */
  moved: boolean
}

/** 挂在 window.pet 上的 API，preload 实现、渲染层消费 */
export interface PetApi {
  getConfig(): Promise<RendererConfig>
  dragStart(): void
  dragEnd(): Promise<DragResult>
  /**
   * 订阅「拖动真的开始了」。渲染层自己判定不了 —— 它是主进程轮询真实光标、
   * 位移过阈值那一刻才知道的，所以这条只能由主进程推回来。
   */
  onDragMoved(listener: () => void): () => void
  setInteractive(interactive: boolean): void
  onConfigChanged(listener: (config: RendererConfig) => void): () => void
  onExpression(listener: (command: ExpressionCommand) => void): () => void
  onGame(listener: (command: GameCommand) => void): () => void
  /** 上报当前生效的表情与敲琴状态（只在变化时调用） */
  reportRuntimeState(state: PetRuntimeState): void
  /** 上报「用户碰了形象」，主进程据此重置闲置时钟 */
  reportActivity(): void
  /** 订阅「让桌宠说一句现成的话」（不走大模型） */
  onSay(listener: (event: SayEvent) => void): () => void
  /** 订阅「给气泡附上一排选项按钮」 */
  onAsk(listener: (event: AskEvent) => void): () => void
  /** 点了某个选项（答案的落地在主进程，渲染层不关心它对应什么） */
  answerAsk(answer: AskAnswer): void
  /** 按钮下线了：到点、被新内容顶掉、气泡收起 */
  dismissAsk(dismiss: AskDismiss): void
  /**
   * 收起桌宠（形象窗口上的双指轻点 / 右键触发）。
   * 单向通知即可 —— 恢复入口在托盘「显示 / 隐藏」，渲染层不需要回执。
   */
  hidePet(): void
  /** 发送一轮用户输入；空文本会被主进程拒绝 */
  sendChat(text: string): Promise<ChatSendResult>
  /** 中断正在生成的回复；没有在生成时是空操作 */
  abortChat(): void
  /** 拉取完整对话历史与当前流式状态（对话窗口启动时用） */
  getChatSnapshot(): Promise<ChatHistorySnapshot>
  clearChat(): Promise<void>
  /** 把对话窗口带到前面来（没有就开，开着就聚焦）。气泡双击用 */
  openChat(): void
  /** 订阅「对话已清空」；事件本身没有载荷，收到即代表该把界面上的对话抹掉 */
  onChatCleared(listener: () => void): () => void
  onChatDelta(listener: (event: ChatDeltaEvent) => void): () => void
  onChatDone(listener: (event: ChatDoneEvent) => void): () => void
  onChatError(listener: (event: ChatErrorEvent) => void): () => void
}
