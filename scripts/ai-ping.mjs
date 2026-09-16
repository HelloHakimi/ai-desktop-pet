#!/usr/bin/env node
/**
 * 对话连通性自检：不启动 Electron，直接用配置里的 OpenAI 兼容端点发一条消息。
 * 用来把「Key / baseUrl / 模型名」这三件事和桌宠本身解耦验证 —— 出问题时能立刻定位到底是
 * 配置不对，还是桌宠的 UI 有问题。
 *
 * 用法：
 *   npm run ai:ping
 *   npm run ai:ping -- --prompt "用一句话夸我"
 *   PET_CONFIG=./pet.config.json npm run ai:ping
 *
 * 配置来源与主进程一致：默认读 userData 下的 pet.config.json，
 * 环境变量 PET_API_KEY / PET_BASE_URL / PET_MODEL 优先级更高。
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const APP_NAME = 'ai-desktop-pet'

/** 与 Electron 的 app.getPath('userData') 保持一致的平台约定 */
function defaultConfigPath() {
  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', APP_NAME, 'pet.config.json')
    case 'win32':
      return join(process.env.APPDATA ?? homedir(), APP_NAME, 'pet.config.json')
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), APP_NAME, 'pet.config.json')
  }
}

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const configPath = resolve(process.env.PET_CONFIG ?? argValue('--config') ?? defaultConfigPath())
const prompt = argValue('--prompt') ?? '你好，请用一句话介绍你自己。'

let fileConfig = {}
try {
  fileConfig = JSON.parse(await readFile(configPath, 'utf-8'))
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error(`读取配置失败：${configPath}\n${error.message}`)
    process.exit(1)
  }
  console.warn(`配置文件不存在，仅使用环境变量：${configPath}`)
}

const ai = { ...(fileConfig.ai ?? {}) }
ai.apiKey = process.env.PET_API_KEY ?? process.env.OPENAI_API_KEY ?? ai.apiKey ?? ''
ai.baseUrl = process.env.PET_BASE_URL ?? process.env.OPENAI_BASE_URL ?? ai.baseUrl ?? ''
ai.model = process.env.PET_MODEL ?? ai.model ?? ''

if (!ai.apiKey) {
  console.error('缺少 API Key：设置 PET_API_KEY 环境变量，或写入配置文件的 ai.apiKey')
  process.exit(1)
}

const endpoint = `${String(ai.baseUrl).replace(/\/+$/, '')}/chat/completions`
console.log('配置来源：', configPath)
console.log('endpoint：', endpoint)
console.log('model：   ', ai.model)
console.log('apiKey：  ', mask(ai.apiKey))
console.log('prompt：  ', prompt)
console.log('---')

const started = Date.now()
let response
try {
  response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ai.apiKey}`
    },
    body: JSON.stringify({
      model: ai.model,
      messages: [
        { role: 'system', content: ai.systemPrompt ?? '你是一只桌面宠物。' },
        { role: 'user', content: prompt }
      ],
      temperature: ai.temperature ?? 0.8,
      max_tokens: ai.maxTokens ?? 512,
      stream: false
    }),
    signal: AbortSignal.timeout(ai.timeoutMs ?? 30_000)
  })
} catch (error) {
  console.error(`请求失败：${error instanceof Error ? error.message : error}`)
  process.exit(1)
}

const text = await response.text()
const elapsed = Date.now() - started

if (!response.ok) {
  console.error(`HTTP ${response.status} ${response.statusText}（${elapsed} ms）`)
  console.error(text.slice(0, 800))
  process.exit(1)
}

let data
try {
  data = JSON.parse(text)
} catch {
  console.error(`响应不是合法 JSON（${elapsed} ms）：`)
  console.error(text.slice(0, 800))
  process.exit(1)
}

const content = data.choices?.[0]?.message?.content
if (typeof content !== 'string') {
  console.error('响应结构异常，未取到 choices[0].message.content：')
  console.error(JSON.stringify(data, null, 2).slice(0, 800))
  process.exit(1)
}

console.log(`✅ 连通正常（${elapsed} ms，模型 ${data.model ?? ai.model}）`)
console.log('桌宠回复：', content)
if (data.usage) {
  console.log('token 用量：', JSON.stringify(data.usage))
}

function mask(key) {
  const text = String(key)
  if (text.length <= 8) return '*'.repeat(text.length)
  return `${text.slice(0, 4)}${'*'.repeat(Math.min(text.length - 8, 12))}${text.slice(-4)}`
}
