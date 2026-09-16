# Live2D 模型放这里

每个模型一个子目录，例如：

```
models/
└── haru/
    ├── haru.model3.json      ← 入口文件
    ├── haru.moc3
    ├── haru.physics3.json
    ├── haru.cdi3.json
    └── textures/
        └── texture_00.png
```

然后在配置文件里的 `model.path` 指向入口文件（**相对本目录**）：

```json
{
  "model": {
    "mode": "auto",
    "path": "haru/haru.model3.json",
    "idleMotionGroup": "Idle",
    "autoInteract": true
  }
}
```

## 目录约定

- 只支持 **Cubism 4/5**（`.model3.json` + `.moc3`）。Cubism 2.1 的 `.model.json` 走的是另一套 SDK，当前未接入。
- 路径不要以 `/` 开头，渲染层会自动加上 `models/` 前缀。
- 改完配置后从托盘菜单点「重新加载形象」即可生效，不用重启。

## 还没有模型？

先用占位形象即可 —— 把 `model.mode` 设为 `"placeholder"`，或者在没有任何模型文件时保持 `"auto"`，
渲染层会自动降级并在窗口上说明原因。

模型来源请注意各自的授权协议：官方示例模型（Haru / Hiyori / Mao 等）随 SDK 分发，
商用前需要确认其许可；自制或购买模型请一并把许可文件放进该目录。
