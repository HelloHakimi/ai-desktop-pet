/**
 * 表情分层调度器：把「谁现在挂着」这件事从单槽变成一个可以叠加的集合。
 *
 * 三个关键规则（都写在 applyFrame 里）：
 * 1. **每帧重写**：参数写在 `beforeModelUpdate`（库的所有参数写入者之后、求值之前），
 *    和眨眼、遮部件同一个窗口 —— 写一次留不住，动作下一轮就把参数覆盖回去了。
 * 2. **同名合并**：同一层（比如「奶茶」）被重新套上时刷新时长，而不是叠第二层；
 *    唯一的例外是常驻（托盘钉住）的那层 —— 重套不会把钉子拔掉，见 insert。
 * 3. **同参数按通道优先级决出唯一写入者**：通道顺序见 CHANNEL_ORDER，
 *    靠后的通道（以及同通道里后调用的那层）赢。这样「墨镜把眼睛压闭」和
 *    「晕晕把眼睛眯一半」同时挂上时结果稳定可预期，而不是看谁先写的。
 *
 * 不做淡入淡出：桌宠的反应要「啪」的一下才像活的，而且过渡会引入
 * 「上一层的权重还没退干净又要叠新层」的插值状态 —— 那是这套东西里最容易写出鬼影的地方。
 * 库里带过渡，但那是单槽语义；换成可叠加之后，宁可不加过渡。
 */
import type { ExpressionDef, ExpressionDefs, ExpressionParam } from './expressionDefs'

/** 参数读写面（coreModel 的一个收窄子集，方便测试与解耦） */
export interface ExpressionCore {
  getParameterValueById(id: string): number
  setParameterValueById(id: string, value: number): void
  /** 名字查不到时返回 -1（负数一律视为「这个模型没有这个参数」） */
  getParameterIndex(id: string): number
}

export type ExpressionChannel = 'emotion' | 'glasses' | 'decor' | 'prop' | 'piano' | 'key' | 'misc'

/**
 * 名字 → 通道。这张表是给当前这个形象（qpet-a）写的，依据是各 exp3 的参数分组：
 * 眼镜四个是一组、贴纸帽子各占一个参数可以共存、情绪脸各有一套独立的 Cheek id。
 *
 * 表里没有的名字落到 misc（单槽）—— 换个形象也能照常用，只是不会分层。
 */
const CHANNEL_OF: Record<string, ExpressionChannel> = {
  // 情绪脸（单槽：新的情绪顶掉旧的）
  开心兴奋: 'emotion',
  星星眼: 'emotion',
  爱心眼: 'emotion',
  脸红: 'emotion',
  调皮: 'emotion',
  生气: 'emotion',
  悲伤: 'emotion',
  大哭: 'emotion',
  晕晕: 'emotion',
  阴暗: 'emotion',
  呆呆眼: 'emotion',
  闭眼口水: 'emotion',
  问号: 'emotion',
  感叹号: 'emotion',
  情绪花花: 'emotion',
  心跳: 'emotion',
  流汗: 'emotion',
  吐魂: 'emotion',

  // 眼镜（单槽：四副眼镜戴一副）
  圆眼镜: 'glasses',
  方眼镜: 'glasses',
  椭圆眼镜: 'glasses',
  墨镜: 'glasses',

  // 贴纸与帽子（可叠：各自的参数互不冲突）
  戴帽子: 'decor',
  兔兔贴纸: 'decor',
  猫猫贴纸: 'decor',
  蝴蝶结贴纸: 'decor',

  // 道具（单槽，且手部占用彼此冲突）
  奶茶: 'prop',
  猫球: 'prop',
  圆木桌: 'prop',
  举喇叭: 'prop',
  爆肝: 'prop',
  我会出手: 'prop',

  // 敲琴（单槽）：琴本身由「敲琴模式」控制，按键图案是上面那一叠短暂覆盖
  手敲琴: 'piano',
  A: 'key',
  S: 'key',
  D: 'key',
  W: 'key',
  1: 'key',
  左键: 'key',
  右键: 'key'
}

