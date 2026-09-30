import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const shared = resolve(__dirname, 'src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': shared }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': shared }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    build: {
      rollupOptions: {
        // 三个渲染入口：形象窗口（index.html）、对话窗口（chat.html）、气泡输入框（bubble.html）。
        // 分成多个页面而不是一个页面靠参数区分，是为了让每个窗口只背自己需要的代码。
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          chat: resolve(__dirname, 'src/renderer/chat.html'),
          bubble: resolve(__dirname, 'src/renderer/bubble.html')
        }
      }
    }
  }
})
