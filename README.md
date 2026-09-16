# AI 桌宠

一只住在桌面上的 AI 宠物：透明置顶的无边框窗口 + Live2D 形象 + 大模型对话。

当前处于 **里程碑 1：可运行骨架**。骨架的含义是「壳必须是活的」——窗口行为、形象渲染、
配置系统、模型接入的分层都已经打通并可替换，但对话 UI 尚未接入（见文末路线图）。

## 日常使用：装成 App

桌宠是要常驻的东西，不该每次开终端跑。打成 macOS 应用只需要一条命令：

```bash
# 国内网络建议带镜像：Electron 二进制默认从 GitHub Releases 拉，实测只有 ~100 KB/s，
# 不带镜像装一次要十几分钟。下载后仍会用官方 checksums.json 校验完整性。
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install

npm run setup:live2d           # 首次：取 Cubism Core（官方单独分发，仓库不含）
npm run dist                   # 产物：dist/mac-arm64/AI 桌宠.app
cp -R "dist/mac-arm64/AI 桌宠.app" /Applications/
```

之后双击「AI 桌宠」就能用。**操作入口只有菜单栏那个爪印图标** —— 应用刻意不显示 Dock 图标
（`window.hideDockIcon`），所以「退出」也在托盘菜单里，别去找 Cmd+Q。

托盘菜单里还有一个「登录时自动启动」，勾上就开机自启（这项只在打包后出现，
开发模式下注册的会是 node_modules 里的 Electron 可执行文件，没有意义）。

> 应用是本地构建的，没有签名也不影响双击运行。但要**发给别人**得先签名 + 公证，
> 或者让对方右键 →「打开」绕过 Gatekeeper。

## 开发

```bash
npm install
npm run dev        # 带热更新
npm run build      # 只构建到 out/
npm run preview    # 用构建产物启动（不打包）
```

启动后你会看到：

- 屏幕上一只 **Live2D 小猫咪「Blue cat」**（透明背景、无边框、始终置顶，可拖动）
- 菜单栏托盘里有一个**爪印图标**，右键可打开菜单

> 形象资源在 `src/renderer/public/models/blue-cat/`。缺 Cubism Core 时（新克隆的仓库）会自动降级为
> 内置的占位小宠物，并说明原因 —— 这是刻意设计的降级路径，见下方「启用 Live2D」。

托盘菜单提供：显示/隐藏、始终置顶、点击穿透、重新加载形象、打开配置文件、登录时自启、退出。

## 打包细节

`electron-builder.yml` 里有三个刻意的选择：

**不用 asar。** 主进程里所有资源路径都是相对 `__dirname` 定位的（`../renderer`、`../../resources`），
打了 asar 就得再写一套指向 `app.asar.unpacked` 的路径改写，换来的只有「文件看起来整齐一点」。
副作用正好是想要的：模型文件在 `.app` 里是散的，想换模型直接丢进
`Contents/Resources/app/out/renderer/models/` 就行，不用重新打包。

**`node_modules` 一律不进包。** pixi 这些已经被 Vite 打进 renderer 的 chunk 了，
再带一份 node_modules 只是白占 36 MB。所以包里的 `Contents/Resources/app/` 只有 `out/`、
`resources/` 和 `package.json` —— 这也是为什么图标脚本要用标准库写：
构建链上每多一个依赖，就多一个「换台机器跑不起来」的理由。

**关掉签名**（`identity: null`）。本机 `security find-identity` 是 0 个有效身份，
不显式关掉的话 electron-builder 会尝试签名然后报错。

应用图标由 `npm run make:icon` 生成（`build/icon.icns`）。它和托盘图标共用同一套爪印几何，
所以两处图形是一致的。产物已入库，改了设计再跑一次。

## 目录结构

