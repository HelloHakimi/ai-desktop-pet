/** 渲染层入口：装配形象渲染器、拖动、点击穿透、目光跟随，以及表情的全部触发 */
import './style.css'
import type { RendererConfig } from '@shared/config'
import type { PetRuntimeState } from '@shared/ipc'
import { PIANO_KEY_HOLD_MS } from '@shared/piano'
import { bindHitTest } from './drag/hitTest'
import { bindWindowDrag } from './drag/windowDrag'
import { createRenderer } from './pet/createRenderer'
import { PetBubble } from './pet/bubble'
import { PetInteraction } from './pet/interaction'
import { createPianoMode } from './pet/piano'
import { bindLookAt } from './pet/lookAt'
import { PlaceholderRenderer } from './pet/PlaceholderRenderer'
import type { PetRenderer } from './pet/types'

// 用取值函数而不是 `const host = ...; if (!host) throw`：
// 函数声明会被提升，TS 不会把窄化结果保留到闭包内部，这里直接返回非空类型更干净。
function requireHost(): HTMLElement {
  const element = document.getElementById('pet-root')
  if (!element) throw new Error('页面缺少 #pet-root 容器')
  return element
}

const host = requireHost()

let current: PetRenderer | null = null
let latestConfig: RendererConfig | null = null
/** 挂载代号：只有最后一次发起的挂载能把自己的渲染器装上去 */
let mountToken = 0
/** 敲琴模式开着（状态在渲染层，主进程靠上报同步） */
let gameActive = false
/** 上一次上报的运行时状态：状态是轮询出来的，值没变就不该刷 IPC */
let lastReport = ''

/**
 * 挂载形象。新形象挂上来时亮个相（星星眼）——
 * 启动的第一次挂载也走这里，等于「我来啦」；「重新加载形象」之后也是同一个动作。
 */
async function mountPet(config: RendererConfig): Promise<void> {
  const token = (mountToken += 1)

  latestConfig = config
  current?.destroy()
  current = null
  host.replaceChildren()

  let next: PetRenderer
  try {
    next = await createRenderer(host, config)
  } catch (error) {
    // 工厂内部已经处理了大部分失败，这里是最后一道兜底，绝不让窗口变空白
    const message = error instanceof Error ? error.message : String(error)
    console.error('[pet] 形象渲染失败：', error)
    next = new PlaceholderRenderer(host, `形象渲染失败：${message}`)
  }

  // 挂载过程中又来了新的挂载请求（重建形象是异步的，两条 IPC 之间就会撞上）：
  // 本次的产物必须自己销毁。只把 current 指向新的那个是不够的 ——
  // 旧渲染器的 canvas 和 Pixi ticker 会留在那里继续跑，每重建一次就泄漏一个 WebGL 上下文。
  if (token !== mountToken) {
    next.destroy()
    return
  }

  current = next
  console.info(`[pet] 形象渲染器已就绪：${current.kind}`)

  current.applyExpression('星星眼', 2000)
  // 重建渲染器会把表情层清空，敲琴模式的状态还在：琴要重新挂上
  if (gameActive) current.applyExpression('手敲琴')
}

/** 上报运行时状态（表情 + 敲琴）。主进程用画托盘的勾、并避让正在玩的琴 */
function reportRuntimeState(): void {
  const state: PetRuntimeState = {
    expressions: current?.activeExpressions() ?? [],
    game: gameActive
  }
  const serialized = JSON.stringify(state)
  if (serialized === lastReport) return
  lastReport = serialized
  window.pet.reportRuntimeState(state)
}

