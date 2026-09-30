#!/usr/bin/env node
/**
 * 假的 OpenAI 兼容端点：不联网、不花 token，用来端到端验证对话链路。
 *
 *   npm run ai:fake
 *   PET_BASE_URL=http://127.0.0.1:8787/v1 PET_API_KEY=fake npm run dev
 *
 * 行为按用户消息里的关键词分支：
 *   SLOW   -> 每 250ms 吐一小段，共 20 段（验证「停止」与流式中间态）
 *   LONG   -> 一把吐 30 段（约 91 字，验证气泡的 60 字截断）
 *   ERR    -> 401 + JSON 错误体
 *   ERR500 -> 500（验证非 401 的失败路径）
 *   其它    -> 立刻按 6 段吐一句固定回复
 *
 * 每个请求都把「收到的消息条数与角色序列」打到 stdout，用来核对上下文裁剪；
 * 系统消息里带长期记忆时会额外报一行（记忆注入肉眼可见）。
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8787)
const REPLY = '你好呀，我是你的桌面小宠物，今天也要加油哦。'
/** 长期记忆在系统提示里的标题（与 src/main/memory.ts 的 memoryForPrompt 一致） */
const MEMORY_HEADING = '## 你记得的事（长期记忆）'

createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404).end('not found')
      return
    }

    let parsed = {}
    try {
      parsed = JSON.parse(body)
    } catch {
      /* 记录原始体，便于排查 */
    }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    const last = String(messages[messages.length - 1]?.content ?? '')
    console.log(
      `[fake] 收到请求：${messages.length} 条消息 [${messages.map((m) => m.role).join(',')}] 末条="${last.slice(0, 24)}"`
    )
    const system = messages.find((m) => m?.role === 'system')
    if (typeof system?.content === 'string' && system.content.includes(MEMORY_HEADING)) {
      const tail = system.content.slice(system.content.indexOf(MEMORY_HEADING))
      const count = tail.split('\n').filter((line) => line.startsWith('- ')).length
      console.log(`[fake]   系统提示里带着长期记忆：${count} 条`)
    }

    if (last.includes('ERR500')) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: '服务器内部错误（假的）' } }))
      return
    }
    if (last.includes('ERR')) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Invalid API key（假的）', type: 'invalid_request_error' } }))
      return
    }

    const slow = last.includes('SLOW')
    const pieces = slow
      ? Array.from({ length: 20 }, (_, i) => `第${i + 1}段 `)
      : last.includes('LONG')
        ? splitReply(REPLY.repeat(4))
        : splitReply(REPLY)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })

    let index = 0
    const push = () => {
      if (index >= pieces.length) {
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      const chunk = {
        id: 'chatcmpl-fake',
        object: 'chat.completion.chunk',
        model: 'fake-model',
        choices: [{ index: 0, delta: { content: pieces[index] }, finish_reason: null }]
      }
      index += 1
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      setTimeout(push, slow ? 250 : 30)
    }
    push()
  })
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[fake] OpenAI 兼容端点已就绪：http://127.0.0.1:${PORT}/v1`)
})

function splitReply(text) {
  const size = 4
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}