```
src/
├── main/                    # 主进程：窗口、托盘、配置、AI Provider
│   ├── index.ts             # 入口：单实例、启动流程
│   ├── pet-window.ts        # 透明置顶窗 + 拖动 + 点击穿透
│   ├── protocol.ts          # app:// 自定义协议（本地模型资源的加载通道）
│   ├── tray.ts              # 托盘菜单（含「切换形象」子菜单）
│   ├── actions.ts           # 托盘与渲染层共用的动作（重载配置等）
│   ├── models.ts            # 扫模型目录，生成形象清单
│   ├── config.ts            # 配置 IO（默认值/模板生成/环境变量覆盖/写回）
│   ├── ipc.ts               # IPC 处理，校验渲染层输入
│   └── ai/                  # LLM Provider 抽象 + OpenAI 兼容实现
├── preload/                 # 只暴露收窄过的 window.pet API
├── renderer/                # 渲染进程
│   ├── index.html
│   └── src/
│       ├── main.ts          # 装配渲染器、拖动、命中判定
│       ├── pet/             # 形象渲染层：Live2D / 占位形象 / 工厂
│       └── drag/            # 窗口拖动与点击穿透
└── shared/                  # 三端共用的类型与纯函数（不碰 Node/DOM API）
    ├── config.ts            # 配置 schema、默认值、合并与校验
    ├── ai.ts                # 对话类型与入参校验
    └── ipc.ts               # IPC 通道契约 + PetApi 接口
```

## 配置

配置文件在 userData 目录，首次启动自动生成：

