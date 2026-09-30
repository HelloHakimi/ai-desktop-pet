/**
 * 系统事件拟人化：拔插电源、断网时说一句。
 *
 * 与 companion.ts 的分工：那边判的是「时间到了」（久坐、深夜），这边判的是「事发生了」。
 * 同一套克制：预设台词 + 一张限时脸，不走大模型 —— 即时反应要快要稳，
 * 而且用户想安静的时候不该收到一段 AI 生成的话。
 *
 * **只做看得见的那一半**：锁屏、合盖时屏幕本来就不亮，对着黑屏表演没有意义，
 * 所以这里没有「你走了」那一侧的反应，只有发生时人在场的那两个信号。
 *
 * 断网为什么是轮询而不是监听：Electron 主进程只有一个 `net.isOnline()` 可以问，它没有事件。
 * 而且判定要的是「**连续**离线」——切 Wi-Fi、VPN 重连都会闪一下离线，闪一下就说等于谎报。
 */
import { net, powerMonitor } from 'electron'
import { applyExpression, msSinceLastSay, petSay } from './actions'
import { loadConfig } from './config'

/** 断网轮询间隔 */
const NET_POLL_MS = 15_000
/** 连续离线多久才算「真断了」 */
const OFFLINE_AFTER_MS = 30_000
/** 反应的脸挂多久 */
const FACE_HOLD_MS = 2500
/** 与上一句话的最小间隔。跨模块的护栏，原因见 actions.ts 的 msSinceLastSay */
const QUIET_GAP_MS = 60_000

const UNPLUGGED_LINES = ['诶，线掉了？', '拔了？那我省着点用', '没事，还有电池撑着呢']
const PLUGGED_LINES = ['充上啦', '来电了，满血复活', '插上了，安心了']
const OFFLINE_LINES = ['网没了，先干点别的？', '网断了，要不歇会儿']

/** 脸与台词都定死在这里：想换一句是改一行的事，不值得为它开一个配置项 */
const UNPLUGGED_FACE = '流汗'
const PLUGGED_FACE = '开心兴奋'
const OFFLINE_FACE = '问号'

let started = false
/** 连续离线从这一刻算起；null = 在线 */
let offlineSince: number | null = null
/**
 * 这一轮离线已经说过了。
 *
 * **初值是 true**，这正好是「启动时就离线」的正确行为：应用刚起来时看到的离线状态
 * 不是「刚刚断了」，是它出生时世界的样子，没什么好报的。只有亲眼看到过在线
 *（下面那个 online 分支会把它放回 false），下一次断网才算一个**新事件**。
 */
let offlineTold = true

export function startSystemEvents(): void {
  if (started) return
  started = true

  // 这两个事件是 macOS / Windows 平台的（Electron 的声明里就这么划的）。
  // 平台不支持时它们永远不会来，不需要额外判断。
  powerMonitor.on('on-battery', () => react(UNPLUGGED_FACE, pick(UNPLUGGED_LINES)))
  powerMonitor.on('on-ac', () => react(PLUGGED_FACE, pick(PLUGGED_LINES)))

  setInterval(checkNetwork, NET_POLL_MS)
}

/**
 * 说一句 + 换一张脸。返回是否真的说了（调用方据此决定要不要记「已经说过」）。
 *
 * 开关和「刚刚才说过话」都算不出声：前者意思就是别出声；后者是不当复读机。
 * 被静默期挡下的不排队重试 —— 即时反应晚三十秒再补上，比不说还怪。
 */
function react(face: string, line: string): boolean {
  if (!loadConfig().assist.systemEvents) return false

  const gap = msSinceLastSay()
  if (gap < QUIET_GAP_MS) {
    console.log(`[event] ${line}（上一句才过了 ${Math.round(gap / 1000)} 秒，这次不出声）`)
    return false
  }

  applyExpression({ kind: 'named', name: face, holdMs: FACE_HOLD_MS })
  petSay(line)
  console.log(`[event] ${line}`)
  return true
}

/**
 * 断网检测。
 *
 * `net.isOnline()` 返回 true 只说明「链路是起来的」，不保证真的能连上外网（官方文档的原话），
 * 所以这个信号适合拿来说句俏皮话，不适合当「网络诊断」用 —— 反过来说，
 * 它返回 false 是相当强的「上不了网」证据，够我们用了。
 */
function checkNetwork(): void {
  if (net.isOnline()) {
    offlineSince = null
    // 恢复过在线，下一次断网才算新事件
    offlineTold = false
    return
  }

  const now = Date.now()
  if (offlineSince === null) {
    offlineSince = now
    return
  }
  if (offlineTold || now - offlineSince < OFFLINE_AFTER_MS) return
  // 被开关或静默期挡下时不留痕：下一个 15 秒还会再试，别把「这次没说」记成「说过了」
  if (react(OFFLINE_FACE, pick(OFFLINE_LINES))) offlineTold = true
}

function pick(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)]
}
