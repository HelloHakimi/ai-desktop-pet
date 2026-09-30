/** 托盘菜单：桌宠的常规入口都收在这里（桌宠本身没有标题栏和菜单栏） */
import { Menu, Tray, app, clipboard, dialog, nativeImage, shell } from 'electron'
import { join } from 'node:path'
import { PIANO_KEYS_HINT } from '@shared/piano'
import { applyExpression, applyGame, reloadPet } from './actions'
import { prettyAccelerator, runAssist } from './assist'
import { clear } from './chat/session'
import { toggleChatWindow } from './chat/window'
import { recentClipboardTexts } from './clipboard-watch'
import {
  configPath,
  loadConfig,
  updateAssistSettings,
  updateModelSelection,
  updateWindowSettings
} from './config'
import { getFocusState, startFocus, stopFocus } from './focus'
import { noteActivity } from './idle'
import { ensureMemoryFile } from './memory'
import { listExpressions, listModels, modelsRoot, type PetExpression, type PetModel } from './models'
import {
  applyAlwaysOnTop,
  isAlwaysOnTop,
  isClickThrough,
  setClickThrough,
  toggleVisible
} from './pet-window'
import { getRuntimeState, onRuntimeStateChange, setRuntimeState } from './runtime-state'

let tray: Tray | null = null

export function createTray(): Tray {
  const icon = loadTrayIcon()
  const instance = new Tray(icon)
  tray = instance

  // 表情的勾画的是「渲染层现在真的挂着什么」，而那个状态只有渲染层知道（限时表情会自己
  // 到期、按键图案会互相顶替）—— 它上报一次，这里重建一次菜单。曾经这里是「记住最后一次
  // 点过的名字」，代价是「随机一个」「渲染层套用失败」这类情况下勾在撒谎。
  onRuntimeStateChange(() => rebuildMenu())

  instance.setToolTip('AI 桌宠')
  rebuildMenu()

  // 模型没出现在菜单里时，这几行能直接区分「目录扫错了」和「清单没写对」
  const models = listModels()
  const current = loadConfig().model.path
  console.log(`[tray] 模型目录：${modelsRoot()}`)
  console.log(
    `[tray] 可用形象 ${models.length} 个：${models.map((m) => m.name).join('、') || '（无）'}`
  )
  console.log(`[tray] 当前形象：${current}（表情 ${listExpressions(current).length} 个）`)

  return instance
}

function rebuildMenu(): void {
  if (!tray) return

  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: () => toggleVisible() },
    // 对话窗口可以关掉，形象窗口也可以隐藏 —— 这里是那两种情况下唯一的入口
    { label: '聊聊天', click: () => toggleChatWindow() },
    { label: '清空对话历史…', click: () => void confirmClearChat() },
    { type: 'separator' },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: isAlwaysOnTop(),
      click: (item) => {
        applyAlwaysOnTop(item.checked)
        // 写回配置：这是长期偏好，重启后保持（和「切换形象」同一套做法）
        updateWindowSettings({ alwaysOnTop: item.checked })
        rebuildMenu()
      }
    },
    {
      label: '点击穿透（不在形象上时鼠标可穿透）',
      type: 'checkbox',
      checked: isClickThrough(),
      click: (item) => {
        setClickThrough(item.checked)
        updateWindowSettings({ clickThrough: item.checked })
        rebuildMenu()
      }
    },
    { type: 'separator' },
    { label: '切换形象', submenu: modelEntries() },
    { label: '试个表情', submenu: expressionEntries() },
    pianoEntry(),
    { type: 'separator' },
    assistEntry(),
    { label: '剪贴板历史', submenu: clipboardEntries() },
    { label: '专注', submenu: focusEntries() },
    { type: 'separator' },
    {
      label: '主动说话（久坐 / 深夜）',
      type: 'checkbox',
      checked: loadConfig().assist.companion,
      click: (item) => {
        updateAssistSettings({ companion: item.checked })
        rebuildMenu()
      }
    },
    {
      label: '系统事件（充电 / 断网）',
      type: 'checkbox',
      checked: loadConfig().assist.systemEvents,
      click: (item) => {
        updateAssistSettings({ systemEvents: item.checked })
        rebuildMenu()
      }
    },
    {
      label: '闲聊（碎碎念 / 招呼 / 彩蛋）',
      type: 'checkbox',
      checked: loadConfig().assist.smalltalk,
      click: (item) => {
        updateAssistSettings({ smalltalk: item.checked })
        rebuildMenu()
      }
    },
    { type: 'separator' },
    {
      label: '重新加载形象',
      click: () => {
        reloadPet()
        // 重建渲染器会把表情层清空（新渲染器随后会上报，这里是先手把勾清掉，
        // 免得重建那一两秒里勾还停在旧状态上）
        clearExpressionChecks()
        // 顺便重扫目录：用户可能刚在模型文件夹里改了 pet-model.json 里的显示名
        rebuildMenu()
      }
    },
    {
      label: '打开配置文件…',
      click: () => {
        const path = configPath()
        void shell.openPath(path).then((error) => {
          if (error) console.error(`[tray] 打开配置文件失败：${error}`)
        })
      }
    },
    {
      label: '打开记忆文件…',
      click: () => {
        const path = ensureMemoryFile()
        void shell.openPath(path).then((error) => {
          if (error) console.error(`[tray] 打开记忆文件失败：${error}`)
        })
      }
    },
    { type: 'separator' },
    ...loginItemEntries(),
    { label: '退出', click: () => app.quit() }
  ])

  tray.setContextMenu(menu)
}