| 平台 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/ai-desktop-pet/pet.config.json` |
| Windows | `%APPDATA%/ai-desktop-pet/pet.config.json` |
| Linux | `~/.config/ai-desktop-pet/pet.config.json` |

托盘菜单的「打开配置文件…」可以直接打开它。完整示例见 `pet.config.example.json`。

优先级：**环境变量 > 配置文件 > 默认值**。写错的字段会被忽略并回退默认值，而不是让应用崩掉。

环境变量：

| 变量 | 说明 |
| --- | --- |
| `PET_API_KEY` | API Key（也可用 `OPENAI_API_KEY`） |
| `PET_BASE_URL` | 兼容 OpenAI 的 baseUrl（也可用 `OPENAI_BASE_URL`） |
| `PET_MODEL` | 模型名 |
| `PET_CONFIG` | 指定配置文件路径，方便同时养好几只 |

## 启用 Live2D

形象已经在仓库里了（6 个，共 95 MB），只需要补一步：获取 Cubism Core。

```bash
# Cubism Core 由官方单独分发（有再分发限制），仓库不含此文件
npm run setup:live2d
```

装好后从托盘菜单点「重新加载形象」即可生效，**不用重启** —— 渲染层不会把「缺少 Core」这个
失败结果缓存下来，就是为了让这条最自然的路径走得通。

`model.mode` 支持三种取值 ——

- `auto`（默认）：能跑 Live2D 就跑，否则静默降级为占位形象
- `live2d`：强制 Live2D，失败时把原因直接显示在窗口上（不静默降级）
- `placeholder`：强制使用占位形象

只支持 Cubism 4/5（`.model3.json` + `.moc3`），Cubism 2.1 的 `.model.json` 未接入。

### 切换形象

托盘菜单 →「切换形象」→ 选一个。选中项前面会打点，选择会写回配置文件，重启后保持。

菜单里的形象是**每次打开菜单时扫目录**得到的，不是在代码里写死一份列表 ——
往模型文件夹里丢一个新模型，不用改代码、不用重新构建、不用重启，菜单里就会出现。
（「切换形象 → 打开模型文件夹…」可以直接在访达里打开那个目录。）

仓库里现在有 6 个形象：

| 目录 | 菜单显示名 | 贴图 | 动作 | 表情 | 大小 |
| --- | --- | --- | --- | --- | --- |
| `blue-cat/` | 水色小猫咪 | 5×2048 | 1 | 22 | 25 MB |
| `yuuri/` | Yuuri | 5×2048 | 3 | 11 | 12 MB |
| `cotton/` | 晚安少女 | 3×2048 | 1 | 14 | 13 MB |
| `honey-peach/` | 桃瑟古风 | 14×2048 | 2 | 23 | 36 MB |
| `qpet-a/` | Q版 A | 1×2048 | 12 | 40 | 4.2 MB |
| `qpet-b/` | Q版 B | 1×2048 | 15 | 44 | 4.8 MB |

每个模型目录里的 `pet-model.json` 决定菜单里显示的名字和待机动作组名：

```json
{ "name": "水色小猫咪", "idleMotionGroup": "Idle" }
```

改这个文件就能改名，不用碰代码。

### 装一个新模型

模型大多是给 VTube Studio 用的，直接拷过来会得到一个不会动、不眨眼、表情全空的花瓶 ——
动作和表情登记在 `.vtube.json` 里，而 `pixi-live2d-display` 不读那个文件。
`scripts/install-model.py` 负责把这层信息搬过去：

```bash
python3 scripts/install-model.py <源模型目录> <目标目录名> --name "菜单里的名字"
# 例：python3 scripts/install-model.py /tmp/extract/Yuuri yuuri --name "Yuuri"
```

它做四件事：只挑运行时需要的文件复制（跳过 UI 图、插画、psd、图标）→ 调
`downscale-textures.py` 降采样贴图 → 从 `.vtube.json` 补全 `model3.json` 的
`Motions` / `Expressions` / `Groups` → 写 `pet-model.json`。中途失败会把半个目录删干净，
不会在托盘里留一个加载不出来的残骸。

源目录里的文件名建议是 UTF-8。从 GBK 编码的 Windows 压缩包里解出来的话，
用 `ditto -x -k` 或 Python 的 `zipfile` 显式按 GBK 解码，别用 `unzip`（会解出乱码文件名）。

### 这几份模型都补了什么

它们原本都是给 VTube Studio 用的，动作和表情登记在各自的 `.vtube.json` 里，而这份文件
**`pixi-live2d-display` 不读**。所以每个 `model3.json` 都被补齐了三处，否则模型只是不会眨眼、
不会动、也没有表情的静态立绘：

| 补的内容 | 来源 | 作用 |
| --- | --- | --- |
| `FileReferences.Motions.Idle` | vtube 的 `FileReferences.IdleAnimation` | 循环待机动作 |
| `FileReferences.Motions.Tap` | 其余 `*.motion3.json` | 打包成一组，留给将来「点击随机播一个」 |
| `FileReferences.Expressions` | vtube 的 `ToggleExpression` 热键表 | 让 `setExpression('哭哭')` 这类调用能找到表情 |
| `Groups` 的 `EyeBlink` / `LipSync` | vtube 参数表里 `Input` 为 `EyeOpen*` / `MouthOpen` 的项 | 让它会眨眼；口型留给里程碑 3 |

`Idle` 这个组名不能改：`pixi-live2d-display` 内部用 `groups.idle = "Idle"` 识别待机动作，
换成别的名字它就不接管了。

对 `model3.json` 的改动是**纯增量**的（只加不改原有字段），想回到原版把 `Motions` /
`Expressions` / `Groups` 三段删掉即可。原始压缩包都在 `~/.Trash/` 里还没清空。

### 贴图降采样：从 4096/8192 降到 2048

这批模型自带的贴图是 4096²，`Q版` 那两个更是 **8192²** —— 单张 8192² 解码后就要 256 MB 显存。
`桃瑟古风` 一家有 14 张贴图，原样加载约 896 MB。形象只渲染在 320×460 的窗口里，
这些分辨率有一大半是白解码、白占显存。

```bash
python3 scripts/downscale-textures.py <模型目录> 2048
```

Blue cat 的实测对比（同机同配置，只改贴图分辨率）：

| | 4096（原始） | 2048（当前） |
| --- | --- | --- |
| 合计常驻内存 | 924 MB | **582 MB** |
| 渲染进程 | 593 MB | 305 MB |
| GPU 进程 | 145 MB | 90 MB |
| 贴图文件体积 | 21.7 MB | 7.2 MB |

画质验证方式是**先把待机动作和眨眼冻住**再逐像素比 —— 第一版对比得出「15% 像素不同」是假象，
那比的是动画的不同帧，不是画质。冻住之后：平均通道差 1.14/255，差异集中在轮廓的亚像素抗锯齿，
3 倍放大目视无可见差别。

## 接入大模型

Provider 层是独立的，目前实现了 OpenAI 兼容协议，DeepSeek / 通义 / Kimi / 本地 vLLM / Ollama
都可以直接复用，只改 `ai.baseUrl` 与 `ai.model`。

先做连通性自检（不启动 Electron，把配置问题和 UI 问题分开定位）：

```bash
export PET_API_KEY=sk-xxxx
npm run ai:ping
# 或指定提示词
npm run ai:ping -- --prompt "用一句话夸我"
```

新增厂商：在 `src/main/ai/index.ts` 的注册表里注册一个 `ProviderFactory` 即可，
上层（IPC / 未来的对话 UI）不需要改动。

## 几个刻意的设计选择

**拖动为什么不用 `-webkit-app-region: drag`？**
它会吞掉元素上的鼠标事件，后续想加「点击形象触发对话」就做不了。改为主进程轮询鼠标位置移动窗口：
渲染层只报告按下/松开，位移超过 3px 才算拖拽，因此**点击与拖拽可以区分**。

**点击穿透为什么需要 `forward: true`？**
桌面宠物不该挡住桌面图标。鼠标不在形象上时窗口设为忽略鼠标事件，但必须带 `forward: true`，
否则穿透状态下收不到 `mousemove`，鼠标移回形象上时窗口就再也接管不回来了。

**为什么 Live2D 是动态 import？**
`pixi.js` + `pixi-live2d-display` 只在真的要跑 Live2D 时才加载；占位形象路径不背这个包体。
同时把对 Live2D 库的依赖收窄到结构化类型（我们真正调用的几个方法），库升级时不容易被类型变动卡住。

**为什么渲染层拿不到 AI 配置？**
`toRendererConfig()` 会剥掉整个 `ai` 段再下发。API Key 只存在于主进程内存里，不进渲染进程。

**生产环境为什么不用 `loadFile()` 走 `file://`？**
Chromium 禁止在 `file://` 页面上用 `fetch`/XHR 读取本地文件，而桌宠必须能读 `model3.json` / `moc3` / 贴图。
踩过的坑是：**dev 模式一切正常，打包后却永远加载不出模型**。常规歪招是 `webSecurity: false` 或
`--allow-file-access-from-files`，两者都会把渲染进程的安全边界整个拆掉。这里改为注册 `app://`
自定义协议（`standard + secure + supportFetchAPI`），让本地资源以正常的 Web 语义被访问。

