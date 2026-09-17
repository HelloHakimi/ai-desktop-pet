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

- 屏幕上一只 **Live2D 形象「Q版 A」**（透明背景、无边框、始终置顶，可拖动，目光会跟着鼠标走）
- 菜单栏托盘里有一个**爪印图标**，右键可打开菜单

> 形象资源在 `src/renderer/public/models/qpet-a/`。缺 Cubism Core 时（新克隆的仓库）会自动降级为
> 内置的占位小宠物，并说明原因 —— 这是刻意设计的降级路径，见下方「启用 Live2D」。

托盘菜单提供：显示/隐藏、始终置顶、点击穿透、切换形象、试个表情、重新加载形象、打开配置文件、
登录时自启、退出。

## 打包细节

`electron-builder.yml` 里有三个刻意的选择：

**不用 asar。** 主进程里所有资源路径都是相对 `__dirname` 定位的（`../renderer`、`../../resources`），
打了 asar 就得再写一套指向 `app.asar.unpacked` 的路径改写，换来的只有「文件看起来整齐一点」。
副作用正好是想要的：模型文件在 `.app` 里是散的，想换模型直接丢进
`Contents/Resources/app/out/renderer/models/` 就行，不用重新打包。

**`node_modules` 一律不进包。** pixi 这些已经被 Vite 打进 renderer 的 chunk 了，
再带一份只是白占空间（本地 `node_modules` 有 440 MB）。所以包里的 `Contents/Resources/app/`
只有 `out/`、`resources/` 和 `package.json` —— 这也是为什么图标脚本要用标准库写：
构建链上每多一个依赖，就多一个「换台机器跑不起来」的理由。

（`package.json` 里现在**连 `dependencies` 键都没有**：三个运行时库全部已打进 chunk，
留在 `dependencies` 只会让 electron-builder 以为需要把它们拷进包。）

**关掉签名**（`identity: null`）。本机 `security find-identity` 是 0 个有效身份，
不显式关掉的话 electron-builder 会尝试签名然后报错。

应用图标由 `npm run make:icon` 生成（`build/icon.icns`）。它和托盘图标共用同一套爪印几何，
所以两处图形是一致的。产物已入库，改了设计再跑一次。

### `npm run dist` 卡在 packaging 不动？

大概率不是构建出问题，而是 electron-builder 在**下载 Electron 二进制**时卡住了
（国内直连 GitHub Releases 常常卡在拉 `SHASUMS256.txt` 那一步，甚至不报错、就这么挂着）。
判据：`dist/` 迟迟不出现，进程 CPU 接近 0，也没有 `dist/builder-effective-config.yaml`。

用镜像重跑即可（下载后仍会用官方 `checksums.json` 校验完整性）：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist
```

注意镜像会改变 `@electron/get` 的缓存键（缓存目录是按下载 URL 的哈希命名的），
所以切换镜像后第一次仍会真的重新下载一次。

另外 electron-builder 的校验和它**从不使用缓存**，每次打包都要重新拉一次 `SHASUMS256.txt` ——
所以网络抖动会反复咬人，这不是配置问题。实测同一个命令在几分钟内一次成功、一次挂满 10 分钟。

## 目录结构

```
src/
├── main/                    # 主进程：窗口、托盘、配置、AI Provider
│   ├── index.ts             # 入口：单实例、启动流程
│   ├── pet-window.ts        # 透明置顶窗 + 拖动 + 点击穿透
│   ├── protocol.ts          # app:// 自定义协议（本地模型资源的加载通道）
│   ├── tray.ts              # 托盘菜单（含「切换形象」「试个表情」子菜单）
│   ├── actions.ts           # 托盘与渲染层共用的动作（重载配置等）
│   ├── models.ts            # 扫模型目录，生成形象/表情清单
│   ├── config.ts            # 配置 IO（默认值/模板生成/环境变量覆盖/写回/失效形象自愈）
│   ├── ipc.ts               # IPC 处理，校验渲染层输入
│   └── ai/                  # LLM Provider 抽象 + OpenAI 兼容实现
├── preload/                 # 只暴露收窄过的 window.pet API
├── renderer/                # 渲染进程
│   ├── index.html
│   └── src/
│       ├── main.ts          # 装配渲染器、拖动、命中判定、目光跟随
│       ├── pet/             # 形象渲染层：Live2D / 占位形象 / 工厂 / 目光跟随
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

