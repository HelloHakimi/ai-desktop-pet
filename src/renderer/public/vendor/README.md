# Cubism Core（运行时核心）

这个目录用于存放 Live2D Cubism Core —— **仓库里不含该文件**，请运行：

```bash
npm run setup:live2d
```

脚本会从官方地址下载 `live2dcubismcore.min.js` 到这里，`index.html` 之外由渲染层按需注入。

## 为什么不让仓库直接带上它

Cubism Core 由 Live2D 官方单独分发，许可条款与 SDk 代码不同（不可作为独立文件再分发）。
因此仓库只提供下载脚本，产物已写入 `.gitignore`。下载并使用即表示接受官方条款：
<https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_cn.html>

## 缺失时会怎样

渲染层的 `Live2DRenderer` 会探测这个文件：

- 文件不在 → 自动降级为占位形象，窗口上会显示原因，不会白屏也不会崩。
- 文件在但模型缺失 → 同样降级，并提示模型路径问题。

如果配置里把 `model.mode` 显式设成 `"live2d"`，则不静默降级，而是把错误原因直接显示在窗口上。