**CSP 为什么不能加 `unsafe-eval`？**
PixiJS 6 内部用 `new Function()` 生成 uniform 同步代码，会被 `script-src 'self'` 拦下并抛
`Current environment does not allow unsafe-eval`。官方为此提供了 `@pixi/unsafe-eval`：
用预生成的代码路径替换 eval。装这个包，而不是放宽 CSP。

## 验证状态

里程碑 1 的每条关键路径都实机跑过（macOS，Electron 33 / Node 24），不是「看起来应该能跑」：

| 验证项 | 方式与结果 |
| --- | --- |
| 构建与类型检查 | `typecheck` 两套 tsconfig 均通过；`build` 产物入口 12.5 KB，pixi(505 KB)/cubism4(209 KB) 拆成独立懒加载 chunk |
| 窗口与 IPC | 主进程启动、4 类进程齐全、渲染进程带 `--enable-sandbox`；`getConfig` / `dragEnd` / `chat` 往返正常 |
| 降级链路 | 三个分支逐一实测：无 Core → 提示去跑 setup:live2d、模型缺失 → `HTTP 404`、文件非 JSON → 解析错误，均正确降级且有可读原因 |
| Live2D 真实渲染 | 实测通过：Cubism Core 5.1.0 → CubismFramework 初始化 → 模型渲染，`形象渲染器已就绪：live2d` |
| 模型资源完整性 | Blue cat 的 5 张贴图 / moc3 / physics3 / cdi3 / 待机动作全部 200，无加载失败；中文文件名在 `app://` 下正常解析 |
| 动作与表情 | 隔 0.9 秒截两张图对比确认画面在动（待机动作 + 眨眼）；`setExpression('哭哭' / '心心眼' / '生气')` 逐个触发，画面均发生对应变化 |
| 打包产物 | `npm run dist` 产出 `AI 桌宠.app`；从 .app 内启动实测渲染正常、零报错；包体 277 MB（其中 Electron 框架 230 MB，自身内容 44 MB，node_modules 未进包） |
| 打包后的配置 | 实测打包版仍读 `~/Library/Application Support/ai-desktop-pet/pet.config.json`（文件未被重建，mtime 不变），没有因为改了 productName 而换目录 |
| 贴图降采样 | 冻住动画后逐像素对比：平均通道差 1.14/255，3 倍放大无可见差别；常驻内存实测 924 → 582 MB |
| 依赖与打包边界 | 实测 `.app` 内没有 `node_modules`；`npm audit --omit=dev` 为 0 vulnerabilities |
| 形象几何与可交互性 | CDP 实测：2400×4500 的模型在 320×460 窗口里缩放为 245×460 且完整落在窗口内；命中框 172×322 也在窗口内（中心可点、四角穿透）；`refit()` 连调 4 次缩放值不变 |
| 重建形象不泄漏 | 连点 3 次「重新加载形象」：`mountCount` 每次 +1、DOM 内 canvas 恒为 1、缩放保持正确（修复前是每次 +2 挂载、2 个 canvas，泄漏 WebGL 上下文） |
| 对话链路 | 假 OpenAI 端点实测：主进程发出的请求体里 `systemPrompt` 已注入、渲染层伪造的 system 消息被剔除、`temperature: 99` 被夹取为 2、超时返回 `请求超时（1200 ms）` |
| 资源探测 | 实测在运行中删掉 Cubism Core → 降级并给出提示；放回后再点「重新加载形象」即恢复 Live2D，无需重启 |
| 本地资源加载 | 实测 `fetch` 在 `app://` 下可用（能取到文件内容），缺失文件返回可判断的 404，畸形转义返回 400 |
| 密钥隔离 | CDP 实测 `getConfig()` 返回的对象**不含 `ai` 段** |
| dev 模式 | 起 Vite server + Electron，CDP 实测页面挂载 canvas、9 个 `window.pet` 方法齐全、窗口尺寸与配置一致 |
| 6 个形象逐个渲染 | 托盘逐个切换后逐个截图目视确认；每个形象引用的资源（model3.json / moc3 / 贴图 / physics3 / 动作）全部 200，非 2xx 为 0，控制台零报错 |
| 形象清单 | 主进程 inspector 实测菜单结构：6 个 radio 项 + 当前项打点正确 + 分隔线 + 「打开模型文件夹…」 |
| 切换的真实性与持久化 | 通过菜单项自身的 click 处理器触发切换（不是绕过菜单直接改配置），实测配置文件同步写入 `model.path` 与 `idleMotionGroup`，且 `_readme` 与 `ai` 段原样保留 |
| 配置指向失效模型 | 把 `yuuri/` 目录改名后重建菜单，实测出现「当前：yuuri/yuuri.model3.json（文件缺失）」的不可点条目，而不是一组全未勾选的单选项 |
| 切换形象的贴图回收 | **修复前**贴图只增不减，浏览完 6 个形象后 Pixi 的 `TextureCache` 累积全部 29 张；**修复后**实测缓存数严格等于当前形象的贴图张数（5 / 14 / 3 / 1 / 5），切回后仍能正常渲染 |
| 切换耗时 | 5 组切换实测 76–104 ms（均值 96 ms），每次都核实了实际加载的确实是目标形象（按贴图缓存内容判定），不是只看 canvas 数量 |
| 反复切换不泄漏 | 30 次切换实测：渲染进程 RSS 爬到 526 MB 后**完全走平**（后 20 次只涨 1 MB），GPU 恒定 90 MB，JS 堆恒定 61 MB |