/** 可叠的通道；其余通道都是单槽（新的顶掉同通道的旧的） */
const STACKABLE: ReadonlySet<ExpressionChannel> = new Set<ExpressionChannel>(['decor'])

/**
 * 参数实测出来的互斥对：`举喇叭` 的 exp3 会把敲琴的参数清零（`ParamCheek33 = 0`、
 * `ParamCheek3 = 0`），两个一起挂上就是两套参数对打；语义上也是「要么举喇叭要么敲琴」。
 */
const EXCLUSIVE: Record<string, string[]> = {
  举喇叭: ['手敲琴'],
  手敲琴: ['举喇叭']
}

/** 写入顺序：越靠后越强。情绪压过配件，按键图案压过一切（它在最上层才有反馈感） */
const CHANNEL_ORDER: ExpressionChannel[] = [
  'decor',
  'glasses',
  'prop',
  'piano',
  'emotion',
  'key',
  'misc'
]

/** 「随机一个」不该抽到的通道：按键图案是敲琴的道具，抽出来只会让人以为游戏开始了 */
const NOT_RANDOM: ReadonlySet<ExpressionChannel> = new Set<ExpressionChannel>(['key', 'piano'])

interface Layer {
  name: string
  channel: ExpressionChannel
  def: ExpressionDef
  /** 到期时刻（performance.now 基准）；null = 常驻 */
  expiresAt: number | null
  /** 调用序号：同通道内后调用的赢，同时也是同通道叠加时的稳定排序 */
  seq: number
}

export class ExpressionDirector {
  private layers: Layer[] = []
  private seq = 0
  private readonly unknownWarned = new Set<string>()
  /**
   * 「加载中的那一次」的令牌：exp3 是异步取的，而这一层可能在取回来之前就被摘掉或清空了。
   * 没有这道闸，加载完的结果会自己插回去 —— 表现为「已经摘掉的表情又冒出来」，
   * 闲置醒来摘打盹脸时最容易撞上（那次摘除正好可能落在首次加载的窗口里）。
   * 同一个名字重新套一次也会换令牌，于是「后点的那次」赢，不会把旧时长插回来。
   */
  private readonly pending = new Map<string, number>()
  private token = 0

  constructor(private readonly defs: ExpressionDefs) {}

  /** 套一层。holdMs 省略 = 常驻（托盘的语义）；给了时长就到时候自己回落 */
  play(name: string, holdMs?: number): void {
    if (!this.defs.has(name)) {
      if (!this.unknownWarned.has(name)) {
        this.unknownWarned.add(name)
        console.warn(`[pet] 这个形象没有名为「${name}」的表情，已忽略`)
      }
      return
    }

    const seq = ++this.seq
    const token = ++this.token
    this.pending.set(name, token)
    void this.defs.load(name).then((def) => {
      // 加载期间被摘掉 / 清空 / 重新点了一次（令牌已经换人）：这次的结果作废
      if (!def || this.pending.get(name) !== token) return
      this.pending.delete(name)
      this.insert({
        name,
        channel: CHANNEL_OF[name] ?? 'misc',
        def,
        expiresAt: holdMs === undefined ? null : performance.now() + holdMs,
        seq
      })
    })
  }

  /** 已经生效就摘掉，否则常驻套上（托盘「试个表情」的勾选语义：再点一次取消） */
  toggle(name: string): void {
    if (this.isActive(name)) this.remove(name)
    else this.play(name)
  }

  /** 按名字摘掉一层；没挂着就是空操作 */
  remove(name: string): void {
    // 还在加载的那一次也要一起作废，否则它加载完会自己插回来
    this.pending.delete(name)
    const before = this.layers.length
    this.layers = this.layers.filter((layer) => layer.name !== name)
    if (this.layers.length !== before) console.info(`[pet] 已摘掉表情：${name}`)
  }

