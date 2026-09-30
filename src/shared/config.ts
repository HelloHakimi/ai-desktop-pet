/**
 * 配置的类型定义、默认值与纯函数合并逻辑。
 *
 * 这个文件会被主进程和渲染进程同时引用，因此**不允许**出现 Node API（fs / process）
 * 或 DOM API —— 所有 IO 与 env 读取都在 src/main/config.ts 里完成。
 */

/** 形象渲染模式：auto = 有 Live2D 资源就用，否则降级；live2d = 强制 Live2D；placeholder = 强制占位形象 */
export type ModelMode = 'auto' | 'live2d' | 'placeholder'

export interface WindowConfig {
  /** 窗口宽度（逻辑像素） */
  width: number
  /** 窗口高度（逻辑像素） */
  height: number
  /**
   * 窗口左上角坐标；null = 交给系统摆放。
   * 拖动形象之后由主进程写回，下次启动就摆回原处（落在已经拔掉的显示器上时会忽略）。
   */
  x: number | null
  y: number | null
  /** 是否始终置顶 */
  alwaysOnTop: boolean
  /** 是否开启点击穿透：鼠标不在形象上时，事件透传给桌面 */
  clickThrough: boolean
  /** macOS 下是否隐藏 Dock 图标（桌宠通常隐藏，仅保留托盘） */
  hideDockIcon: boolean
  /** 形象缩放系数，1 = 自适应铺满窗口 */
  modelScale: number
}

export interface ModelConfig {
  mode: ModelMode
  /** model3.json 相对于 src/renderer/public/models/ 的路径 */
  path: string
  /** 待机动作组名，留空则不做处理 */
  idleMotionGroup: string
  /** 是否让形象的目光/头部跟随鼠标（由渲染层自己驱动，见 Live2DRenderer.lookAt） */
  autoInteract: boolean
  /**
   * 要遮掉的部件 id（Live2D 的 Part id，如 "Part12"），用来去掉形象上不想要的配件。
   * 只影响显示：模型文件本身不动，改回来就能恢复。取哪些 id 见 README「遮掉某个部件」。
   */
  hiddenParts: string[]
}

export interface AIConfig {
  /** Provider 类型，目前支持 'openai-compatible' */
  provider: string
  /** 兼容 OpenAI 协议的 baseUrl，注意通常需要带 /v1 */
  baseUrl: string
  /** API Key，建议用环境变量 PET_API_KEY 注入，不要写进仓库 */
  apiKey: string
  model: string
  systemPrompt: string
  /** 发给模型的上文条数上限（user + assistant 合计，不含 systemPrompt）；存盘与展示不受它影响 */
  contextLimit: number
  temperature: number
  maxTokens: number
  timeoutMs: number
}

export interface AssistConfig {
  /**
   * 全局快捷键：把刚复制的那段文字交给桌宠处理（翻译 / 解释报错 / 摘要）。
   * 空字符串 = 不注册，功能关闭。用 Electron 的 accelerator 写法。
   */
  shortcut: string
  /**
   * 剪贴板历史保留条数。
   * 这些内容**只存内存**（见 src/main/clipboard-watch.ts），没有落盘开关 ——
   * 剪贴板里经常是密码和 token，不该给「要不要写进磁盘」留一个可能被写错的选择。
   */
  clipboardHistory: number
  /** 专注时长预设（分钟），托盘据此列出可选项 */
  focusPresets: number[]
  /** 主动说话：久坐提醒、深夜问候。默认开，但触发条件很克制 */
  companion: boolean
  /** 系统事件拟人化：拔插电源、断网时说一句。默认开，同样克制 */
  systemEvents: boolean
  /**
   * 闲聊：碎碎念（含睡着的梦话）、打招呼、每日彩蛋、陪玩的主动邀请。默认开。
   *
   * 陪玩本身（你说「猜数字」「哭一个」才开局的那些）不看这个开关 —— 那是你主动叫它，
   * 这里管的是它自己开口的那一半。
   */
  smalltalk: boolean
}

