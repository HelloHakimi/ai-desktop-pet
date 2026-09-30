/**
 * 碎碎念：没人跟它说话的时候，它自己嘟囔两句。
 *
 * 定位是「活物感」而不是「信息」—— 这里说的每一句都不需要你做任何事，
 * 也因此它比提醒类更容易变成噪音：间隔随机（30–60 分钟），外加 presence 里那套闸门
 *（人在电脑前、不在专注与敲琴里、距上一句话够久）。开关是托盘的「闲聊」。
 *
 * 睡着的时候说的是**梦话**：打盹的节奏不变（5 分钟没人碰就睡，见 idle.ts），
 * 人还在电脑前的话，它就在睡梦里偶尔念叨一句 —— 桌角有只小东西在说梦话，
 * 比一整天一动不动更像活着。醒着（你刚碰过它）的时候才说正常的话，还有可能拉你玩一局。
 */
import { applyExpression, petSay } from './actions'
import { loadConfig } from './config'
import { isSleeping, onNapStart } from './idle'
import { askInviteGames, inviteToPlay } from './play'
import { canSmallTalk } from './presence'

/** 两次搭话之间的随机间隔 */
const MIN_GAP_MS = 30 * 60 * 1000
const MAX_GAP_MS = 60 * 60 * 1000
/** 检查间隔：一分钟粒度足够 */
const TICK_MS = 60_000
/** 「好困」那句的冷却：每次打盹都配一句会变成复读机 */
const NAP_LINE_COOLDOWN_MS = 45 * 60 * 1000
/** 醒着的搭话里，改成邀请玩一局的比例 */
const INVITE_CHANCE = 0.25
/** 搭话时配的脸挂多久 */
const FACE_HOLD_MS = 2500

interface Line {
  text: string
  /** 配的脸；没有就只是说一句（梦话与「好困」不配脸：那时它挂着闭上的眼睛） */
  face?: string
}

const AWAKE_LINES: Line[] = [
  { text: '（画圈圈）好无聊啊……', face: '呆呆眼' },
  { text: '你忙你的，我自己待会儿', face: '猫猫贴纸' },
  { text: '刚才好像有个 bug 飞过去了', face: '问号' },
  { text: '眼睛累不累？远眺一下下呗' },
  { text: '我今天表现不错吧？（求表扬）', face: '星星眼' },
  { text: '桌面好干净呀……有点想乱扔点东西', face: '调皮' },
  { text: '突然好想喝奶茶', face: '奶茶' },
  { text: '（偷偷看你一眼）', face: '脸红' },
  { text: '水杯空了吧？我什么都没看见', face: '调皮' },
  { text: '要不要伸个懒腰？我数三下' },
  { text: '你要是发呆的话，我陪你一起发呆' },
  { text: '嗯……今天也还行' }
]

const DREAM_LINES = [
  '……（翻了个身）',
  '……唔……好吃……',
  '（说梦话）不要抢我的奶茶……',
  '……再睡五分钟……就五分钟……',
  '……呼……呼……',
  '（手指动了动）'
]

const NAP_LINES = ['好困……我先眯一小会儿', '困了……眯一会儿', '（打了个哈欠）眯一下下']

let timer: NodeJS.Timeout | null = null
/** 下一次搭话的时间点 */
let nextAt = 0
/** 上一次说「好困」的时刻；0 = 还没说过 */
let lastNapLineAt = 0

export function startSmalltalk(): void {
  if (timer) return
  schedule()
  timer = setInterval(tick, TICK_MS)

  // 打盹开始：配一句「好困」。脸是闲置时钟挂的，这句话归这里 ——
  // 冷却与开关都由说话的这边负责，闲置时钟那边不需要知道有人要说话
  onNapStart(() => {
    if (Date.now() - lastNapLineAt < NAP_LINE_COOLDOWN_MS) return
    if (!loadConfig().assist.smalltalk) return
    if (!canSmallTalk()) return
    lastNapLineAt = Date.now()
    say(pick(NAP_LINES))
  })
}

function tick(): void {
  if (Date.now() < nextAt) return

  if (!loadConfig().assist.smalltalk) {
    // 关着也把下一次排上：不然重新打开的那一刻会立刻蹦一句
    schedule()
    return
  }
  // 条件不满足就等下一分钟再看，**不重新抽签** —— 等的是「条件合适的那一刻」，
  // 而不是「30 分钟到了但它没空，于是再等 30 分钟」（那样会越飘越远）
  if (!canSmallTalk()) return
  schedule()

  if (isSleeping()) {
    say(pick(DREAM_LINES))
    return
  }

  // 醒着的时候留一小部分给邀请：主动开口最好带点「事」，不能全是自言自语
  if (Math.random() < INVITE_CHANCE) {
    const invite = inviteToPlay()
    if (invite !== null) {
      say(invite, '调皮')
      // 附上按钮：想玩哪个点哪个（打字说「好」那条老路照常留着）
      askInviteGames()
      return
    }
  }

  const line = pick(AWAKE_LINES)
  say(line.text, line.face)
}

function say(text: string, face?: string): void {
  if (face !== undefined) applyExpression({ kind: 'named', name: face, holdMs: FACE_HOLD_MS })
  petSay(text)
  console.log(`[talk] ${text}`)
}

function schedule(): void {
  nextAt = Date.now() + MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS)
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}
