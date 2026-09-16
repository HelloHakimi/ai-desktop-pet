/** 渲染层入口：装配形象渲染器、拖动与点击穿透 */
import './style.css'
import type { RendererConfig } from '@shared/config'
import { bindHitTest } from './drag/hitTest'
import { bindWindowDrag } from './drag/windowDrag'
import { createRenderer } from './pet/createRenderer'
import { PlaceholderRenderer } from './pet/PlaceholderRenderer'
import type { PetRenderer } from './pet/types'

// 用取值函数而不是 `const host = ...; if (!host) throw`：
// 函数声明会被提升，TS 不会把窄化结果保留到闭包内部，这里直接返回非空类型更干净。
function requireHost(): HTMLElement {
  const element = document.getElementById('pet-root')
  if (!element) throw new Error('页面缺少 #pet-root 容器')
  return element
}

const host = requireHost()

let current: PetRenderer | null = null
let latestConfig: RendererConfig | null = null
/** 挂载代号：只有最后一次发起的挂载能把自己的渲染器装上去 */
let mountToken = 0

async function mountPet(config: RendererConfig): Promise<void> {
  const token = (mountToken += 1)

  latestConfig = config
  current?.destroy()
  current = null
  host.replaceChildren()

  let next: PetRenderer
  try {
    next = await createRenderer(host, config)
  } catch (error) {
    // 工厂内部已经处理了大部分失败，这里是最后一道兜底，绝不让窗口变空白
    const message = error instanceof Error ? error.message : String(error)
    console.error('[pet] 形象渲染失败：', error)
    next = new PlaceholderRenderer(host, `形象渲染失败：${message}`)
  }

  // 挂载过程中又来了新的挂载请求（重建形象是异步的，两条 IPC 之间就会撞上）：
  // 本次的产物必须自己销毁。只把 current 指向新的那个是不够的 ——
  // 旧渲染器的 canvas 和 Pixi ticker 会留在那里继续跑，每重建一次就泄漏一个 WebGL 上下文。
  if (token !== mountToken) {
    next.destroy()
    return
  }

  current = next
  console.info(`[pet] 形象渲染器已就绪：${current.kind}`)
}

async function boot(): Promise<void> {
  if (!window.pet) {
    document.body.innerHTML =
      '<div class="placeholder-pet__note">未检测到 preload 注入的 API，请通过 npm run dev 启动 Electron</div>'
    return
  }

  const config = await window.pet.getConfig()
  await mountPet(config)

  bindWindowDrag(host)
  bindHitTest(
    () => current?.getHitBox() ?? null,
    () => latestConfig?.window.clickThrough ?? false
  )

  window.pet.onConfigChanged((next) => {
    void mountPet(next)
  })
  window.pet.onModelReloaded(() => {
    void window.pet.getConfig().then(mountPet)
  })
  window.pet.onExpression((command) => {
    // 切换形象是异步的，这期间 current 可能是 null —— 直接丢掉比排队更合适：
    // 用户点的是上一个形象的表情，等新形象挂上来再补放会很怪。
    if (!current) return
    if (command.kind === 'reset') current.resetExpression()
    else if (command.kind === 'random') current.setExpression()
    else current.setExpression(command.name)
  })
}

void boot()
