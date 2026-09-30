/**
 * 配置的加载与落盘（Node 侧）。
 * 纯逻辑（合并、校验、env 覆盖）都在 @shared/config 里，这里只负责 IO。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  applyEnvOverrides,
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  mergeConfig,
  type PetConfig
} from '@shared/config'
import { listModels, modelExists } from './models'

let cached: PetConfig | null = null

/**
 * 配置文件位置。默认放在 userData 下；
 * 设置环境变量 PET_CONFIG 可以指定任意路径（方便同时养好几只）。
 */
export function configPath(): string {
  const override = process.env.PET_CONFIG
  if (override && override.length > 0) return override
  return join(app.getPath('userData'), CONFIG_FILE_NAME)
}

export function loadConfig(options: { force?: boolean } = {}): PetConfig {
  if (cached && !options.force) return cached

  const path = configPath()
  let raw: unknown = null

  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8'))
    } catch (error) {
      console.error(`[config] ${path} 解析失败，本次使用默认配置：`, error)
    }
  } else {
    writeTemplateConfig(path)
  }

  cached = applyEnvOverrides(mergeConfig(DEFAULT_CONFIG, raw), process.env)
  return cached
}

/**
 * 把某一节配置写回磁盘上的文件（切换形象、托盘里的窗口开关、拖动落点都走这里）。
 *
 * 刻意从**磁盘上的原始文件**改，而不是改 cached 再整个写回：
 * cached 里已经混进了 PET_API_KEY 之类的环境变量覆盖，
 * 整个写回等于把用户刻意留在环境里的密钥固化到明文文件里。
 * 这里只动点名的那一节，其余内容（包括 _readme）原样保留。
 */
function patchConfig(
  section: 'model' | 'window' | 'assist',
  patch: Record<string, unknown>
): PetConfig {
  const path = configPath()
  const raw = readRawConfig() ?? {}

  const current = raw[section]
  raw[section] = {
    ...(typeof current === 'object' && current !== null && !Array.isArray(current) ? current : {}),
    ...patch
  }

  const tmp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    // 和对话历史一样先写 .tmp 再 rename：写到一半崩溃也不会留下半个 JSON
    // （这个文件坏了会连带丢掉用户的 _readme 与自定义字段）
    writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8')
    renameSync(tmp, path)
  } catch (error) {
    // 写不进去也不影响本次生效，只是下次启动会回到旧值
    console.error(`[config] 写入 ${path} 失败，本次改动不会持久化：`, error)
  }

  return loadConfig({ force: true })
}

/** 切换形象：把 model.path 与待机动作组写回（托盘「切换形象」用） */
export function updateModelSelection(patch: { path: string; idleMotionGroup: string }): PetConfig {
  return patchConfig('model', patch)
}

/**
 * 窗口设置写回：托盘的「始终置顶 / 点击穿透」，以及拖动结束后的窗口落点。
 * 这些是用户在自己机器上的长期偏好，和「切换形象」同类，没理由重启就忘。
 */
export function updateWindowSettings(patch: {
  alwaysOnTop?: boolean
  clickThrough?: boolean
  x?: number
  y?: number
}): PetConfig {
  return patchConfig('window', patch)
}

/**
 * 小助手设置写回：托盘上那两个开关（主动说话、系统事件）走这里。
 *
 * 快捷键刻意不做成菜单项 —— 在菜单里输入一串 accelerator 不如直接编辑配置文件清楚，
 * 而且它只在启动时注册一次（改完要重启，这一点写在配置模板的说明里）。
 */
export function updateAssistSettings(patch: {
  companion?: boolean
  systemEvents?: boolean
  smalltalk?: boolean
}): PetConfig {
  return patchConfig('assist', patch)
}

