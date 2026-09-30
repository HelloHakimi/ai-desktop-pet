/**
 * 自定义 app:// 协议。
 *
 * 为什么不用 loadFile() 直接走 file://？
 * Chromium 禁止在 file:// 页面上用 fetch/XHR 读取本地文件，而桌宠必须能读取：
 * Live2D 的 model3.json、moc3、贴图，以及渲染层的资源探测。
 * 结果是：dev 模式（http://localhost）一切正常，打包后却永远加载不出模型。
 *
 * 常规的「歪招」是 webSecurity: false 或 --allow-file-access-from-files，两者都会把整个渲染进程
 * 的安全边界拆掉。正确做法是注册一个 standard + secure 的自定义协议，让本地资源以正常的
 * Web 语义（同源、可 fetch、可流式）被访问。
 */
import { net, protocol } from 'electron'
import { stat } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const APP_SCHEME = 'app'
export const APP_HOST = 'bundle'
/** 生产环境下渲染层的入口地址 */
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`
/** 对话窗口的入口地址（第二个渲染入口，见 electron.vite.config.ts 的多页配置） */
export const APP_CHAT_URL = `${APP_SCHEME}://${APP_HOST}/chat.html`
/** 气泡输入框的入口地址（Spotlight 风格的悬浮输入窗口） */
export const APP_BUBBLE_URL = `${APP_SCHEME}://${APP_HOST}/bubble.html`

/**
 * 必须在 app ready 之前调用。
 * supportFetchAPI 是这次修复的核心：没有它，fetch 依旧不可用。
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    }
  ])
}

/** 把 rendererRoot 目录挂到 app://bundle/ 下（需在 ready 之后调用） */
export function serveRenderer(rendererRoot: string): void {
  const root = normalize(rendererRoot)

  protocol.handle(APP_SCHEME, async (request) => {
    const { pathname } = new URL(request.url)

    // decodeURIComponent 遇到畸形的百分号转义会抛 URIError，
    // 不接住的话这个 handler 会直接 reject，渲染层只能看到一个语焉不详的网络错误。
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return new Response('Bad Request', { status: 400 })
    }

    const relative = decoded.replace(/^[/\\]+/, '')
    const target = normalize(join(root, relative))

    // 目录穿越防护：只允许访问 rendererRoot 之内的文件
    if (target !== root && !target.startsWith(root + sep)) {
      return new Response('Forbidden', { status: 403 })
    }

    // 必须先确认文件存在：net.fetch 遇到不存在的 file:// 会直接 reject，
    // 那样渲染层拿到的就是 "Failed to fetch"，而不是可判断的 404 —— 探测逻辑会失效。
    try {
      const info = await stat(target)
      if (!info.isFile()) return new Response('Not Found', { status: 404 })
    } catch {
      return new Response('Not Found', { status: 404 })
    }

    return net.fetch(pathToFileURL(target).toString())
  })
}