export interface PetConfig {
  window: WindowConfig
  model: ModelConfig
  ai: AIConfig
  assist: AssistConfig
}

/** 渲染进程只需要窗口与形象配置，AI 配置（含 Key）不下发到渲染层 */
export interface RendererConfig {
  window: WindowConfig
  model: ModelConfig
}

export const CONFIG_FILE_NAME = 'pet.config.json'

/** hiddenParts 的条数上限：一个形象不可能有这么多部件，写多了只会是配置写错 */
const MAX_HIDDEN_PARTS = 50

export const DEFAULT_CONFIG: PetConfig = {
  window: {
    width: 320,
    height: 460,
    x: null,
    y: null,
    alwaysOnTop: true,
    clickThrough: true,
    hideDockIcon: true,
    modelScale: 1
  },
  model: {
    mode: 'auto',
    path: 'qpet-a/A_Qpet_90.model3.json',
    idleMotionGroup: 'Idle',
    autoInteract: true,
    hiddenParts: []
  },
  ai: {
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    systemPrompt: '你是一只住在用户桌面上的小宠物，说话简短、俏皮、有温度，每次回复不超过两句话。',
    contextLimit: 20,
    temperature: 0.8,
    maxTokens: 512,
    timeoutMs: 30_000
  },
  assist: {
    // 跟已有的 ⌥⌘+← 凑成一对方向键，避开各应用里常用的字母组合
    shortcut: 'Alt+Command+Up',
    clipboardHistory: 8,
    focusPresets: [25, 45, 60],
    companion: true,
    systemEvents: true,
    smalltalk: true
  }
}

type Raw = Record<string, unknown>

const isObject = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function readString(source: Raw, key: string, fallback: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : fallback
}