形象已经在仓库里了（1 个，4.2 MB），只需要补一步：获取 Cubism Core。

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

仓库里现在只有 1 个形象：

| 目录 | 菜单显示名 | 贴图 | 动作 | 表情 | 大小 |
| --- | --- | --- | --- | --- | --- |
| `qpet-a/` | Q版 A | 1×2048 | 12 | 40 | 4.2 MB |

每个模型目录里的 `pet-model.json` 决定菜单里显示的名字和待机动作组名：

```json
{ "name": "Q版 A", "idleMotionGroup": "Idle" }
```

改这个文件就能改名，不用碰代码（改完点一下托盘里的「重新加载形象」，菜单会重扫目录）。

**配置指着的形象不见了怎么办？** 启动时会检查一次 `model.path` 是否真的存在，不存在就自动改指到
一个确实存在的形象并写回配置文件，同时打一行警告。这不是多余的防御 —— 形象清单是**扫目录**得到的，
删掉一个模型目录之后配置文件里还留着旧路径，不修的话启动后托盘里是一组**全都没打勾**的单选项，
而窗口上只有一句「模型文件不存在」，用户根本不知道该点哪个。
（只在启动时修，不在 `loadConfig()` 里修：那个函数被很多地方调用，不该带写文件的副作用。）

### 试个表情

托盘菜单 →「试个表情」→ 选一个。列出的是**当前形象** `model3.json` 里登记的表情，
所以换个形象菜单就跟着换（当前这个形象有 40 个）。末尾还有两项：

- **随机一个** —— 从当前形象的清单里随机套一个
- **还原默认** —— 回到没有任何表情的状态

选中项前面会打点。表情名原样取自 `model3.json`，不做任何美化 —— 这个名字和文件名**不保证一致**：

| 菜单里的名字 | 实际指向的文件 |
| --- | --- |
| `右键` | `左键.exp3.json` |
| `左键` | `真 左键.exp3.json` |
| `大哭` | `哭.exp3.json` |
| `举喇叭` | `拿喇叭.exp3.json` |
| `我会出手` | `打拳.exp3.json` |

（名字里也可能含空格，所以渲染层的「还原默认」用的是可辨识联合而不是空字符串哨兵。）

**注意两点**：

- 这里不是 VTube 那种「再点一次取消」。菜单是单选语义，取消请用「还原默认」。
  （原始 `.vtube.json` 里这些表情登记的是 `ToggleExpression`，所以确实有人会习惯性再点一次。）
- 表情文件是**按需加载**的，第一次套用某个表情要现取一次 `exp3.json`；之后再套用同一个就直接命中缓存。
  实测首次平均 9 ms、再次 6 ms（还含自动化调用的进程启动开销），实际感觉不到。

顺带说一句：这 40 项里有 7 个不是情绪表情，而是**按键叠加层** ——
`A` `S` `D` `W` `左键` `右键` `1`。这个模型带一个敲琴小游戏，按哪个键就显示对应的键帽图案。

### 装一个新模型

模型大多是给 VTube Studio 用的，直接拷过来会得到一个不会动、不眨眼、表情全空的花瓶 ——
动作和表情登记在 `.vtube.json` 里，而 `pixi-live2d-display` 不读那个文件。
`scripts/install-model.py` 负责把这层信息搬过去：

