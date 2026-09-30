/**
 * 陪玩：能在本地接住的话，就不惊动大模型。
 *
 * 三类东西住在这里：
 * 1. **一次性的** —— 表情点单（「哭一个」）、帮你决定（抛硬币、报一串选项让它挑）；
 * 2. **有状态的** —— 猜数字、猜拳、猜表情，一句一句地来回；
 * 3. **带选项的** —— 邀请与猜拳会把按钮挂到气泡上（见 ask.ts），点一下顶打一句话。
 *
 * 状态为什么放在主进程：输入可能来自气泡输入框，也可能来自对话窗口，状态放任何一侧
 * 都会出现「换个窗口说下一句就接不上」。而判定为什么不用大模型：游戏得**确定** ——
 * 模型偶尔会把「大了」说成「小了」，照着猜下去会疯 —— 而且这些回答要快、要免费、断网也能玩。
 *
 * 本地接住的轮次不进上下文也不落盘（见 ai.ts 的 local 标记）：让模型在下一轮
 * 读到「user: 石头」，它只会莫名其妙地接着猜拳。
 */
import { applyExpression } from './actions'
import { cancelAsk, showAsk } from './ask'
import { loadConfig } from './config'
import { listExpressions } from './models'

/** 点单只认短句：长句里带个「哭」多半是在说心事，那该由模型去接（见 orderFace） */
const ORDER_MAX_CHARS = 12
/** 猜表情挂出去的那张脸最多等这么久，之后自己收掉 —— 用户走开了总不能让它一直挂着 */
const FACE_WAIT_MS = 10 * 60 * 1000
/** 邀请的有效期：说了「好」但没赶上这段时间，就当没这回事 */
const INVITE_TTL_MS = 2 * 60 * 1000
/** 出拳只认短句（「布」一个字；长了就不是出拳，是在说别的） */
const RPS_MAX_CHARS = 4
/** 猜表情的答案最多几个字：再长就不像在猜，像在问话 */
const FACE_GUESS_MAX_CHARS = 10

/**
 * 表情表：**点单和猜表情共用同一张**。
 *
 * - `names` 是候选名，按顺序取当前形象里第一个存在的 —— 换形象之后清单会变，
 *   写死一个名字的话，换个形象就点不动了（托盘的表情清单是从 model3.json 现读的，这里同理）。
 * - `words` 是「认得出来的说法」，两个用途：点单的触发词、猜表情时判对错的说法。
 * - `noGuess` 的表情不参与猜谜：眼镜有三副，挂出一副让人猜「眼镜」并不公平。
 */
interface FaceEntry {
  names: string[]
  words: string[]
  /** 点单时顺口回的那一句 */
  say: string
  noGuess?: boolean
}

const FACE_TABLE: FaceEntry[] = [
  { names: ['大哭'], words: ['大哭', '哭一个', '哭一下', '哭给我看', '想哭', '呜呜', '哇哇'], say: '呜哇——（眼泪糊了一脸）' },
  { names: ['墨镜'], words: ['墨镜', '戴墨镜', '装酷', '酷一个'], say: '戴上，看看帅不帅' },
  { names: ['奶茶'], words: ['奶茶', '喝奶茶', '喝一杯'], say: '奶茶！先吸一大口' },
  { names: ['生气'], words: ['生气', '气一个', '气鼓鼓', '哼'], say: '哼！！' },
  { names: ['开心兴奋'], words: ['开心', '笑一个', '笑一下', '高兴'], say: '嘿嘿，今天心情好' },
  { names: ['脸红'], words: ['脸红', '害羞', '羞一个'], say: '别、别看啦' },
  { names: ['爱心眼'], words: ['爱心', '比心', '喜欢你', '爱你'], say: '（满眼都是你）' },
  { names: ['猫猫贴纸'], words: ['猫猫', '喵', '学猫叫', '喵一个'], say: '喵！' },
  { names: ['情绪花花'], words: ['花', '花花', '开花'], say: '花开啦' },
  { names: ['晕晕'], words: ['晕', '头晕', '晕一个'], say: '转、转圈圈…' },
  { names: ['调皮'], words: ['调皮', '略略略', '略一个', '吐舌头'], say: '略略略' },
  { names: ['吐魂'], words: ['吐魂', '灵魂出窍'], say: '魂都飞出去了…' },
  { names: ['戴帽子'], words: ['帽子', '戴帽子'], say: '这顶好看吗' },
  { names: ['星星眼'], words: ['星星眼'], say: '哇——' },
  { names: ['问号'], words: ['问号', '疑惑', '不懂'], say: '嗯？什么情况' },
  { names: ['感叹号'], words: ['感叹号', '惊叹'], say: '！' },
  { names: ['心跳'], words: ['心跳'], say: '（扑通扑通）' },
  { names: ['举喇叭'], words: ['喇叭', '举喇叭'], say: '注意啦注意啦——' },
  { names: ['呆呆眼'], words: ['呆呆眼', '呆'], say: '发、发呆中…' },
  // 「难过」「委屈」刻意不做点单词：那多半是用户在说心事，该由模型接
  { names: ['悲伤'], words: ['悲伤', '伤心'], say: '……（默默坐在你旁边）' },
  { names: ['圆眼镜'], words: ['眼镜', '戴眼镜'], say: '学者模式，启动', noGuess: true }
]

