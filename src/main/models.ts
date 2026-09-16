/**
 * 形象清单的发现。
 *
 * 刻意做成「扫目录」而不是在代码里写死一份列表：
 * 模型是美术资产，用户随时可能自己丢一个进来。写死列表意味着加模型要改代码、重新构建、重新打包，
 * 而扫目录只要把文件夹放进 models/ 就能在托盘里看到（把 application 目录视为可写的代价是零）。
 *
 * 每个模型目录里可以放一份 pet-model.json 来指定显示名与待机动作组；
 * 没有也能用 —— 目录名就是显示名，待机动作组走默认值。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface PetModel {
  /** 目录名，稳定标识 */
  id: string
  /** 托盘里显示的名字 */
  name: string
  /** model3.json 相对 models/ 的路径（写进 config.model.path） */
  path: string
  /** 待机动作组名，空字符串表示这个模型没有待机动作 */
  idleMotionGroup: string
}

const MANIFEST = 'pet-model.json'
const DEFAULT_IDLE_GROUP = 'Idle'

/**
 * 模型根目录。
 *
 * 两种运行方式下渲染层读的根本不是同一个目录，这里必须跟着走：
 *  - 开发：渲染层由 Vite dev server 提供，模型来自源码目录 src/renderer/public/models。
 *    此时 out/renderer/models 只是上一次 build 的残影，扫它会得到过期的清单
 *    （表现为新加的模型渲染层明明能加载，托盘里却看不见）。
 *  - 打包：主进程与渲染层都在 out/ 下相邻，且 asar 是关掉的，所以是真实目录。
 */
export function modelsRoot(): string {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    return join(__dirname, '../../src/renderer/public/models')
  }
  return join(__dirname, '../renderer/models')
}

function readManifest(dir: string): { name?: string; idleMotionGroup?: string } {
  const path = join(dir, MANIFEST)
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const raw = parsed as Record<string, unknown>
    return {
      name: typeof raw.name === 'string' ? raw.name : undefined,
      idleMotionGroup:
        typeof raw.idleMotionGroup === 'string' ? raw.idleMotionGroup : undefined
    }
  } catch (error) {
    // 清单写坏了不该让整个托盘菜单挂掉，退回目录名即可
    console.warn(`[models] ${path} 解析失败，改用目录名：`, error)
    return {}
  }
}

/** 找出目录顶层唯一的 model3.json（子目录里的是素材，不算入口） */
function findEntry(dir: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  const candidates = entries.filter((name) => name.endsWith('.model3.json')).sort()
  if (candidates.length === 0) return null
  if (candidates.length > 1) {
    console.warn(`[models] ${dir} 下有多个 model3.json，取第一个：${candidates[0]}`)
  }
  return candidates[0]
}

/**
 * 扫描模型目录。读不动的目录会被跳过而不是抛出 ——
 * 托盘菜单构建失败会让整个应用没法操作（没有 Dock 图标，托盘是唯一入口）。
 */
export function listModels(): PetModel[] {
  const root = modelsRoot()
  if (!existsSync(root)) {
    console.warn(`[models] 模型目录不存在：${root}`)
    return []
  }

  const models: PetModel[] = []
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }

    const entry = findEntry(dir)
    if (!entry) continue

    const manifest = readManifest(dir)
    models.push({
      id: name,
      name: manifest.name ?? name,
      path: `${name}/${entry}`,
      idleMotionGroup: manifest.idleMotionGroup ?? DEFAULT_IDLE_GROUP
    })
  }

  return models
}