```bash
python3 scripts/install-model.py <源模型目录> <目标目录名> --name "菜单里的名字"
# 例：python3 scripts/install-model.py /tmp/extract/MyModel my-model --name "我的形象"
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
`Expressions` / `Groups` 三段删掉即可。原始压缩包在 `~/.Trash/` 里（早先那批形象已经从仓库里去掉，
但仍然留在 git 历史里，需要时 `git show <commit>:<path>` 就能取回来）。

### 贴图降采样：从 4096/8192 降到 2048

这批模型自带的贴图是 4096²，`Q版` 那两个更是 **8192²** —— 单张 8192² 解码后就要 256 MB 显存。
`桃瑟古风` 一家有 14 张贴图，原样加载约 896 MB。形象只渲染在 320×460 的窗口里，
这些分辨率有一大半是白解码、白占显存。

```bash
python3 scripts/downscale-textures.py <模型目录> 2048
```

下面这组对比是在仓库里还有 `blue-cat` 的时候测的（同机同配置，只改贴图分辨率），
降采样的理由和幅度对现在的 `qpet-a` 同样成立：

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
| 构建与类型检查 | `typecheck` 两套 tsconfig 均通过；`build` 产物入口 16 KB，pixi(505 KB)/cubism4(209 KB) 拆成独立懒加载 chunk |
| 窗口与 IPC | 主进程启动、4 类进程齐全、渲染进程带 `--enable-sandbox`；`getConfig` / `dragEnd` / `chat` 往返正常 |
| 降级链路 | 三个分支逐一实测：无 Core → 提示去跑 setup:live2d、模型缺失 → `HTTP 404`、文件非 JSON → 解析错误，均正确降级且有可读原因 |
| Live2D 真实渲染 | 实测通过：Cubism Core 5.1.0 → CubismFramework 初始化 → 模型渲染，`形象渲染器已就绪：live2d` |
| 模型资源完整性 | `qpet-a` 的贴图 / moc3 / physics3 / cdi3 / 待机动作全部 200，无加载失败；非 ASCII 文件名（`爱心眼.exp3.json` 等）在 `app://` 下正常解析 |
| 动作与表情 | 隔 0.9 秒截两张图对比确认画面在动（待机动作 + 呼吸 + 眨眼）；表情逐个触发，画面均发生对应变化 |
| 形象清单 | 主进程 inspector 实测菜单结构：1 个 radio 项（Q版 A）且打点正确 + 分隔线 + 「打开模型文件夹…」，没有「文件缺失」残骸 |
| **配置自愈（四条路径逐一实测）** | ① 全新安装（无配置文件）→ 生成带说明的完整模板，`model.path` 就是新默认值，且不会误判成「形象不存在」；② 配置指向已删除的 `yuuri/yuuri.model3.json` → 日志「配置里的形象不存在（…），改用「Q版 A」」，只改 `model` 一节，`_readme` / `ai` / 自定义字段逐字未变；③ 配置文件语法损坏 → **不覆盖**，打两行错误日志后退回默认值；④ 配置正常 → 文件哈希不变 |
| 表情菜单 | 主进程 inspector 实测菜单结构：40 个 radio 项 +「随机一个」+「还原默认」，与 `model3.json` 登记的一致 |
| 表情真的生效 | 通过菜单项自身的 click 处理器触发（不是绕过菜单直接改配置），截图目视确认：`爱心眼` 变成心形眼＋腮红、`墨镜` 出现像素风墨镜；`随机一个` 与 `还原默认` 各自生效 |
| 表情提示的准确性 | 重复点同一个表情得到「表情未变化」而不是误报「不存在」；还原之后重新点回同一个名字能再次套用（这一条修掉了一个库的坑，见修复记录） |
| 表情套用耗时 | 首次平均 9 ms、再次 6 ms（含自动化调用的进程启动开销） |
| **帧率与节奏** | `Ticker.shared` 上正好 2 个监听（模型的 deltaTime 累加 + app 的渲染），`app.ticker` 就是 `Ticker.shared`，不限帧。给 `internalModel.update` 打桩记录每帧时间戳：4.06 s 内 243 帧 = **59.8 fps**，帧间隔 p50 **16.70 ms** / p99 17.90 ms，超过 25 ms 的间隔只有 1 次（0.41%） |
| **限帧闸门的坑** | 同一台 60 Hz 面板上实测：`maxFPS = 60` 只能跑出 **58.3 fps**（约 3% 的帧被跳过，表现就是时不时一顿），`maxFPS = 59` 更差（56.3 fps），只有不限帧是干净的 **60.0 fps**。所以代码里刻意不写 60（见 `TARGET_FPS` 的注释） |
| **CPU 占用** | 同一台机器、同一个形象，`top` 采样：改造前 60 fps / 双 rAF 循环 **27%**；改造后 60 fps / 单循环 **24%**，窗口隐藏（托盘「显示 / 隐藏」）时 **0.0%**。占用与分辨率、抗锯齿、画布面积**都无关** —— resolution 2 / 1.5 / 1 分别测得 24.4% / 24.3% / 24.8%，`antialias` 关掉是 25.3%，窗口从 320×460 缩到 320×340 无差别。说明那 3.5 ms/帧全在 Cubism 的骨骼/物理/网格更新里 |
| **鼠标跟随（`autoInteract`）** | 冻结动画后用固定 dt 序列推进同样多帧再逐像素比：指针从左侧换到右侧，`focusController` 目标从 `(-1, 0)` 翻到 `(1, 0)`，两帧相差 **11.3%** 的像素，差异区域 x∈[117,520] y∈[84,572]（正好是头/上半身）；换到上方 → `(0, 1)`，相差 10.7% |
| 重载后表情勾清零 | 从菜单点「重新加载形象」后，`试个表情` 子菜单里的勾全部清空（修复前会停在旧值上撒谎），且 DOM 内 canvas 恒为 1、Ticker 结构不变、贴图缓存不累积 |
| 打包产物 | `npm run dist` 产出 `AI 桌宠.app`；从 .app 内启动实测渲染正常、零报错；包体 239 MB（Electron 框架 233 MB + 自身内容 6.3 MB，其中模型 4.2 MB；node_modules 未进包） |
| 打包后的配置 | 实测打包版仍读 `~/Library/Application Support/ai-desktop-pet/pet.config.json`（文件未被重建，mtime 不变），没有因为改了 productName 而换目录 |
| 依赖与打包边界 | 实测 `.app` 内没有 `node_modules`；`npm audit --omit=dev` 为 0 vulnerabilities |
| 形象几何与可交互性 | CDP 实测：4068×4068 的模型在 320×460 窗口里缩放为 320×320 且完整落在窗口内（底部居中）；命中框也在窗口内；`refit()` 连调 4 次缩放值不变 |
| 重建形象不泄漏 | 连点 3 次「重新加载形象」：DOM 内 canvas 恒为 1、只有一个活的 `Application`、缩放保持正确（修复前是每次 +2 挂载、2 个 canvas，泄漏 WebGL 上下文） |
| 切换形象的贴图回收 | **修复前**贴图只增不减，浏览多个形象后 Pixi 的 `TextureCache` 累积全部贴图；**修复后**实测缓存数严格等于当前形象的贴图张数（当前为 1），重载后仍能正常渲染 |
| 反复切换不泄漏 | 30 次切换实测：渲染进程 RSS 爬到 526 MB 后**完全走平**（后 20 次只涨 1 MB），JS 堆恒定 61 MB（那时仓库里还有 14 张贴图的形象，所以水位高） |
| 对话链路 | 假 OpenAI 端点实测：主进程发出的请求体里 `systemPrompt` 已注入、渲染层伪造的 system 消息被剔除、`temperature: 99` 被夹取为 2、超时返回 `请求超时（1200 ms）` |
| 资源探测 | 实测在运行中删掉 Cubism Core → 降级并给出提示；放回后再点「重新加载形象」即恢复 Live2D，无需重启 |
| 本地资源加载 | 实测 `fetch` 在 `app://` 下可用（能取到文件内容），缺失文件返回可判断的 404，畸形转义返回 400 |
| 密钥隔离 | CDP 实测 `getConfig()` 返回的对象**不含 `ai` 段** |
| dev 模式 | 起 Vite server + Electron，CDP 实测页面挂载 canvas、`window.pet` 方法齐全、窗口尺寸与配置一致 |

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