type GameKind = 'number' | 'rps' | 'face'

type GameState =
  | { kind: 'number'; target: number; tries: number }
  | { kind: 'rps'; wins: number }
  | { kind: 'face'; key: number; name: string; wrong: number }

let game: GameState | null = null
/** 刚发出的邀请，等你回一句「好」；null = 没邀请 */
let pendingInvite: GameKind | null = null
let inviteAt = 0
/** 猜表情挂着的那张脸的收摊闹钟 */
let faceTimer: NodeJS.Timeout | null = null

const GAME_TRIGGERS: Array<{ kind: GameKind; words: string[] }> = [
  { kind: 'number', words: ['猜数字', '猜个数', '猜数'] },
  { kind: 'rps', words: ['猜拳', '石头剪刀布', '剪刀石头布'] },
  { kind: 'face', words: ['猜表情', '猜脸'] }
]

const MENU_WORDS = ['玩什么', '玩个游戏', '玩点', '小游戏', '无聊']

const YES_WORDS = ['好', '来', '行', '可以', '要', '嗯', '玩', '开始']
const NO_WORDS = ['不', '算了', '下次', '不想']
const QUIT_WORDS = ['不玩', '不猜了', '退出', '结束', '算了']

const INVITE_LINES: Record<GameKind, string[]> = {
  number: ['要不要玩个猜数字？我心里已经想好一个数了', '陪我猜个数？1 到 100 那种'],
  rps: ['猜拳吗？我手气正好', '来一局石头剪刀布？我出拳很快的'],
  face: ['猜猜我现在挂的是什么表情？', '考眼力的时候到了：猜猜我这张脸']
}

/**
 * 试试这句话能不能在本地接住。接到就返回它要回的文本（表情已经顺手换好），
 * 接不住返回 null —— 调用方把那句话原样交给大模型。
 */
export function tryLocalReply(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null

  // 1) 正在进行的游戏排在最先：它此刻在等你的下一步
  if (game !== null) {
    const reply = stepGame(trimmed)
    if (reply !== null) return reply
    // 没接住 = 你换话题了：stepGame 已经把这一局收尾，这句话照常往下走
  }

  // 2) 刚发过邀请：一句「好」（或「算了」）算应答
  const answered = answerInvite(trimmed)
  if (answered !== null) return answered

  // 3) 开局
  const started = startGame(trimmed)
  if (started !== null) return started

  // 4) 一次性的两样
  return decide(trimmed) ?? orderFace(trimmed)
}

/**
 * 邀请它玩一局（碎碎念用）。没有能玩的游戏时返回 null —— 调用方退回普通搭话。
 *
 * 只有「心里已经想好一个数」这种话才值得邀请：邀请是个承诺，用户说「好」的那一刻
 * 必须真的能开局（见 answerInvite）。
 */
