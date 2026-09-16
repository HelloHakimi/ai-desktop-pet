/**
 * 配置的加载与落盘（Node 侧）。
 * 纯逻辑（合并、校验、env 覆盖）都在 @shared/config 里，这里只负责 IO。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  applyEnvOverrides,
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  mergeConfig,
  type PetConfig
} from '@shared/config'

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

/** 首次启动时生成一份带说明的配置文件，方便用户直接改 */
function writeTemplateConfig(path: string): void {
  const template = {
    _readme: [
      'AI 桌宠配置文件。改完保存后，可从托盘菜单点「重新加载形象」生效。',
      'API Key 建议用环境变量 PET_API_KEY 注入，不要写在这个文件里。',
      'model.path 相对于 src/renderer/public/models/，例如 blue-cat/Blue cat.model3.json'
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