**库的 `resetExpression()` 不更新自己的记账（这轮抓到的）**
`pixi-live2d-display` 的 `ExpressionManager.resetExpression()` 只把画面切回默认，**没有更新
`currentExpression`**。而 `setExpression()` 开头有一句「要设的正是当前表情就直接返回 false」：

```js
if (index === this.expressions.indexOf(this.currentExpression)) return false;
```

两件事凑在一起：点「还原默认」之后再点回刚才那个表情，会被判定为「已经是当前表情」，
直接返回 false 什么都不做 —— 表现为**点了没反应**，而且是「还原之后想再套回去」这条最自然的操作。
修法是在 `resetExpression()` 之后把 `currentExpression` 归位到 `defaultExpression`
（两个都是库类型声明里的 public 字段）。这是绕开库的实现疏漏，不是我们自己的状态。

**「名字不存在」和「已经是当前表情」都返回 false**
同一个 `setExpression()`，名字查不到（`getExpressionIndex` 返回 -1）也返回 false。
只看返回值根本分不清这两种情况，于是「你已经套着这个表情了」会被误报成「这个表情不存在」。
修法是先自己查一次表（`getExpressionIndex(name) < 0`）再动手，两种情况的提示才准确。

**形象清单扫错了目录（dev 专属）**
`modelsRoot()` 一开始固定按 `__dirname/../renderer/models` 找模型，但 dev 模式下渲染层由
Vite dev server 提供、模型来自 `src/renderer/public/models`，`out/renderer/models` 只是上一次
build 的残影。症状是：新加的模型渲染层明明加载得出来，托盘菜单里却看不见。
改为按 `ELECTRON_RENDERER_URL` 是否存在来区分两种运行方式。