export function inviteToPlay(): string | null {
  if (game !== null) return null
  const kinds: GameKind[] = ['number', 'rps']
  if (pickFace() !== null) kinds.push('face')
  const kind = pick(kinds)
  pendingInvite = kind
  inviteAt = Date.now()
  return pick(INVITE_LINES[kind])
}

/** 清空对话时一起复位：进行中的游戏结束，猜表情挂着的脸摘掉 */
export function resetPlay(): void {
  endGame()
  pendingInvite = null
}

// ---------- 选项按钮（见 ask.ts） ----------

/** 提问的归属标记：收摊时按它撤，别误伤同时在等答案的饭点问句 */
const ASK_OWNER = 'play'

/**
 * 本地回合的出口，由 session 注入（见 setLocalTurnSink）。
 *
 * 按钮点出来的那一回合要走**和打字接住的完全同一条路**：进对话历史（local 标记）、
 * 上气泡、上对话窗口 —— 只是「用户那句话」是按钮文案，不是打出来的字。
 */
let localSink: ((userText: string, reply: string) => void) | null = null

export function setLocalTurnSink(sink: (userText: string, reply: string) => void): void {
  localSink = sink
}

function deliverLocal(userText: string, reply: string): void {
  if (localSink === null) {
    console.warn(`[play] 本地回合的出口还没接上，这一句只能算了：${reply}`)
    return
  }
  localSink(userText, reply)
}

/**
 * 每一轮本地回复说完之后都会经过这里（session 调）：
 * 猜拳还在等你出拳就把按钮补上 —— 按钮挂在刚说完的那句话下面，点着接着玩。
 */
export function afterLocalReply(): void {
  if (game?.kind === 'rps') askRpsTurn()
}

/** 邀请的按钮：这个形象能玩哪个就摆哪个（猜表情要脸够多，和 pickFace 同一个门槛） */
export function askInviteGames(): void {
  const options: Array<{ label: string; kind: GameKind }> = [
    { label: '猜数字', kind: 'number' },
    { label: '猜拳', kind: 'rps' }
  ]
  if (canGuessFace()) options.push({ label: '猜表情', kind: 'face' })

  showAsk({
    owner: ASK_OWNER,
    options: options.map((option) => option.label),
    onAnswer: (index) => {
      const chosen = options[index]
      if (chosen === undefined) return
      // 点选即应答，和打字说一声「好」同义：那个两分钟的应答窗口就此关掉
      pendingInvite = null
      deliverLocal(chosen.label, beginGame(chosen.kind))
    }
  })
}

/** 轮到你了：把三个拳挂上去（每回合都重新挂，20 秒没人点就自己收掉，还能打字出拳） */
function askRpsTurn(): void {
  showAsk({
    owner: ASK_OWNER,
    options: [...RPS_LABELS],
    onAnswer: (index) => {
      const label = RPS_LABELS[index]
      const current = game
      // 按钮可能已经过期（点之前这一局就收摊了）：忽略这一下
      if (label === undefined || current === null || current.kind !== 'rps') return
      const reply = stepRps(current, label)
      if (reply !== null) deliverLocal(label, reply)
    }
  })
}

// ---------- 游戏的开局与推进 ----------

function startGame(text: string): string | null {
  if (game !== null) return null
  const kind = matchGameKind(text)
  if (kind !== null) return beginGame(kind)
  if (MENU_WORDS.some((word) => text.includes(word))) {
    return '我会猜数字、猜拳、猜表情，还能帮你决定（「吃面还是吃饭」）和变脸（「哭一个」）——想玩哪个？'
  }
  return null
}

/** 这一句像不像「开一局 / 玩什么」（开局动作本身在 startGame 里） */
function matchesGameStart(text: string): boolean {
  return matchGameKind(text) !== null || MENU_WORDS.some((word) => text.includes(word))
}

function matchGameKind(text: string): GameKind | null {
  for (const entry of GAME_TRIGGERS) {
    if (entry.words.some((word) => text.includes(word))) return entry.kind
  }
  return null
}

