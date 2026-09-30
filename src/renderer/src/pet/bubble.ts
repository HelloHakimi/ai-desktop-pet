/**
 * 形象气泡：桌宠「说」出来的那一句。
 *
 * 内容是主进程广播的对话事件，与对话窗口开不开无关 —— 每轮回复都会在这里同步说一遍，
 * 所以关掉窗口之后也还有反馈（气泡是那时唯一的出口）。
 *
 * 三条约束决定了实现方式：
 * 1. **默认纯展示**：`pointer-events: none`（见 style.css）。气泡就浮在形象头顶，
 *    一旦能收鼠标事件，命中判定和拖动就会把「鼠标在气泡上」当成「鼠标在形象上」。
 *    唯一的例外是下面那排提问按钮 —— 它单独把指针事件要回来（见 §选项按钮）。
 * 2. **不抢视线**：说完停留几秒自己淡出；鼠标停在气泡上时暂停计时（正在读的话别收走）。
 * 3. **说不完就截断**：气泡窄，只显示回复开头，全文在对话窗口里。
 */
import type { AskDismissReason } from '@shared/ipc'
import type { HitBox } from './types'

/** 气泡最多显示多少字符，超出截断成省略号 */
const MAX_CHARS = 60
/** 说完之后停留多久开始淡出 */
const HOLD_MS = 8000
/**
 * 问答气泡能挂多久：没人理就整条收掉、之后不再追问（拍板定的 20 秒）。
 * 比普通气泡的 8 秒长 —— 读完还得留个点按钮的时间；鼠标停在上面时同样暂停。
 */
const ASK_HOLD_MS = 20_000
/** 气泡底边与形象命中框顶边的间距 */
const GAP_PX = 6
/** 气泡离窗口上边缘的最小距离：上方放不下时宁可压住头顶，也不能被窗口裁掉 */
const MARGIN_PX = 8

/** hidden = 没在说话；streaming = 正在出字；settled = 说完了，等着淡出 */
type Phase = 'hidden' | 'streaming' | 'settled'

export class PetBubble {
  private readonly element: HTMLElement
  private readonly textEl: HTMLElement
  private readonly optionsEl: HTMLElement
  private readonly host: HTMLElement
  private readonly getHitBox: () => HitBox | null
  private phase: Phase = 'hidden'
  /** 当前显示的文本是不是被截断过 —— 双击展开全文要靠它判断 */
  private truncated = false
  private holdTimer: number | null = null
  private hovering = false
  /** 本轮气泡的基础 bottom（begin 时定下），clamp 只在此基础上做调整 */
  private baseBottom = 0
  /** 挂着的提问（主进程给的选项）；null = 没有 */
  private ask: { id: number; options: string[] } | null = null
  /** 提问计时器：到点把整条气泡收掉 */
  private askTimer: number | null = null
  /**
   * 挂上提问时气泡说的那句话。按钮**跟着这句话走** ——
   * 内容一换（新回复、新台词），按钮就该撤：问题都没了，按钮留着只会挡视线。
   */
  private askAnchor = ''

  constructor(host: HTMLElement, getHitBox: () => HitBox | null) {
    this.host = host
    this.getHitBox = getHitBox

    this.element = document.createElement('div')
    this.element.className = 'pet-bubble'
    this.element.setAttribute('aria-hidden', 'true')

    this.textEl = document.createElement('div')
    this.textEl.className = 'pet-bubble__text'

    this.optionsEl = document.createElement('div')
    this.optionsEl.className = 'pet-bubble__options'

    this.element.append(this.textEl, this.optionsEl)
    host.append(this.element)

    // 指针在气泡上时暂停淡出。用坐标判断而不是 mouseenter：气泡是 pointer-events: none，
    // 它自己收不到任何鼠标事件（那排按钮除外，见 §选项按钮）。
    window.addEventListener('pointermove', (event) => {
      if (this.phase === 'hidden') return
      const inside = this.containsPoint(event.clientX, event.clientY)
      if (inside === this.hovering) return
      this.hovering = inside
      if (inside) {
        // 正在读 / 正在犹豫点哪个：两个计时都别走
        this.cancelHold()
        this.cancelAskTimer()
      } else if (this.ask !== null) {
        // 移开了：重新开始数（停在上面多久都行，别让按钮在手底下消失）
        this.scheduleAskHold()
      } else if (this.phase === 'settled') {
        this.scheduleHold()
      }
    })
  }