/**
 * 「切换形象」子菜单。
 *
 * 每次都重新扫目录：用户往模型文件夹里丢一个新模型后，不用重启就能在菜单里看到。
 * 模型数量是个位数，这点磁盘开销可以忽略。
 */
function modelEntries(): Electron.MenuItemConstructorOptions[] {
  const models = listModels()
  const current = loadConfig().model.path

  if (models.length === 0) {
    return [
      { label: '（模型文件夹里没有可用的模型）', enabled: false },
      { type: 'separator' },
      { label: '打开模型文件夹…', click: () => openModelsFolder() }
    ]
  }

  const entries: Electron.MenuItemConstructorOptions[] = models.map((model) => ({
    label: model.name,
    type: 'radio',
    checked: model.path === current,
    click: () => selectModel(model)
  }))

  // 配置指向了一个不在列表里的路径时，把现状显示出来，
  // 否则用户会看到一组全都没勾选的单选项而不知道当前到底在用哪个。
  if (!models.some((model) => model.path === current)) {
    entries.push(
      { type: 'separator' },
      { label: `当前：${current}（文件缺失）`, enabled: false }
    )
  }

  entries.push(
    { type: 'separator' },
    { label: '打开模型文件夹…', click: () => openModelsFolder() }
  )
  return entries
}

function selectModel(model: PetModel): void {
  if (loadConfig().model.path === model.path) return

  updateModelSelection({ path: model.path, idleMotionGroup: model.idleMotionGroup })
  reloadPet()
  // 换了形象，上一个形象的表情勾就没有意义了（新渲染器的上报会接管，这里先手清掉）
  clearExpressionChecks()
  // 重建菜单让勾选状态立刻跟上（reloadPet 不会碰菜单）
  rebuildMenu()
  console.log(`[tray] 已切换到形象：${model.name}`)
}

/** 把表情的勾先手清掉（渲染器正在重建时用：那一两秒里勾不该停在旧状态上） */
function clearExpressionChecks(): void {
  const state = getRuntimeState()
  if (state.expressions.length === 0) return
  setRuntimeState({ expressions: [], game: state.game })
}

/**
 * 「试个表情」子菜单。
 *
 * 表情清单从当前形象的 model3.json 现读，不缓存：切形象之后菜单必须立刻跟着变，
 * 而缓存是这类「清单和当前对象绑定」的地方最容易出错的一环。
 *
 * 勾画的是渲染层报上来的「现在真的挂着什么」，所以：
 * 再点一次是取消（模型原始的 vtube 热键表里这些表情记的就是 ToggleExpression），
 * 而叠加出来的组合（墨镜 + 奶茶）会同时有多个勾 —— 一眼能看出它现在戴了什么。
 */
function expressionEntries(): Electron.MenuItemConstructorOptions[] {
  const expressions = listExpressions(loadConfig().model.path)

  if (expressions.length === 0) {
    return [{ label: '（当前形象没有表情）', enabled: false }]
  }

  const active = new Set(getRuntimeState().expressions)
  const entries: Electron.MenuItemConstructorOptions[] = expressions.map((expression) => ({
    label: expression.name,
    type: 'checkbox',
    checked: active.has(expression.name),
    click: () => applyNamedExpression(expression)
  }))

  entries.push(
    { type: 'separator' },
    {
      label: '随机一个',
      click: () => {
        noteActivity()
        applyExpression({ kind: 'random' })
      }
    },
    {
      label: '还原默认',
      click: () => {
        noteActivity()
        applyExpression({ kind: 'reset' })
      }
    }
  )
  return entries
}

function applyNamedExpression(expression: PetExpression): void {
  noteActivity()
  applyExpression({ kind: 'toggle', name: expression.name })
}

/**
 * 敲琴：入口只在托盘（详见 renderer 的 pet/piano.ts）。
 * 它会把键盘焦点抢到形象窗口上，所以既要由用户明确发起，也要有个一眼能看见的出口。
 */
function pianoEntry(): Electron.MenuItemConstructorOptions {
  return {
    label: `敲琴（${PIANO_KEYS_HINT}，Esc 退出）`,
    type: 'checkbox',
    checked: getRuntimeState().game,
    click: (item) => {
      noteActivity()
      applyGame(item.checked)
    }
  }
}