/** 开一局。永远回一句话（猜表情没有可用的脸时也回一句，而不是把这句话漏给模型） */
function beginGame(kind: GameKind): string {
  if (kind === 'number') {
    game = { kind: 'number', target: 1 + Math.floor(Math.random() * 100), tries: 0 }
    applyExpression({ kind: 'named', name: '调皮', holdMs: 2000 })
    return '好呀，我想了一个 1 到 100 的整数，你猜'
  }
  if (kind === 'rps') {
    game = { kind: 'rps', wins: 0 }
    return '来！你出石头、剪刀还是布？'
  }

  const chosen = pickFace()
  if (chosen === null) return '这个形象的表情我还没认全，换别的玩吧'
  game = { kind: 'face', key: chosen.key, name: chosen.name, wrong: 0 }
  applyExpression({ kind: 'named', name: chosen.name })
  armFaceTimer(chosen.name)
  return '（挂上了一张脸）猜猜我现在是什么表情？'
}

/**
 * 你刚发了邀请，看这一句是不是应答；不是应答（或过期）返回 null，那句话照常往下走。
 *
 * 不因为「这句不是应答」就作废掉邀请：邀请后紧接着问一句别的（「等我一下」）很常见，
 * 而那次「好」多半就是在答这局。作废只有一个途径 —— 有效期过了。
 */
function answerInvite(text: string): string | null {
  const kind = pendingInvite
  if (kind === null) return null
  if (Date.now() - inviteAt > INVITE_TTL_MS) {
    pendingInvite = null
    return null
  }

  // 应答都是短句：「好」可以，「好，那我再问你个事」不行 —— 后者是接着聊天，不是答应了
  if (Array.from(text).length > RPS_MAX_CHARS + 2) return null
  const yes = YES_WORDS.some((word) => text.includes(word))
  const no = NO_WORDS.some((word) => text.includes(word))
  if (no && !yes) {
    pendingInvite = null
    return '好，那下次～'
  }
  if (yes && !no) {
    pendingInvite = null
    return beginGame(kind)
  }
  return null
}

/** 推进当前这一局；返回 null 表示「这句不是这一步棋」（顺带把这一局收尾） */
function stepGame(text: string): string | null {
  if (game === null) return null
  if (QUIT_WORDS.some((word) => text.includes(word))) {
    endGame()
    return '好，那先不玩啦'
  }
  if (game.kind === 'number') return stepNumber(game, text)
  if (game.kind === 'rps') return stepRps(game, text)
  return stepFace(game, text)
}

function stepNumber(state: Extract<GameState, { kind: 'number' }>, text: string): string | null {
  const numbers = text.match(/\d+/g)
  // 没有数字、或一串数字（多半是在说别的）：这一局到此为止，不再追问
  if (numbers === null || numbers.length > 1) {
    endGame()
    return null
  }
  const guess = Number(numbers[0])
  if (!Number.isInteger(guess) || guess < 1 || guess > 100) {
    // 一百出头的数更像是猜错了范围，提醒一句；再离谱的就当换话题
    if (guess > 100 && guess <= 1000) return '我说的是 1 到 100 哦'
    endGame()
    return null
  }

  state.tries += 1
  if (guess === state.target) {
    const tries = state.tries
    game = null
    applyExpression({ kind: 'named', name: '开心兴奋', holdMs: 3000 })
    return `就是 ${guess}！你猜了 ${tries} 次`
  }
  return guess > state.target ? '大了' : '小了'
}

const RPS_MOVES = [
  { name: '石头', words: ['石头', '拳头', '锤子'] },
  { name: '剪刀', words: ['剪刀', '剪子'] },
  { name: '布', words: ['布', '包袱'] }
] as const

/** 猜拳的三个拳，顺序即按钮顺序（回答里的下标直接对着它取） */
const RPS_LABELS: string[] = RPS_MOVES.map((move) => move.name)

/** 谁能赢谁：键赢值 */
const RPS_BEATS: Record<string, string> = { 石头: '剪刀', 剪刀: '布', 布: '石头' }