  /** 新一轮开始：立刻显示，先给个省略号表示在想 */
  begin(): void {
    this.cancelHold()
    this.phase = 'streaming'
    this.element.classList.remove('pet-bubble--error')
    this.textEl.textContent = '…'
    // 先让浏览器认下「当前是隐藏状态」，否则紧接着加上的显示类不会触发过渡
    void this.element.offsetHeight
    this.element.classList.add('pet-bubble--visible')
    this.anchor()
  }

  /** 流式增量：text 是「到目前为止的完整回复」，整体替换即可 */
  update(text: string): void {
    // 兜底：窗口是新建的而会话早就开始了（生成中重开形象窗口），从此刻接上
    if (this.phase === 'hidden') this.begin()
    this.setText(text)
    this.clampInside()
  }

  /** 本轮正常结束：文本定住，停留几秒后淡出 */
  settle(text: string): void {
    this.show(text, false)
  }

  /** 本轮失败：错误信息也用气泡说一遍，否则对话窗口关着时没有任何反馈 */
  fail(message: string): void {
    this.show(message, true)
  }

  private show(text: string, error: boolean): void {
    // 顺序不能反：begin() 里有一句「把文本重置成 …」当占位，所以必须**先起泡、再落字**。
    // 反过来写（先 setText 再 begin）会把刚说出口的那句话擦掉，气泡定格在省略号上 ——
    // 而 say 这条路上气泡多半是隐藏的，也就是说每一次都会踩到：
    // 番茄钟到点、久坐提醒、系统事件全都只说一个「…」。流式对话看不出来，
    // 是因为 update() 的顺序本来就是对的（先 begin 再 setText）。
    if (this.phase === 'hidden') this.begin()
    // 一个字都没说出来（刚开始就被停止 / 模型返回空）：不留一个空气泡在这等 8 秒
    if (!this.setText(text)) {
      this.hide()
      return
    }
    this.element.classList.toggle('pet-bubble--error', error)
    this.phase = 'settled'
    this.clampInside()
    this.scheduleHold()
  }

  /** 立即收起（对话被清空、提问到点没人理时） */
  hide(reason: AskDismissReason = 'hidden'): void {
    this.cancelHold()
    this.cancelAskTimer()
    this.phase = 'hidden'
    this.truncated = false
    this.hovering = false
    this.element.classList.remove('pet-bubble--visible')
    this.dropAsk(reason)
  }

  /**
   * 现在双击它能不能看到全文。
   *
   * 只有**被截断过**才算。这个判断是给点击穿透用的：气泡挂在形象上方，
   * 把它整块算成「可交互区域」会让形象头顶凭空多出一片挡住桌面的地方，
   * 而只有「这里还有没说出来的话」时，让用户点得到才有意义。
   *
   * 注意 begin() 阶段（刚显示、还没收到任何增量）拿到的是「…」，
   * 那时 truncated 是上一轮留下的值 —— 所以 hide() 必须清掉它。
   */
  isClickable(): boolean {
    return this.phase !== 'hidden' && this.truncated
  }

  /** 点在气泡的矩形范围内（双击判定用；气泡自己是 pointer-events: none，收不到事件） */
  containsPoint(x: number, y: number): boolean {
    const rect = this.element.getBoundingClientRect()
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  }

  /** 换上要显示的文字，记下有没有被截断；返回「有没有说出东西来」 */
  private setText(text: string): boolean {
    const { shown, truncated } = truncate(text)
    // 换了内容：挂在旧内容上的按钮就不该再留着（问题都没了，按钮别挡视线）
    if (this.ask !== null && shown !== this.askAnchor) this.dropAsk('replaced')
    this.textEl.textContent = shown
    this.truncated = truncated
    return shown.length > 0
  }

  destroy(): void {
    this.cancelHold()
    this.cancelAskTimer()
    this.element.remove()
  }

  // ---------- 选项按钮 ----------

  /**
   * 挂一排提问按钮（主进程的提问，见 main/ask.ts）。
   *
   * 按钮挂在气泡**当时**的内容上：那句话一换就自动撤（见 setText），
   * 所以「先说话再问」的顺序不敏感 —— 谁先到都行。
   */
  setAsk(ask: { id: number; options: string[] }): void {
    this.dropAsk('replaced', false)
    this.ask = ask
    this.askAnchor = this.textEl.textContent ?? ''
    this.renderOptions()
    // 8 秒的淡出让位给 20 秒的提问计时：挂了问题就不能先淡出
    this.cancelHold()
    this.scheduleAskHold()
    this.clampInside()
  }