/**
 * 配置指向的形象不存在时，改指到一个确实存在的形象并写回。
 *
 * 这不是防御性编程，是在补一个必然会踩的坑：形象清单是**扫目录**得到的，删掉一个模型目录之后，
 * 配置文件里还留着那个路径。不修的话启动后托盘里是一组**全都没勾选**的单选项，用户不知道该点哪个，
 * 窗口上则是一句「模型文件不存在」—— 而这是应用自己造成的状态。
 *
 * 只在启动时调用一次。`loadConfig()` 会被很多地方调用（包括每次「重新加载形象」），
 * 把写文件塞进它会让一个本该只读的函数带上副作用。
 */
export function repairModelSelection(): void {
  // 还没有配置文件时什么都别做：写回会把 loadConfig 生成「带说明的模板」这一步顶掉，
  // 用户拿到的就是一份只有 model 一节的残文件。
  if (!existsSync(configPath())) return

  // 文件存在但坏了也不动它：拿一个残缺对象去覆盖，等于把用户可能还想抢救的内容抹掉。
  // loadConfig 会照常打日志并退回默认值。
  const raw = readRawConfig()
  if (raw === null) return

  const stored = modelPathFrom(raw)
  if (stored && modelExists(stored)) return

  const models = listModels()
  if (models.length === 0) {
    if (stored) {
      console.warn(`[config] 配置里的形象不存在（${stored}），模型目录里也没有可用的模型`)
    }
    return
  }

  // 优先回到内置默认形象，其次才是目录里的第一个：目录是排序过的，
  // 「第一个」会随用户往里丢东西而变，不如默认值稳定。
  const fallback = models.find((model) => model.path === DEFAULT_CONFIG.model.path) ?? models[0]
  console.warn(
    `[config] 配置里的形象${stored ? `不存在（${stored}）` : '未指定'}，改用「${fallback.name}」`
  )
  updateModelSelection({ path: fallback.path, idleMotionGroup: fallback.idleMotionGroup })
}

/**
 * 读磁盘上的原始配置对象。
 *
 * 三种结果要分得开，调用方的处理完全不同：
 *  - 文件不存在 → `{}`（首次启动，照常生成模板）
 *  - 解析成功   → 解析结果
 *  - 解析失败   → `null`（别拿它去覆盖用户的文件）
 */
function readRawConfig(): Record<string, unknown> | null {
  const path = configPath()
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    console.error(`[config] ${path} 的顶层不是对象，本次使用默认配置`)
  } catch (error) {
    // 文件坏了也要能切换模型：当成空文件重建，好过让托盘点了没反应
    console.error(`[config] ${path} 解析失败：`, error)
  }
  return null
}

/** 原始配置里写的 model.path；没写或不是字符串则返回 null */
function modelPathFrom(raw: Record<string, unknown>): string | null {
  const model = raw.model
  if (typeof model !== 'object' || model === null || Array.isArray(model)) return null
  const value = (model as Record<string, unknown>).path
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 首次启动时生成一份带说明的配置文件，方便用户直接改 */
function writeTemplateConfig(path: string): void {
  const template = {
    _readme: [
      'AI 桌宠配置文件。改完保存后，可从托盘菜单点「重新加载形象」生效。',
      'API Key 建议用环境变量 PET_API_KEY 注入，不要写在这个文件里。',
      `model.path 相对于 src/renderer/public/models/，例如 ${DEFAULT_CONFIG.model.path}`,
      'model.hiddenParts 填部件 id（如 "Part12"）可以遮掉形象上的配件（翅膀、耳朵、帽子…），只影响显示。',
      'model.path 与 window.x/y 由托盘操作自动写回（切换形象 / 拖动形象），一般不用手改；window.x/y 为 null 表示交给系统摆位置。'
    ],
    ...DEFAULT_CONFIG
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(template, null, 2)}\n`, 'utf-8')
    console.log(`[config] 已生成默认配置文件：${path}`)
  } catch (error) {
    console.error(`[config] 写入默认配置失败（将仅使用内存中的默认值）：`, error)
  }
}
