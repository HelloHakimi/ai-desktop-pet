/** 气泡输入框：Spotlight 风格的悬浮输入窗口 */

// 与另两个渲染入口同一套写法：用取值函数而不是「const + if (!x) throw」——
// TS 不会把窄化结果保留到闭包（send / 事件回调）内部，函数返回非空类型才干净。
function requireInput(): HTMLInputElement {
  const element = document.getElementById('input')
  if (!(element instanceof HTMLInputElement)) throw new Error('页面缺少 #input 输入框')
  return element
}

const input = requireInput()

// 页面加载完自动聚焦
window.addEventListener('DOMContentLoaded', () => {
  input.focus()
})

input.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    window.close()
    return
  }
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  void send()
})

/** 发一句话。被拒（空文本、上一条还在生成）时不改输入框，用户那句话还在 */
async function send(): Promise<void> {
  const text = input.value.trim()
  if (text.length === 0) return
  if (!window.pet) {
    input.placeholder = '未检测到 preload 注入的 API，请通过 npm run dev 启动 Electron'
    return
  }
  const result = await window.pet.sendChat(text)
  if (result.ok) input.value = ''
}
