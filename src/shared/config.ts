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
  /** 是否让模型自动跟随鼠标 */
  autoInteract: boolean
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
  temperature: number
  maxTokens: number
  timeoutMs: number
}

export interface PetConfig {
  window: WindowConfig
  model: ModelConfig
  ai: AIConfig
}

/** 渲染进程只需要窗口与形象配置，AI 配置（含 Key）不下发到渲染层 */
export interface RendererConfig {
  window: WindowConfig
  model: ModelConfig
}

export const CONFIG_FILE_NAME = 'pet.config.json'

export const DEFAULT_CONFIG: PetConfig = {
  window: {
    width: 320,
    height: 460,
    alwaysOnTop: true,
    clickThrough: true,
    hideDockIcon: true,
    modelScale: 1
  },
  model: {
    mode: 'auto',
    path: 'blue-cat/Blue cat.model3.json',
    idleMotionGroup: 'Idle',
    autoInteract: true
  },
  ai: {
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    systemPrompt: '你是一只住在用户桌面上的小宠物，说话简短、俏皮、有温度，每次回复不超过两句话。',
    temperature: 0.8,
    maxTokens: 512,
    timeoutMs: 30_000
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

  return {
    window: {
      width: clamp(readNumber(win, 'width', base.window.width), 120, 4000),
      height: clamp(readNumber(win, 'height', base.window.height), 120, 4000),
      alwaysOnTop: readBoolean(win, 'alwaysOnTop', base.window.alwaysOnTop),
      clickThrough: readBoolean(win, 'clickThrough', base.window.clickThrough),
      hideDockIcon: readBoolean(win, 'hideDockIcon', base.window.hideDockIcon),
      modelScale: clamp(readNumber(win, 'modelScale', base.window.modelScale), 0.1, 5)
    },
    model: {
      mode: readEnum(model, 'mode', ['auto', 'live2d', 'placeholder'] as const, base.model.mode),
      path: readString(model, 'path', base.model.path),
      idleMotionGroup: readString(model, 'idleMotionGroup', base.model.idleMotionGroup),
      autoInteract: readBoolean(model, 'autoInteract', base.model.autoInteract)
    },
    ai: {
      provider: readString(ai, 'provider', base.ai.provider),
      baseUrl: readString(ai, 'baseUrl', base.ai.baseUrl),
      apiKey: readString(ai, 'apiKey', base.ai.apiKey),
      model: readString(ai, 'model', base.ai.model),
      systemPrompt: readString(ai, 'systemPrompt', base.ai.systemPrompt),
      temperature: clamp(readNumber(ai, 'temperature', base.ai.temperature), 0, 2),
      maxTokens: clamp(readNumber(ai, 'maxTokens', base.ai.maxTokens), 1, 200_000),
      timeoutMs: clamp(readNumber(ai, 'timeoutMs', base.ai.timeoutMs), 1000, 600_000)
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
  return { window: { ...config.window }, model: { ...config.model } }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