**未能自动验证、需要你亲手确认的一项**：窗口拖动。它依赖主进程轮询真实鼠标位置，
而自动化注入的鼠标事件不会移动系统光标，所以只能由人拖一下确认。

## 修复记录（骨架阶段自查）

上面这些能力第一次做完后做过一轮逐文件排查，抓到的问题都记在这里，避免以后重新踩：

**Live2D 缩放自我反馈（影响最大）**
`refit()` 用 `model.width` 当「原始尺寸」，但 Pixi 的 `model.width` 是**已缩放**尺寸
（`scale.x * 本地包围盒宽度`）。于是第二次 refit 把自己上一次的结果当输入，缩放被反复重算，
最终停在 `modelScale` 上而不是铺满窗口 —— 2400×4500 的 Haru 被按 1:1 塞进 320×460 的窗口，
看到的是模型肚子的一块放大图；`modelScale` 配置完全失效；命中框被算到窗口上方（y 为负），
点击穿透永远判定为「不在形象上」，**形象既点不动也拖不动**。
而 refit 必然被调用多次（`ResizeObserver` 注册后立刻回调一次），所以这不是理论风险。
修法：量原始尺寸前先把 scale 归 1，结果缓存下来，refit 变成幂等操作。

**重建形象泄漏 WebGL 上下文**
一次「重新加载形象」主进程发了 `configChanged` + `modelReloaded` 两条消息，渲染层两个订阅都重建形象。
两次异步挂载互相覆盖，先完成的那个渲染器既没进 `current` 也没被销毁 —— canvas 留在 DOM 里、
Pixi ticker 继续跑。实测一次点击后 `mountCount` 从 1 变 3、DOM 里有 2 个 canvas。
修法：主进程只发一条 `configChanged`；渲染层再加一道挂载代号（generation）兜底，
过期的那次自己 `destroy()`。