function stepRps(state: Extract<GameState, { kind: 'rps' }>, text: string): string | null {
  // 长度先卡掉：「石头剪刀布」五个字是游戏名，不是出拳
  if (Array.from(text).length > RPS_MAX_CHARS) {
    endGame()
    return null
  }
  const mine = pick(RPS_MOVES)
  const yours = RPS_MOVES.find((move) => move.words.some((word) => text.includes(word)))
  if (yours === undefined) {
    endGame()
    return null
  }

  if (mine.name === yours.name) return `都是${mine.name}……再来？`
  if (RPS_BEATS[mine.name] === yours.name) {
    state.wins = 0
    applyExpression({ kind: 'named', name: '调皮', holdMs: 2000 })
    return `我出${mine.name}，嘿嘿，这局我赢`
  }

  state.wins += 1
  const streak = state.wins >= 3 ? `——你都连赢 ${state.wins} 局了，我不服` : ''
  applyExpression({ kind: 'named', name: '生气', holdMs: 2000 })
  return `我出${mine.name}，你赢了${streak}`
}

function stepFace(state: Extract<GameState, { kind: 'face' }>, text: string): string | null {
  const entry = FACE_TABLE[state.key]
  const answer = state.name

  if (isGuessFor(entry, answer, text)) {
    endGame()
    applyExpression({ kind: 'named', name: '开心兴奋', holdMs: 3000 })
    return `对！就是「${answer}」`
  }

  // 不是答案，也可能是在说别的（点单 / 帮你决定 / 换一局）—— 先让那些接住。
  // 少了这一步，挂着脸的时候一句「抛硬币」会被算成猜错一次，
  // 而用户其实已经换了话题（这一句排在实际判错之前，但排在判对之后：
  // 猜「猫猫」既像答案「猫猫贴纸」也像点单，那种时候当然算猜对了）。
  const other = decide(text) ?? orderFace(text)
  if (other !== null) {
    endGame()
    return other
  }
  if (matchesGameStart(text)) {
    endGame()
    return startGame(text)
  }

  // 长句或问句：这是在说别的，不是在猜 —— 把脸悄悄收掉，别让一句问话搅进猜谜里
  const chars = Array.from(text)
  if (chars.length > FACE_GUESS_MAX_CHARS || /[?？]/.test(text)) {
    endGame()
    return null
  }

  state.wrong += 1
  if (state.wrong === 1) return '不是哦，再想想？'
  endGame()
  return `不对啦，这是「${answer}」`
}

/**
 * 结束当前这一局：摘掉猜表情挂着的那张脸（有的话）、停掉收摊闹钟、清空状态，
 * 顺带把气泡上的按钮撤下来（猜拳每回合都会重新挂上，局结束了就不该还留着）。
 *
 * 三件事必须一起做 —— 「结束」有好几个入口（玩腻了说不玩、猜对、猜错两次、超时、清空对话），
 * 探针抓到过一次某条路漏掉 `game = null` 的版本：那一局阴魂不散，
 * 之后每一句话都被当成猜错，一直重复「不对啦，这是……」。
 */
function endGame(): void {
  if (game?.kind === 'face') applyExpression({ kind: 'clear', name: game.name })
  clearFaceTimer()
  game = null
  cancelAsk(ASK_OWNER)
}

function armFaceTimer(name: string): void {
  clearFaceTimer()
  faceTimer = setTimeout(() => {
    faceTimer = null
    if (game?.kind !== 'face') return
    endGame()
    console.log(`[play] 猜表情没人接，把脸收掉了（答案：${name}）`)
  }, FACE_WAIT_MS)
}

function clearFaceTimer(): void {
  if (faceTimer === null) return
  clearTimeout(faceTimer)
  faceTimer = null
}

// ---------- 一次性的两样 ----------

const COIN_WORDS = ['抛硬币', '掷硬币', '扔硬币', '抛个硬币', '硬币决定']
const DICE_WORDS = ['摇骰子', '掷骰子', '扔骰子', '摇个骰子', '来个骰子']
const DECIDE_WORDS = ['帮我决定', '帮我选', '帮我挑', '选一个', '决定一下', '拿个主意']
/** 选项之间的分隔符；长的写在前面，「或者」不能被「或」切开 */
const OPTION_SPLIT = /还是|或者|或是|要么|、|,|，|;|；|\/|或|和|vs/i

