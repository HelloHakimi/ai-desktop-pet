# Live2D 模型放这里

每个模型一个子目录。仓库里现在有 6 个（`blue-cat` / `yuuri` / `cotton` / `honey-peach` /
`qpet-a` / `qpet-b`），共约 95 MB。

```
models/
└── yuuri/
    ├── pet-model.json          ← 清单：菜单显示名 + 待机动作组名
    ├── yuuri.model3.json       ← 入口文件
    ├── yuuri.moc3
    ├── Yuuri.physics3.json
    ├── Yuuri.cdi3.json
    ├── Yuuri.2048/             ← 贴图（目录名里的数字是边长）
    │   └── texture_00.png …
    ├── motions/
    │   ├── idle.motion3.json
    │   └── wave.motion3.json
    └── expressions/
        └── Heart.exp3.json
```

## 目录约定

- 只支持 **Cubism 4/5**（`.model3.json` + `.moc3`）。Cubism 2.1 的 `.model.json` 走的是另一套 SDK，当前未接入。
- **模型目录的顶层必须正好有一个 `*.model3.json`** —— 那就是入口。子目录里的不算，放素材用的。
- 路径不要以 `/` 开头，渲染层会自动加上 `models/` 前缀。

## 加一个新模型

托盘菜单里的「切换形象」是**每次打开菜单时扫这个目录**得到的，不是在代码里写死列表 ——
所以往这里丢一个新目录，不用改代码、不用重新构建、不用重启，菜单里就会出现。
菜单里的「切换形象 → 打开模型文件夹…」可以直接在访达里打开这个目录。

不过模型多半是给 VTube Studio 用的，直接拷进来会得到一个不会动、不眨眼、表情全空的花瓶
（动作和表情登记在 `.vtube.json` 里，而 `pixi-live2d-display` 不读那个文件）。
所以用脚本装：

```bash
python3 scripts/install-model.py <源模型目录> <目标目录名> --name "菜单里的名字"
```

它会挑文件、把贴图降到 2048、从 `.vtube.json` 补全 `model3.json` 的
`Motions` / `Expressions` / `Groups`，最后写一份 `pet-model.json`。

从 GBK 编码的 Windows 压缩包里解出来的话，用 `ditto -x -k` 或 Python 的 `zipfile`
显式按 GBK 解码文件名 —— `unzip` 会解出一堆乱码名字。

## pet-model.json

```json
{
  "name": "水色小猫咪",
  "idleMotionGroup": "Idle"
}
```

| 字段 | 说明 |
| --- | --- |
| `name` | 托盘菜单里显示的名字。缺省时用目录名。 |
| `idleMotionGroup` | 待机动作组名，对应 `model3.json` 里 `FileReferences.Motions` 的键。没有待机动作就留空字符串。 |

这个文件坏了不会让托盘菜单挂掉 —— 会退回用目录名，并在主进程日志里留一行警告。

`idleMotionGroup` 建议保持 `"Idle"`：`pixi-live2d-display` 内部用 `groups.idle = "Idle"`
识别待机动作，只有在待机动作播完之后它会自动接上下一个。

## 表情怎么试

托盘菜单 →「试个表情」。列的就是这个模型 `model3.json` 里 `FileReferences.Expressions` 登记的名字，
换形象菜单跟着换；末尾有「随机一个」和「还原默认」。

所以**想让一个表情能被试到，只要把它登记进 `model3.json`**：

```json
"Expressions": [
  { "Name": "脸红", "File": "脸红.exp3.json" }
]
```

`Name` 是渲染层查找用的键，可以任意取（不必等于文件名）。`scripts/install-model.py`
就是从 `.vtube.json` 的热键表里自动生成这一段，并顺手把 `Motions` / `Groups` 一起补上。

## 还没有模型？

先用占位形象即可 —— 把 `model.mode` 设为 `"placeholder"`，或者在没有任何模型文件时保持 `"auto"`，
渲染层会自动降级并在窗口上说明原因。

## 排查

主进程启动时会打印三行日志，用来区分「目录扫错了」「清单没写对」和「表情没登记上」：

```
[tray] 模型目录：/Users/zwj/桌宠/src/renderer/public/models
[tray] 可用形象 6 个：水色小猫咪、晚安少女、桃瑟古风、Q版 A、Q版 B、Yuuri
[tray] 当前形象：qpet-a/A_Qpet_90.model3.json（表情 40 个）
```

注意 **dev 与打包后扫的不是同一个目录**：dev 下是源码里的 `src/renderer/public/models`
（渲染层由 Vite dev server 提供），打包后是 `.app` 内的 `out/renderer/models`。
`npm run build` 会把模型同步过去。

模型来源请注意各自的授权协议：官方示例模型（Haru / Hiyori / Mao 等）随 SDK 分发，
商用前需要确认其许可；自制或购买模型请一并把许可文件放进该目录。