  /** 现在挂着提问按钮 */
  hasAsk(): boolean {
    return this.ask !== null
  }

  /** 这块区域要不要接管鼠标（点击穿透用）：截断的文本能双击，提问按钮得能点 */
  wantsPointer(): boolean {
    return this.phase !== 'hidden' && (this.truncated || this.ask !== null)
  }

  private renderOptions(): void {
    this.optionsEl.replaceChildren()
    if (this.ask === null) return
    this.ask.options.forEach((label, index) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'pet-bubble__option'
      button.textContent = label
      button.addEventListener('click', () => {
        const id = this.ask?.id
        if (id === undefined) return
        // 先自己收掉：主进程的回话紧接着就来，别让旧按钮多留一帧
        this.dropAsk('replaced', false)
        window.pet.answerAsk({ id, index })
      })
      // 双击落在按钮上，不该顺带触发「双击气泡看全文」
      button.addEventListener('dblclick', (event) => event.stopPropagation())
      this.optionsEl.append(button)
    })
  }

  /**
   * 撤下按钮并把 DOM 与计时清干净。
   * notify=false 是自己先收的那一下（点击、被替换）：主进程不需要再听一条回执。
   */
  private dropAsk(reason: AskDismissReason, notify = true): void {
    const ask = this.ask
    this.cancelAskTimer()
    if (ask === null) return
    this.ask = null
    this.askAnchor = ''
    this.optionsEl.replaceChildren()
    if (notify) window.pet.dismissAsk({ id: ask.id, reason })
  }

  /** 20 秒没人理就整条收掉；鼠标停在气泡上时暂停（和淡出同一条规则） */
  private scheduleAskHold(): void {
    this.cancelAskTimer()
    if (this.hovering) return
    this.askTimer = window.setTimeout(() => {
      this.askTimer = null
      // 到点没人理：连问题一起收掉，之后不再追问
      this.hide('timeout')
    }, ASK_HOLD_MS)
  }

  private cancelAskTimer(): void {
    if (this.askTimer === null) return
    clearTimeout(this.askTimer)
    this.askTimer = null
  }

  // ---------- 位置 ----------

  /** 摆到形象头顶上方；命中框还拿不到（模型加载中）就先贴窗口上沿 */
  private anchor(): void {
    const hostHeight = this.host.clientHeight
    const box = this.getHitBox()
    const anchorY = box ? box.y - GAP_PX : 0
    this.baseBottom = hostHeight - anchorY
    this.clampInside()
  }

  /**
   * 保证气泡完整落在窗口内。
   *
   * 文本是逐步长出来的，气泡只会往上长（bottom 固定、高度增加），
   * 长到顶就整体下移 —— 所以每次内容变化后都要重新夹一次。
   */
  private clampInside(): void {
    const hostHeight = this.host.clientHeight
    const height = this.element.offsetHeight
    const top = hostHeight - this.baseBottom - height
    this.element.style.bottom =
      top < MARGIN_PX ? `${hostHeight - MARGIN_PX - height}px` : `${this.baseBottom}px`
  }

  // ---------- 淡出计时 ----------

  private scheduleHold(): void {
    this.cancelHold()
    // 挂着提问时由 askTimer 管收场，不走这条 8 秒的淡出
    if (this.ask !== null) return
    // 鼠标正停在气泡上：等它移开再计时（见构造器里的 pointermove）
    if (this.hovering) return
    this.holdTimer = window.setTimeout(() => {
      this.holdTimer = null
      this.hide()
    }, HOLD_MS)
  }

  private cancelHold(): void {
    if (this.holdTimer === null) return
    clearTimeout(this.holdTimer)
    this.holdTimer = null
  }
}

/**
 * 按字符（而非 UTF-16 码元）截断：回复里的 emoji 是两个码元，直接 slice 会切出半个字符。
 * 顺带告诉调用方「这次有没有截断」—— 只有截断过的气泡才值得让用户去点。
 */
function truncate(text: string): { shown: string; truncated: boolean } {
  const trimmed = text.trim()
  const chars = Array.from(trimmed)
  if (chars.length <= MAX_CHARS) return { shown: trimmed, truncated: false }
  return { shown: `${chars.slice(0, MAX_CHARS).join('')}…`, truncated: true }
}