function readNumber(source: Raw, key: string, fallback: number): number {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readBoolean(source: Raw, key: string, fallback: boolean): boolean {
  const value = source[key]
  return typeof value === 'boolean' ? value : fallback
}

/** 坐标：写成数字才认，其余（null / 字符串 / 缺失）一律当成「没记住」，交给系统摆放 */
function readPosition(source: Raw, key: string): number | null {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

/** 字符串数组：非数组、非字符串的项都会被丢掉，空串也丢掉（配置里写了个空名字是最常见的笔误） */
function readStringArray(source: Raw, key: string, fallback: string[]): string[] {
  const value = source[key]
  if (!Array.isArray(value)) return fallback
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, MAX_HIDDEN_PARTS)
}

/**
 * 数字数组（专注时长预设用）：非数字项丢掉，按分钟数夹到合理区间。
 * 全被丢光就退回默认值 —— 空数组意味着托盘里一个可选项都没有，那比用默认值更糟。
 */
function readNumberArray(
  source: Raw,
  key: string,
  fallback: number[],
  min: number,
  max: number
): number[] {
  const value = source[key]
  if (!Array.isArray(value)) return fallback
  const numbers = value
    .filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    .map((item) => Math.round(clamp(item, min, max)))
  return numbers.length > 0 ? numbers : fallback
}

function readEnum<T extends string>(
  source: Raw,
  key: string,
  allowed: readonly T[],
  fallback: T
): T {
  const value = source[key]
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function section(raw: Raw, key: string): Raw {
  const value = raw[key]
  return isObject(value) ? value : {}
}

/**
 * 把用户配置文件的内容合并到默认配置上。
 * 逐字段校验类型：写错的字段会被忽略并回退默认值，而不是让整个应用崩掉。
 */
export function mergeConfig(base: PetConfig, raw: unknown): PetConfig {
  const root: Raw = isObject(raw) ? raw : {}
  const win = section(root, 'window')
  const model = section(root, 'model')
  const ai = section(root, 'ai')
  const assist = section(root, 'assist')

  return {
    window: {
      width: clamp(readNumber(win, 'width', base.window.width), 120, 4000),
      height: clamp(readNumber(win, 'height', base.window.height), 120, 4000),
      x: readPosition(win, 'x'),
      y: readPosition(win, 'y'),
      alwaysOnTop: readBoolean(win, 'alwaysOnTop', base.window.alwaysOnTop),
      clickThrough: readBoolean(win, 'clickThrough', base.window.clickThrough),
      hideDockIcon: readBoolean(win, 'hideDockIcon', base.window.hideDockIcon),
      modelScale: clamp(readNumber(win, 'modelScale', base.window.modelScale), 0.1, 5)
    },
    model: {
      mode: readEnum(model, 'mode', ['auto', 'live2d', 'placeholder'] as const, base.model.mode),
      path: readString(model, 'path', base.model.path),
      idleMotionGroup: readString(model, 'idleMotionGroup', base.model.idleMotionGroup),
      autoInteract: readBoolean(model, 'autoInteract', base.model.autoInteract),
      hiddenParts: readStringArray(model, 'hiddenParts', base.model.hiddenParts)
    },
    ai: {
      provider: readString(ai, 'provider', base.ai.provider),
      baseUrl: readString(ai, 'baseUrl', base.ai.baseUrl),
      apiKey: readString(ai, 'apiKey', base.ai.apiKey),
      model: readString(ai, 'model', base.ai.model),
      systemPrompt: readString(ai, 'systemPrompt', base.ai.systemPrompt),
      contextLimit: clamp(readNumber(ai, 'contextLimit', base.ai.contextLimit), 2, 100),
      temperature: clamp(readNumber(ai, 'temperature', base.ai.temperature), 0, 2),
      maxTokens: clamp(readNumber(ai, 'maxTokens', base.ai.maxTokens), 1, 200_000),
      timeoutMs: clamp(readNumber(ai, 'timeoutMs', base.ai.timeoutMs), 1000, 600_000)
    },
    assist: {
      // 不做名字校验：accelerator 的合法写法由 Electron 说了算，
      // 这里管不了，注册失败时主进程会打日志（见 index.ts）
      shortcut: readString(assist, 'shortcut', base.assist.shortcut).trim(),
      clipboardHistory: Math.round(
        clamp(readNumber(assist, 'clipboardHistory', base.assist.clipboardHistory), 1, 50)
      ),
      focusPresets: readNumberArray(assist, 'focusPresets', base.assist.focusPresets, 1, 600),
      companion: readBoolean(assist, 'companion', base.assist.companion),
      systemEvents: readBoolean(assist, 'systemEvents', base.assist.systemEvents),
      smalltalk: readBoolean(assist, 'smalltalk', base.assist.smalltalk)
    }
  }
}

/**
 * 环境变量覆盖，优先级高于配置文件 —— 便于不把 Key 写进任何文件。
 * 传入 env 而不是直接读 process.env，保证这个函数是纯函数、可测试。
 */
export function applyEnvOverrides(
  config: PetConfig,
  env: Record<string, string | undefined>
): PetConfig {
  const apiKey = env.PET_API_KEY ?? env.OPENAI_API_KEY
  const baseUrl = env.PET_BASE_URL ?? env.OPENAI_BASE_URL
  const model = env.PET_MODEL

  return {
    ...config,
    ai: {
      ...config.ai,
      apiKey: apiKey && apiKey.length > 0 ? apiKey : config.ai.apiKey,
      baseUrl: baseUrl && baseUrl.length > 0 ? baseUrl : config.ai.baseUrl,
      model: model && model.length > 0 ? model : config.ai.model
    }
  }
}

/** 剥离 AI 配置后再下发给渲染进程 */
export function toRendererConfig(config: PetConfig): RendererConfig {
  // hiddenParts 是数组：浅拷贝会让渲染层与主进程共用同一个引用，这里一并复制一份
  return {
    window: { ...config.window },
    model: { ...config.model, hiddenParts: [...config.model.hiddenParts] }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