**鼠标跟随从来没生效过（只留 Q版 A 那轮抓到的）**
配置里 `model.autoInteract` 一直开着，文档也把它写成「让模型自动跟随鼠标」，但它是**死配置**：
库把鼠标跟随挂在 Pixi 的 InteractionManager 上，而那个管理器监听的是 **canvas 的 DOM 事件**，
`style.css` 里为了让命中判定统一走 hitBox 逻辑，给 canvas 设了 `pointer-events: none` ——
事件永远不会以 canvas 为目标，这条链从头到尾收不到东西。

实测确认：在窗口里移动指针，`pointermove` 的 `event.target` 一直是 `pet-root`，从来不是 `CANVAS`。
修法不是在 canvas 上放开 `pointer-events`（那会把点击穿透与拖动两套逻辑一起牵扯进来），
而是在渲染层已有的窗口级 `pointermove` 上直接驱动 `model.focus()`（新增 `pet/lookAt.ts`），
并把传给库的 `autoInteract` 显式关掉 —— 顺便省掉 InteractionManager 每次指针移动对舞台做的命中检测。
指针离开窗口时把目光收回正中，否则它会一直盯着最后停下的那个角落。

> 验证这条踩了一个坑值得记下来：`Cubism4InternalModel.update()` 结尾会调 `model.loadParameters()`
> 把参数数组**倒回**动作开始前的状态，所以帧与帧之间 `getParameterValueById` 读到的一律是基础值，
> 跟 focus 毫无关系 —— 想证明「眼睛动了」只能比像素。最后是把 Ticker 停掉、用固定 dt 序列推进
> 同样多帧再逐像素比：指针换边后 11% 的像素发生变化，差异区域正好落在头/上半身。

**常驻程序稳定烧掉 27% 的 CPU（只留 Q版 A 那轮抓到的）**
起因是查别的 bug 时顺手 `top` 了一下，发现它一直在用四分之一个核。原因是
`pixi-live2d-display` 把模型的 `deltaTime` 累加挂在 `Ticker.shared` 上，而 Pixi 的 `Application`
默认会**自己新建一个 Ticker** —— 等于每帧跑两个 rAF 循环，而且限帧得设两处才管用。

修法是 `new PIXI.Application({ sharedTicker: true })` 让两者共用一个 Ticker：**27% → 24%**。

> **这里记一次错误的取舍，免得以后再犯。** 当时顺着「桌宠是常驻程序，30 fps 肉眼分不出来」
> 的思路，又把 `Ticker.shared.maxFPS` 钉在了 30，实测降到 17%，看起来是个漂亮的胜利。
> 结果是用户直接反馈「帧数低的离谱，卡卡的」—— 省电不能拿流畅度去换，尤其是**在没人要求省电的时候**。
> 已改回不限帧。
>
> 顺便把「还有没有别的杠杆」一次性测清楚了，省得下次再猜：
> - **分辨率没用**：resolution 2 / 1.5 / 1 → 24.4% / 24.3% / 24.8%
> - **抗锯齿没用**：`antialias: false` → 25.3%（比开着还高一点，噪声内）
> - **画布面积没用**：窗口 320×460 → 320×340，测不出差别
> - **限帧有副作用**：60 Hz 面板上 `maxFPS = 60` 只有 58.3 fps，`59` 只有 56.3 fps ——
>   它是「这一帧不够时间就跳过」的闸门，只有恰好等于刷新率时才不丢帧，所以最终选择不限帧。
>
> 结论：那 3.5 ms/帧的开销全在 Cubism 的骨骼/物理/网格更新里，除了降帧率没有别的杠杆。
> 真正能省的是**把形象隐藏起来**（托盘「显示 / 隐藏」）—— 实测隐藏后渲染进程直接掉到 **0.0%**，
> 因为 Chromium 在窗口不可见时会停掉 rAF。

> 顺带一个测量教训：`Ticker.FPS` 不能用来量真实帧率。Pixi 在 maxFPS 闸门**之前**就更新了
> `elapsedMS`，被跳过的帧同样把它写成 ~16.7 ms，于是读数在 30/60 之间乱跳。
> 只能给 `internalModel.update` 打桩计数（而且打桩必须幂等：重复包装一次，30 fps 会被数成 59 fps）。