function decide(text: string): string | null {
  if (COIN_WORDS.some((word) => text.includes(word))) {
    applyExpression({ kind: 'named', name: '心跳', holdMs: 2500 })
    return Math.random() < 0.5 ? '硬币说：正面' : '硬币说：反面'
  }
  if (DICE_WORDS.some((word) => text.includes(word))) {
    applyExpression({ kind: 'named', name: '心跳', holdMs: 2500 })
    return `骰子说：${1 + Math.floor(Math.random() * 6)} 点`
  }

  const trigger = DECIDE_WORDS.find((word) => text.includes(word))
  if (trigger === undefined) return null
  const at = text.indexOf(trigger)
  // 选项可能在触发词后面（「帮我决定：吃面还是吃饭」），也可能在前面（「吃面还是吃饭，帮我选一个」）
  const after = text.slice(at + trigger.length).replace(/^[\s:：,，。！!]+/, '')
  const before = text.slice(0, at).replace(/[\s:：,，。！!]+$/, '')
  const options =
    parseOptions(after).length >= 2 ? parseOptions(after) : parseOptions(before)
  if (options.length < 2) return '报两个选项给我嘛，比如「吃面还是吃饭」'

  const choice = pick(options)
  applyExpression({ kind: 'named', name: '调皮', holdMs: 2000 })
  return pick([`就 ${choice} 吧`, `${choice}！听我的`, `我选 ${choice}，别纠结啦`])
}

/** 把一段话拆成候选选项：太长的（多半是一整句叮嘱）不算选项 */
function parseOptions(text: string): string[] {
  return text
    .split(OPTION_SPLIT)
    .map((option) => option.trim())
    .filter((option) => option.length > 0 && option.length <= 20)
}

function orderFace(text: string): string | null {
  if (Array.from(text).length > ORDER_MAX_CHARS) return null
  const entry = FACE_TABLE.find((item) => item.words.some((word) => text.includes(word)))
  if (entry === undefined) return null
  const name = resolveName(entry)
  // 这个形象没有这个表情：交给模型去接（它至少能说句别的，而不是点了个空的）
  if (name === null) return null
  applyExpression({ kind: 'named', name, holdMs: 3000 })
  return entry.say
}

// ---------- 表情清单 ----------

/** 当前形象真的挂了哪些表情（model3.json 现读，和托盘那份清单同一个来源） */
function availableFaces(): Set<string> {
  return new Set(listExpressions(loadConfig().model.path).map((item) => item.name))
}

/** 表里第一个在当前形象上存在的名字；一个都没有返回 null */
function resolveName(entry: FaceEntry): string | null {
  const faces = availableFaces()
  return entry.names.find((name) => faces.has(name)) ?? null
}

/** 随机抽一个能猜的表情；可选的脸太少（或这个形象认不全）返回 null */
function pickFace(): { key: number; name: string } | null {
  const pool = facePool()
  if (pool.length < 4) return null
  return pick(pool)
}

/** 这个形象能不能玩猜表情：脸够多才好玩（和 pickFace 同一个门槛，按钮那边也用它） */
function canGuessFace(): boolean {
  return facePool().length >= 4
}

/** 当前形象里可当谜底的（表情名, 表下标），点单里 noGuess 的那些不算 */
function facePool(): Array<{ key: number; name: string }> {
  const faces = availableFaces()
  const pool: Array<{ key: number; name: string }> = []
  FACE_TABLE.forEach((entry, key) => {
    if (entry.noGuess === true) return
    const name = entry.names.find((item) => faces.has(item))
    if (name !== undefined) pool.push({ key, name })
  })
  return pool
}

/** 猜的这个说法对不对：表情名和它认得的说法都算 */
function isGuessFor(entry: FaceEntry, name: string, text: string): boolean {
  const guess = normalizeGuess(text)
  if (guess.length === 0) return false
  return [name, ...entry.words].some((alias) => guess.includes(normalizeGuess(alias)))
}

/** 判对错前把客套话削掉：「是不是墨镜呀」和「墨镜」是同一个答案 */
function normalizeGuess(text: string): string {
  return text
    .replace(/[\s，。！？、,.!?：:（）()【】[\]]/g, '')
    .replace(/表情|这个|那个|是不是|是|的|啦|了|呀|呢|吧/g, '')
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}
