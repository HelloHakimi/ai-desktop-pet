#!/usr/bin/env node
/**
 * 下载 Live2D Cubism Core（Web 版 SDK 的运行时核心）。
 *
 * 为什么用脚本下载而不是直接放进仓库：
 * Cubism Core 由 Live2D 官方单独分发，有独立的许可条款（不可作为独立文件再分发）。
 * 它适合由使用者在本地按官方条款获取，因此仓库里只保留这个下载脚本，产物已加入 .gitignore。
 *
 * 用法：
 *   npm run setup:live2d            已有则跳过
 *   npm run setup:live2d -- --force 强制重新下载
 *
 * 注意：下载/使用 Cubism Core 即表示你接受 Live2D 的许可条款：
 *   https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_cn.html
 */
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = join(ROOT, 'src/renderer/public/vendor/live2dcubismcore.min.js')
const SOURCE =
  process.env.CUBISM_CORE_URL ??
  'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js'

const force = process.argv.includes('--force')

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

if (!force && (await exists(TARGET))) {
  console.log(`Cubism Core 已存在，跳过下载：${relative(ROOT, TARGET)}`)
  console.log('如需重新下载，加上 --force')
  process.exit(0)
}

console.log(`正在下载 Cubism Core：${SOURCE}`)

let response
try {
  response = await fetch(SOURCE)
} catch (error) {
  console.error(`下载失败（网络错误）：${error instanceof Error ? error.message : error}`)
  process.exit(1)
}

if (!response.ok) {
  console.error(`下载失败：HTTP ${response.status} ${response.statusText}`)
  process.exit(1)
}

const source = await response.text()
// 内容校验：防止公司网络返回一个登录页/错误页却被当成 SDK 写进项目
if (!source.includes('Live2DCubismCore')) {
  console.error('下载内容校验失败：文件里没有 Live2DCubismCore 标识，可能被网关劫持了')
  process.exit(1)
}

await mkdir(dirname(TARGET), { recursive: true })
await writeFile(TARGET, source, 'utf-8')

console.log(`已写入：${relative(ROOT, TARGET)}（${(source.length / 1024).toFixed(0)} KB）`)
console.log('')
console.log('下一步：把 Live2D 模型（.model3.json / .moc3 / 贴图）放进 src/renderer/public/models/<名称>/，')
console.log('然后在配置文件里设置 model.path 为 "<名称>/<文件>.model3.json"。')