**默认形象指向一个不存在的模型**
`DEFAULT_CONFIG.model.path` 还停在 `blue-cat/Blue cat.model3.json`，而 blue-cat 已经从仓库里去掉了。
新装的用户（或删掉配置文件的用户）会直接落到「模型文件不存在」的降级路径上。
已改成 `qpet-a/A_Qpet_90.model3.json`，同时配置文件模板里的示例改成从 `DEFAULT_CONFIG` 取，
不再手写一遍 —— 手写的那份就是这么过期的（`_readme` 里还留着 milestone 1 时代的 `sample/sample.model3.json`）。

**「重新加载形象」之后表情勾会撒谎**
重建渲染器会把表情清回默认，而主进程里那个「上次点了哪个表情」的变量不知道，
于是菜单里的勾会停在旧值上。修法是重载时一起清掉，顺便重建菜单（这样改了 `pet-model.json`
里的显示名也能立刻看到）。

**其余小问题**
- 窗口被关掉后（默认菜单的 Cmd+W）托盘「显示 / 隐藏」变成点了没反应的死按钮 → 改为自动重建窗口。
- 拖动过程中光标跑出命中框会切进点击穿透，鼠标松开的事件可能收不到、拖拽卡死 → 按住期间强制保持可交互。
- `app://` 协议遇到畸形百分号转义时 `decodeURIComponent` 抛异常，handler 直接 reject → 改为返回 400。
- 请求超时的文案只会说「超时（默认 ms）」，不显示真实毫秒数 → 传实际生效的超时值。
- 渲染层传来的 `temperature` / `maxTokens` / `timeoutMs` 没做范围校验，且 `NaN` 会漏过 `typeof` 检查 → 与配置文件同一套上下限夹取。
- 两条从不发送的 IPC 通道（`modelReloaded` / `requestReloadModel`）连同渲染层的订阅一起删掉了：
  形象重建早就统一走 `configChanged`，留着只是让「改哪里才会重建」变得难查。
- `pet-model.json` 的坏数据、模型目录里读不动的目录都会被跳过而不是抛出 —— 托盘是唯一入口，菜单构建失败等于应用没法操作。


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
- 帧率**不设上限**，跟着显示器刷新率走（`Live2DRenderer.ts` 里的 `TARGET_FPS = 0`；
  60 Hz 面板上就是 60 fps）。为什么刻意不写 60、以及 30 fps 那次错误取舍的完整记录，
  见上面的修复记录。可见时稳定占一个核的 24%，隐藏后是 0.0%。
  （模型是**一直在动**的：呼吸 `CubismBreath` 和眨眼 `CubismEyeBlink` 由库逐帧驱动，
  所以「这一帧画面没变就跳过」这类优化根本用不上。）
- 点击穿透的命中判定用的是模型包围盒（内缩 15%），不是逐像素 alpha 判定；
  形象边缘的透明区域仍会挡住鼠标。逐像素判定留待后续优化。
  （当前形象是 4068×4068 的正方形，在 320×460 的窗口里只占下面 320 px ——
  上面那 140 px 是空的且可穿透，只是拖不动。想贴合可以把 `window.height` 改成 340。）
- 切换形象会重建整个 Pixi 应用（连带一个新的 WebGL 上下文）。仓库里现在只有一个形象，
  这条路径实际用不上；要更低只能把贴图再降一档或改成复用同一个 Pixi 实例。
- 套用的表情不会持久化，也不会跨形象保留：点「重新加载形象」或「切换形象」都会重建渲染器，
  表情随之回到默认（菜单里的勾会一起清掉，不会再停在旧值上）。
- 对话只实现了非流式一次性请求，UI 未接入。
- Live2D 只支持 Cubism 4/5（`.model3.json` + `.moc3`），Cubism 2.1 未接入。

## 路线图

- [x] **里程碑 1**：可运行骨架（透明置顶窗、形象渲染层 + 降级、拖动、托盘、配置、Provider 抽象）
- [x] **跟随鼠标**：目光/头部跟随指针（`model.autoInteract`，见修复记录里那条「从来没生效过」）
- [ ] **里程碑 2**：对话接入（气泡 UI、流式输出、上下文管理、会话持久化）
- [ ] **里程碑 3**：语音（TTS 说话 + 口型同步，可选 ASR 唤醒）
- [ ] **里程碑 4**：主动行为（空闲动作、日程提醒、打包分发）

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