/**
 * 「处理剪贴板」：把刚复制的那段文字交给桌宠（翻译 / 解释报错 / 摘要）。
 *
 * 提示里的快捷键从配置现读，不写死 —— 快捷键是可配置的，写死的那天就会开始说谎。
 */
function assistEntry(): Electron.MenuItemConstructorOptions {
  const shortcut = loadConfig().assist.shortcut
  const hint = shortcut.length > 0 ? `（${prettyAccelerator(shortcut)}）` : '（没设快捷键）'
  return { label: `处理剪贴板${hint}`, click: () => runAssist() }
}

/**
 * 「剪贴板历史」子菜单：点一条就换回剪贴板。
 *
 * 只列内存里那几条（见 clipboard-watch.ts），重启后是空的 —— 剪贴板里常有密码和 token，
 * 不值得为了「重启还在」把它写进磁盘。
 *
 * 换的时候刻意不说话：用户的下一步一定是 Cmd+V，粘出来对不对立刻就知道；
 * 而每次都让桌宠说一句，用两次就嫌吵了。
 */
function clipboardEntries(): Electron.MenuItemConstructorOptions[] {
  const items = recentClipboardTexts()
  if (items.length === 0) {
    return [{ label: '（还没复制过文字）', enabled: false }]
  }
  return items.map((text) => ({
    label: preview(text),
    click: () => clipboard.writeText(text)
  }))
}

/** 菜单项里的一行预览：把换行压平、按字符截断，保证每条都占一行 */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length <= 36 ? flat : `${chars.slice(0, 36).join('')}…`
}

/**
 * 「专注」子菜单。
 *
 * 刻意不显示倒计时：一个每分钟都在跳的数字要么得定时重建整个菜单，要么就是个死数。
 * 而且番茄钟的意义本来就是「别盯着表看」——到点了桌宠会说话。
 * 真要让菜单栏里有个倒计时，那该走 tray.setTitle()，但那是用户可见的外观变化，得先问过。
 */
function focusEntries(): Electron.MenuItemConstructorOptions[] {
  const state = getFocusState()
  const entries: Electron.MenuItemConstructorOptions[] = []

  if (state) {
    entries.push(
      { label: `专注中（${state.minutes} 分钟）`, enabled: false },
      {
        label: '停止',
        click: () => {
          stopFocus()
          rebuildMenu()
        }
      },
      { type: 'separator' }
    )
  }

  for (const minutes of loadConfig().assist.focusPresets) {
    entries.push({
      label: `${minutes} 分钟`,
      click: () => {
        startFocus(minutes)
        rebuildMenu()
      }
    })
  }
  return entries
}

function openModelsFolder(): void {
  void shell.openPath(modelsRoot()).then((error) => {
    if (error) console.error(`[tray] 打开模型文件夹失败：${error}`)
  })
}

/**
 * 清空对话历史前先问一句。
 *
 * 这个操作会直接覆写历史文件、不可撤销（桌宠从此忘掉聊过的所有内容），
 * 而托盘菜单又是一点就走的路径 —— 没有这一步，误点一下代价太大。
 * 长期记忆**不在**被清之列（那是另一份文件，见 memory.ts）：说清楚，免得用户以为它会一并忘掉。
 */
async function confirmClearChat(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: '清空所有对话历史？',
    detail: '桌宠会忘掉之前聊过的内容，这个操作不能撤销。长期记忆不在被清之列（要删请编辑记忆文件）。',
    buttons: ['清空', '取消'],
    defaultId: 1,
    cancelId: 1
  })
  if (response !== 0) return
  // 会话层的 clear() 会广播 chat:cleared，对话窗口和形象气泡各自收尾
  clear()
  console.log('[tray] 已清空对话历史')
}

/**
 * 「登录时自动启动」只在打包后出现。
 * 开发模式下注册的是 node_modules 里的 Electron 可执行文件，用户根本不会想要这个开机项，
 * 更糟的是它会真的被写进系统的登录项里。
 */
function loginItemEntries(): Electron.MenuItemConstructorOptions[] {
  if (!app.isPackaged) return []
  return [
    {
      label: '登录时自动启动',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked })
        // 这里刻意不 rebuildMenu()：勾选状态由菜单自己维护，
        // 而 getLoginItemSettings() 在刚写完时未必马上反映新值，重建反而可能画出错的勾。
      }
    },
    { type: 'separator' }
  ]
}

/**
 * 托盘图标放在 resources/ 下（不参与打包构建，out/main 往上两级即项目根目录）。
 * macOS 上使用 Template 后缀的图片，可自动适配深色/浅色菜单栏。
 */
function loadTrayIcon(): Electron.NativeImage {
  const path = join(__dirname, '../../resources/trayTemplate.png')
  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) {
    console.warn(`[tray] 托盘图标加载失败（${path}），托盘将显示为空白图标`)
    return image
  }
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}