async function boot(): Promise<void> {
  if (!window.pet) {
    document.body.innerHTML =
      '<div class="placeholder-pet__note">未检测到 preload 注入的 API，请通过 npm run dev 启动 Electron</div>'
    return
  }

  const config = await window.pet.getConfig()
  await mountPet(config)

  const interaction = new PetInteraction({
    isOnPet: (x, y) => current?.hitTest(x, y) ?? false,
    hasExpression: (name) => current?.hasExpression(name) ?? false,
    // 「生气是不是还挂着」问的是渲染器，不是在交互层自己记一笔：生气有三个来路
    //（连点、托盘钉住、聊天关键词），只有表情调度器知道此刻到底谁挂着。
    isExpressionActive: (name) => current?.activeExpressions().includes(name) ?? false,
    play: (name, holdMs) => current?.applyExpression(name, holdMs),
    activity: () => window.pet.reportActivity(),
    isGameActive: () => gameActive,
    // 收起桌宠是主进程的事（窗口的可见性在那边），这里只转发 —— 恢复入口是托盘的「显示 / 隐藏」
    requestHide: () => window.pet.hidePet()
  })
  interaction.bind()

  // 敲琴：入口只在托盘（主进程），这里只管「进来之后怎么响应」
  const piano = createPianoMode({
    onKey: (name) => current?.applyExpression(name, PIANO_KEY_HOLD_MS),
    onStart: () => {
      gameActive = true
      current?.applyExpression('手敲琴')
      reportRuntimeState()
    },
    onStop: () => {
      gameActive = false
      current?.removeExpression('手敲琴')
      reportRuntimeState()
    }
  })

  // 点击/拖拽的反应都从这一条路出去：拖动层已经区分好了「点击」与「拖拽」。
  // 这里刻意不再有「双击形象开气泡输入框」—— 那个输入框会抢焦点（app.focus({ steal: true })），
  // 而点形象现在本身就是「逗它」的动作，连点两下很常见，冒出一个抢走键盘的输入框很讨厌。
  // 想打字走托盘「聊聊天」，或者 ⌥⌘+← 直接召出气泡输入框。
  bindWindowDrag(host, (moved, x, y) => {
    interaction.pointerUp(moved, x, y)
  })

  // 拖动真的开始了（主进程判定位移过阈值后推回来）：「晕晕」从这一刻挂上并常驻，
  // 拖到哪儿晕到哪儿 —— 松手后那点余韵由 pointerUp 补。
  window.pet.onDragMoved(() => interaction.dragStarted())

  // 气泡挂在 body 上而不是 #pet-root：换形象时 mountPet 会 replaceChildren，
  // 挂在 #pet-root 里的话每换一次形象气泡就被摘掉了
  const bubble = new PetBubble(document.body, () => current?.getHitBox() ?? null)

  window.pet.onChatDelta((event) => bubble.update(event.text))
  window.pet.onChatDone((event) => bubble.settle(event.content))
  window.pet.onChatError((event) => bubble.fail(event.error))

  // 主进程让它说一句现成的话（番茄钟到点、久坐提醒、「剪贴板里没有文字」…）：
  // 不走大模型，也不进对话历史，直接上气泡
  window.pet.onSay((event) =>
    event.tone === 'error' ? bubble.fail(event.text) : bubble.settle(event.text)
  )
  // 带选项的提问：往气泡底下挂一排按钮（说的那句话已经/即将由上面两条通道送到）
  window.pet.onAsk((event) => bubble.setAsk(event))
  // 清空可能在对话窗口里点，也可能在托盘里点 —— 两边都走同一条广播
  window.pet.onChatCleared(() => bubble.hide())

  // 双击气泡看全文：气泡只显示开头 60 字，说不完的部分在对话窗口里。
  // 气泡自己是 pointer-events: none（见 pet/bubble.ts 的说明：它一旦能收鼠标事件，
  // 命中判定和拖动就会把「鼠标在气泡上」当成「鼠标在形象上」），
  // 所以这里用坐标判，而不是给气泡挂监听。
  window.addEventListener('dblclick', (event) => {
    // 挂着提问按钮时不开对话窗口：这一刻的交互是点按钮，别顺手多开一个窗口
    if (bubble.hasAsk()) return
    if (!bubble.isClickable()) return
    if (!bubble.containsPoint(event.clientX, event.clientY)) return
    window.pet.openChat()
  })

  // 点击穿透的上报：指针在不在形象上由渲染器按真实像素判（Live2D 是 alpha 掩码），
  // 「要不要穿透」由主进程按配置决定 —— 这里只管如实上报。
  // 可交互区域除了形象本身，还包括「内容被截断的气泡」（双击看全文）与
  // 「挂着提问按钮的气泡」（按钮得点得到，见 pet/bubble.ts 的 wantsPointer）。
  bindHitTest((x, y) => {
    if (current?.hitTest(x, y)) return true
    return bubble.wantsPointer() && bubble.containsPoint(x, y)
  })
  bindLookAt(
    () => current,
    () => latestConfig?.model.autoInteract ?? false
  )

  window.pet.onConfigChanged((next) => {
    void mountPet(next)
  })

  window.pet.onExpression((command) => {
    // 切换形象是异步的，这期间 current 可能是 null —— 直接丢掉比排队更合适：
    // 用户点的是上一个形象的表情，等新形象挂上来再补放会很怪。
    if (!current) return
    switch (command.kind) {
      case 'named':
        current.applyExpression(command.name, command.holdMs)
        break
      case 'toggle':
        current.toggleExpression(command.name)
        break
      case 'clear':
        current.removeExpression(command.name)
        break
      case 'random':
        current.randomExpression()
        break
      case 'reset':
        current.clearExpressions()
        break
    }
    // 表情是异步加载的（首次要取一次 exp3），这里先报一次是给「立刻能看到的那些」，
    // 剩下的由下面的轮询补齐
    reportRuntimeState()
  })

  window.pet.onGame((command) => {
    if (command.active) piano.start()
    else piano.stop()
  })

  // 表情会自己到期回落（限时层），没有「变更事件」可听 —— 轮询 + diff 就够了：
  // 它只用于托盘的勾和闲置避让，400ms 的延迟看不出来，而为此在调度器里埋一套回调
  // 反而多一处要维护的联动。
  window.setInterval(reportRuntimeState, 400)
}

void boot()