**AI 人设配置从未生效**
`ai.systemPrompt` 在配置里定义、在 `ai:ping` 脚本里用了，但应用内的对话链路从头到尾没人读它 ——
用户在配置里写的人设被静默忽略。修法：在 IPC 里用 `withSystemPrompt()` 注入，
并剔除渲染层传来的 system 消息（人设由用户的配置文件决定）。

**Cubism Core 的失败结果被永久缓存**
`loadCubismCore()` 把 promise 缓存了起来，失败也缓存。于是「没装 Core → 看到提示 → 跑 setup:live2d →
点重新加载」这条最自然的路径永远走不通，只能重启应用。另外 404 属于 Chromium 会启发式缓存的响应，
重试还得绕开缓存。修法：失败不缓存 + 重试带变化的 query + 失败时摘掉死 script 节点。

**切换形象时贴图只增不减（这轮抓到的）**
`pixi-live2d-display` 的 `model.destroy()` 默认**不碰贴图**，而 PixiJS 的贴图是按 URL 存在
全局 `TextureCache` 里的。于是每切换到一个新形象就把它的贴图永久留在缓存里：实测把 6 个形象
都看过一遍后，缓存里攒了全部 29 张贴图（约 490 MB 解码数据），而且永远不会释放。

修法是给 `destroy()` 传 `{ texture: true, baseTexture: true }`。这两个标志缺一不可 ——
Pixi 的 `Texture.destroy(true)` 内部会先 `removeFromCache` 再销毁 baseTexture；
只销毁不清缓存键的话，下次切回这个形象会拿到一张已经销毁的贴图，直接渲染成空白。
修复后实测缓存数严格等于当前形象的贴图张数（5 / 14 / 3 / 1 / 5），切回后渲染正常。

**形象清单扫错了目录（dev 专属）**
`modelsRoot()` 一开始固定按 `__dirname/../renderer/models` 找模型，但 dev 模式下渲染层由
Vite dev server 提供、模型来自 `src/renderer/public/models`，`out/renderer/models` 只是上一次
build 的残影。症状是：新加的模型渲染层明明加载得出来，托盘菜单里却看不见。
改为按 `ELECTRON_RENDERER_URL` 是否存在来区分两种运行方式。

**其余小问题**
- 窗口被关掉后（默认菜单的 Cmd+W）托盘「显示 / 隐藏」变成点了没反应的死按钮 → 改为自动重建窗口。
- 拖动过程中光标跑出命中框会切进点击穿透，鼠标松开的事件可能收不到、拖拽卡死 → 按住期间强制保持可交互。
- `app://` 协议遇到畸形百分号转义时 `decodeURIComponent` 抛异常，handler 直接 reject → 改为返回 400。
- 请求超时的文案只会说「超时（默认 ms）」，不显示真实毫秒数 → 传实际生效的超时值。
- 渲染层传来的 `temperature` / `maxTokens` / `timeoutMs` 没做范围校验，且 `NaN` 会漏过 `typeof` 检查 → 与配置文件同一套上下限夹取。

## 故障排查

**`npm install` 报 `EPERM ... ~/.npm/_cacache`**
npm 会把它误报成「缓存目录里有 root 属主文件」。真实原因通常是当前环境不允许写 `~/.npm`
（沙箱、权限收紧）。把缓存指到可写位置即可：

```bash
npm install --cache "$PWD/.npm-cache"
```

**Electron 二进制下载极慢或卡住**
默认从 GitHub Releases 拉取，国内常见只有 ~100 KB/s。用环境变量带镜像
（下载后仍会用官方 `checksums.json` 校验完整性）：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

