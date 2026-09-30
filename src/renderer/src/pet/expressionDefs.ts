/**
 * 表情定义的加载：把 model3.json 的「名字 → 文件」和 exp3.json 的「参数 → 值」读进来。
 *
 * 为什么不用库的 `model.expression(name)`？
 * 库的表情是**单槽**的（一个 currentExpression，新的顶掉旧的）。而这个模型里 40 个表情的
 * 参数绝大多数互不重叠（`ParamCheek70` 是圆眼镜、`Cheek44` 是帽子、`Cheek16` 是星星眼、
 * `naicha` 是奶茶……），单槽等于白白丢掉「墨镜 + 奶茶 + 生气脸」这种组合。
 * 自己读参数、自己每帧写，才能按层叠加 —— 代价是库自带的淡入淡出享受不到了
 * （当前选择是不做过渡，见 expressionDirector 里的说明）。
 *
 * 参数一律按 `Blend` 字段解释，缺省 Add：实测这个模型的 40 个表情全部标的是 `"Blend": "Add"`，
 * 值与基准值相加才是它们的设计语义（`晕晕` 的 `ParamEyeLOpen = -0.5` 是「闭一半」而不是
 * 「把睁眼度设成 -0.5」）。照抄 Blend 才能让「试个表情」和以前点出来的一模一样。
 */
import type { ExpressionCore } from './expressionDirector'

export interface ExpressionEntry {
  /** model3.json 里登记的 `Name`（渲染层按这个名字找），原样透传不做美化 */
  name: string
  /** 相对模型目录的 exp3 文件名，出错时用来定位 */
  file: string
}

export type ExpressionBlend = 'Add' | 'Multiply' | 'Overwrite'

export interface ExpressionParam {
  id: string
  value: number
  blend: ExpressionBlend
}

export interface ExpressionDef {
  name: string
  params: ExpressionParam[]
}

/** 名字或文件缺一个就取不到这个表情，这种脏数据在加载阶段就丢掉 */
export function parseExpressionEntries(raw: unknown): ExpressionEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const item = entry as Record<string, unknown>
    if (typeof item.Name !== 'string' || typeof item.File !== 'string') return []
    return [{ name: item.Name, file: item.File }]
  })
}

/** 参数名不存在时只在控制台说一次：一个形象里错一个名字会每帧刷屏 */
const missingParams = new Set<string>()

export class ExpressionDefs {
  private readonly cache = new Map<string, ExpressionDef>()
  private readonly pending = new Map<string, Promise<ExpressionDef | null>>()
  private readonly names: Set<string>

  /**
   * @param entries model3.json 里登记的表情清单
   * @param baseUrl 模型目录的 URL（exp3 是相对 model3.json 的同级文件）
   * @param core 用来判断参数在当前模型上是否存在
   */
  constructor(
    private readonly entries: ExpressionEntry[],
    private readonly baseUrl: string,
    private readonly core: ExpressionCore
  ) {
    this.names = new Set(entries.map((entry) => entry.name))
  }

  list(): string[] {
    return this.entries.map((entry) => entry.name)
  }

  has(name: string): boolean {
    return this.names.has(name)
  }

  /**
   * 取一个表情的参数表。**只缓存成功的结果**：失败（网络抖动、文件刚好没就绪）不写进缓存，
   * 下次再点还会重试 —— 把一次失败记死会让这个表情永远点不出来，而重试的代价只是一次请求。
   */
  async load(name: string): Promise<ExpressionDef | null> {
    const cached = this.cache.get(name)
    if (cached) return cached

    const inFlight = this.pending.get(name)
    if (inFlight) return inFlight

    const entry = this.entries.find((item) => item.name === name)
    if (!entry) return null

    const task = this.fetchDef(name, entry.file).finally(() => {
      this.pending.delete(name)
    })
    this.pending.set(name, task)
    return task
  }

  private async fetchDef(name: string, file: string): Promise<ExpressionDef | null> {
    const url = `${this.baseUrl}${encodeURI(file)}`
    try {
      const response = await fetch(url, { cache: 'no-store' })
      if (!response.ok) {
        console.warn(`[pet] 表情文件读取失败（HTTP ${response.status}）：${url}`)
        return null
      }
      const raw: unknown = await response.json()
      if (typeof raw !== 'object' || raw === null) return null
      const params = this.parseParams((raw as Record<string, unknown>).Parameters)
      if (params.length === 0) {
        console.warn(`[pet] 表情「${name}」没有任何可用参数：${url}`)
        return null
      }
      const def: ExpressionDef = { name, params }
      this.cache.set(name, def)
      return def
    } catch (error) {
      console.warn(`[pet] 表情文件解析失败（${url}）：`, error)
      return null
    }
  }

  private parseParams(raw: unknown): ExpressionParam[] {
    if (!Array.isArray(raw)) return []
    return raw.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return []
      const param = item as Record<string, unknown>
      const id = param.Id
      const value = param.Value
      if (typeof id !== 'string' || typeof value !== 'number' || !Number.isFinite(value)) return []
      // 参数在当前模型上不存在就跳过：库里按名字查索引拿到 -1 的话，
      // 读回来是 NaN、写进去是无声的无效操作，不如在这里就断掉这条路
      if (this.core.getParameterIndex(id) < 0) {
        if (!missingParams.has(id)) {
          missingParams.add(id)
          console.warn(`[pet] 表情参数在当前模型上不存在，已跳过：${id}`)
        }
        return []
      }
      return [{ id, value, blend: readBlend(param.Blend) }]
    })
  }
}

function readBlend(raw: unknown): ExpressionBlend {
  if (raw === 'Multiply' || raw === 'Overwrite') return raw
  // 缺省是 Add：Cubism 表达式动作的默认混合模式，也是这个模型所有表情显式写的那个值
  return 'Add'
}