  /** 清掉所有层（回到默认脸） */
  clearAll(): void {
    // 先作废在途的加载：这一句必须在提前返回之前，此时可能一层都还没插上
    this.pending.clear()
    if (this.layers.length === 0) return
    this.layers = []
    console.info('[pet] 已清空所有表情层')
  }

  /** 随机抽一个常驻（托盘「随机一个」）：按键图案与敲琴不参与 */
  random(): void {
    const pool = this.defs.list().filter((name) => {
      const channel = CHANNEL_OF[name] ?? 'misc'
      return !NOT_RANDOM.has(channel)
    })
    if (pool.length === 0) return
    this.play(pool[Math.floor(Math.random() * pool.length)])
  }

  isActive(name: string): boolean {
    return this.layers.some((layer) => layer.name === name)
  }

  /** 当前生效的名字（可能有多个：叠加出来的组合）。顺带把到期的层清掉 */
  activeNames(): string[] {
    this.expire()
    return this.layers.map((layer) => layer.name)
  }

  /**
   * 每帧写参数。调用点必须在库的所有写入者之后（`beforeModelUpdate`），
   * 且在眨眼之前 —— 眨眼要按「当前睁眼度」做乘法修饰，所以它得看到这里写完的值。
   */
  applyFrame(core: ExpressionCore): void {
    this.expire()
    if (this.layers.length === 0) return

    // 同参数多层写到时，靠后的覆盖靠前的（通道优先级 + 同通道内的调用序）
    const writes = new Map<string, ExpressionParam>()
    for (const layer of this.ordered()) {
      for (const param of layer.def.params) {
        writes.set(param.id, param)
      }
    }

    for (const [id, param] of writes) {
      switch (param.blend) {
        case 'Overwrite':
          core.setParameterValueById(id, param.value)
          break
        case 'Multiply':
          core.setParameterValueById(id, core.getParameterValueById(id) * param.value)
          break
        default:
          core.setParameterValueById(id, core.getParameterValueById(id) + param.value)
      }
    }
  }

  /** 清掉到期的层；返回是否有变化 */
  private expire(): boolean {
    const now = performance.now()
    const kept = this.layers.filter((layer) => layer.expiresAt === null || layer.expiresAt > now)
    if (kept.length === this.layers.length) return false
    this.layers = kept
    return true
  }

  private insert(layer: Layer): void {
    // 同名：刷新时长而不是叠第二层（「奶茶」套两次还是同一杯）。
    // 但**常驻的不被续成限时**：拖动、点击、连点这些交互都会顺手重套同一个名字，照搬新时长
    // 就会把用户从托盘钉住的那张脸在一次点击之后悄悄放掉 —— 钉住是显式选择，而「续一下」
    // 多数时候只是路过的动作。反方向照常：限时的能被常驻覆盖（托盘一勾就把正在闪现的表情定住）。
    const previous = this.layers.find((item) => item.name === layer.name)
    const expiresAt = previous?.expiresAt === null ? null : layer.expiresAt
    this.layers = this.layers.filter((item) => item.name !== layer.name)

    // 互斥：举喇叭与敲琴是同一批参数的两套写法，只能留一个
    const conflicts = EXCLUSIVE[layer.name] ?? []
    if (conflicts.length > 0) {
      this.layers = this.layers.filter((item) => !conflicts.includes(item.name))
    }

    // 单槽通道：新的一层顶掉同通道里已经挂着的
    if (!STACKABLE.has(layer.channel)) {
      this.layers = this.layers.filter((item) => item.channel !== layer.channel)
    }

    this.layers.push({ ...layer, expiresAt })
    console.info(
      `[pet] 已套用表情：${layer.name}（${layer.channel}${expiresAt === null ? ' · 常驻' : ' · 限时'}）`
    )
  }

  private ordered(): Layer[] {
    const result: Layer[] = []
    for (const channel of CHANNEL_ORDER) {
      const inChannel = this.layers.filter((layer) => layer.channel === channel)
      inChannel.sort((a, b) => a.seq - b.seq)
      result.push(...inChannel)
    }
    return result
  }
}