这条**故意没有写进 `.npmrc`**：`electron_mirror` 是 `@electron/get` 读的键、不是 npm 的配置项，
npm 11 会把任何不认识的键当成 `Unknown project config` 报警，于是每条 npm 命令都要刷两行黄字。
放进 `.npmrc` 换来的是永久噪音，放在命令里只在需要时出现一次。

## 依赖与安全

`npm audit` 会报 7 个漏洞（2 moderate / 3 high / 2 critical），但**这些代码一个都不会进到应用里**：

- `.app` 里没有 `node_modules` —— 打包时只装 `out/`、`resources/`、`package.json`。
  实测 `Contents/Resources/app/` 下确实只有这三样。
- 7 个漏洞全部来自开发期依赖：`gh-pages`（`pixi-live2d-display` 误当运行时依赖的**发布工具**，
  我们从不调用）和 `extract-zip`（`@electron/get` 解压 Electron 压缩包用，装包时一次性）。
- 所以 `npm audit --omit=dev` 是 **0 vulnerabilities**。

`pixi.js` / `pixi-live2d-display` / `@pixi/unsafe-eval` 放在 `devDependencies` 而不是
`dependencies` 里，也是同一个道理：它们是渲染层的源码依赖，但**已经被 Vite 打进 renderer 的
chunk**（产物里能看到 `pixi-*.js`、`cubism4.es-*.js`），运行时不需要从 `node_modules` 解析。
放进 `dependencies` 会让 electron-builder 以为要把它们拷进包里。

## 已知限制

- 窗口尺寸改动需要重启才能生效（透明窗重建成本高，暂未做热应用）。
- 点击穿透的命中判定用的是模型包围盒（内缩 15%），不是逐像素 alpha 判定；
  形象边缘的透明区域仍会挡住鼠标。逐像素判定留待后续优化。
- 切换形象会重建整个 Pixi 应用（连带一个新的 WebGL 上下文），但实测**很快**：
  从菜单点击到新形象渲染就绪平均 96 ms（含自动化调用的进程启动开销，真实值更低），
  因为资源走 HTTP 缓存、只需重新解码。代价是 Chromium 不会把峰值期的内存还给系统 ——
  看过 `桃瑟古风`（14 张贴图）之后渲染进程停在约 526 MB 不再下降，即使切回小模型也一样。
  这是水位不是泄漏（30 次切换实测已走平），要更低只能把贴图再降一档或改成复用同一个 Pixi 实例。
- 对话只实现了非流式一次性请求，UI 未接入。
- Live2D 只支持 Cubism 4/5（`.model3.json` + `.moc3`），Cubism 2.1 未接入。

## 路线图

- [x] **里程碑 1**：可运行骨架（透明置顶窗、形象渲染层 + 降级、拖动、托盘、配置、Provider 抽象）
- [ ] **里程碑 2**：对话接入（气泡 UI、流式输出、上下文管理、会话持久化）
- [ ] **里程碑 3**：语音（TTS 说话 + 口型同步，可选 ASR 唤醒）
- [ ] **里程碑 4**：主动行为（空闲动作、跟随鼠标、日程提醒、打包分发）

## 脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dist` | 构建 + 打包成 `dist/mac-arm64/AI 桌宠.app` |
| `npm run dev` | 开发模式启动（HMR） |
| `npm run build` | 只构建到 `out/` |
| `npm run preview` | 用构建产物启动（不打包） |
| `npm run typecheck` | 类型检查（主进程 / 渲染层两套 tsconfig） |
| `npm run setup:live2d` | 下载 Cubism Core |
| `npm run make:icon` | 重新生成应用图标（`build/icon.icns`） |
| `python3 scripts/downscale-textures.py <模型目录> <边长>` | 贴图降采样（省内存，需 macOS 自带 sips） |
| `python3 scripts/install-model.py <源目录> <目标名> --name "显示名"` | 装一个新形象：挑文件 + 降采样 + 补全 model3.json + 写清单 |
| `npm run ai:ping` | 模型连通性自检 |
| `python3 scripts/make-tray-icon.py` | 重新生成托盘图标 |

## 许可提示

仓库不含 Live2D Cubism Core（`npm run setup:live2d` 获取，产物已 gitignore），
使用该文件需接受 [Live2D 专有软件许可协议](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_cn.html)。
Live2D 模型请自行确认授权，商用前务必核对模型自带的许可条款。
