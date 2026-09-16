#!/usr/bin/env python3
"""把 Live2D 模型的贴图降采样，并同步改掉 model3.json 里的引用。

为什么需要它：模型自带的贴图往往是 4096²，而桌宠只把形象渲染在 245×460 的区域里，
实际只需要约 2.25 texel/像素 —— 4096 有一半以上的分辨率是白解码、白占显存的。
实测 5 张 4096² 降到 2048² 之后，常驻内存从 924 MB 降到 577 MB，
而画面在 3 倍放大下逐像素对比平均通道差只有 1.14/255。

做三件事（顺序不能反）：
  1. sips 缩放贴图
  2. 贴图目录改名（名字里带着分辨率，不改会和引用对不上）
  3. 改 model3.json 的 FileReferences.Textures

用法：
  python3 scripts/downscale-textures.py <模型目录> <边长>
  python3 scripts/downscale-textures.py src/renderer/public/models/blue-cat 2048

依赖 macOS 自带的 sips。跑之前建议先备份原始贴图（原图压不回细节）。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path


def find_texture_dir(model_dir: Path) -> Path:
    """贴图目录形如 '<名称>.4096'，靠后缀里的纯数字识别"""
    for child in sorted(model_dir.iterdir()):
        if not child.is_dir():
            continue
        suffix = child.name.rsplit(".", 1)[-1]
        if suffix.isdigit():
            return child
    raise SystemExit(f"在 {model_dir} 下没找到形如 xxx.4096 的贴图目录")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)

    model_dir = Path(sys.argv[1]).resolve()
    edge = sys.argv[2]
    if not edge.isdigit():
        raise SystemExit("边长必须是数字，例如 2048")

    tex_dir = find_texture_dir(model_dir)
    old_edge = tex_dir.name.rsplit(".", 1)[-1]
    if old_edge == edge:
        raise SystemExit(f"贴图已经是 {edge} 了，无需处理")
    if not shutil.which("sips"):
        raise SystemExit("找不到 sips（这个脚本依赖 macOS 自带工具）")

    pngs = sorted(tex_dir.glob("*.png"))
    if not pngs:
        raise SystemExit(f"{tex_dir} 里没有 png")

    before = sum(p.stat().st_size for p in pngs)
    for png in pngs:
        subprocess.run(["sips", "-Z", edge, str(png), "--out", str(png)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print(f"  {png.name} -> {png.stat().st_size / 1024 / 1024:.1f} MB")
    after = sum(p.stat().st_size for p in pngs)

    new_dir = tex_dir.with_name(f"{tex_dir.name.rsplit('.', 1)[0]}.{edge}")
    tex_dir.rename(new_dir)

    # 引用必须跟着改，否则模型加载时按老路径去取贴图，直接 404
    patched = []
    for model3 in sorted(model_dir.glob("*.model3.json")):
        data = json.loads(model3.read_text(encoding="utf-8"))
        textures = data.get("FileReferences", {}).get("Textures", [])
        changed = False
        for i, path in enumerate(textures):
            if path.startswith(f"{tex_dir.name}/"):
                textures[i] = path.replace(f"{tex_dir.name}/", f"{new_dir.name}/", 1)
                changed = True
        if changed:
            model3.write_text(
                json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            patched.append(model3.name)

    print(f"\n贴图边长   : {old_edge} -> {edge}")
    print(f"目录       : {tex_dir.name}/ -> {new_dir.name}/")
    print(f"文件体积   : {before / 1024 / 1024:.1f} MB -> {after / 1024 / 1024:.1f} MB")
    print(f"解码驻留   : 约 {5 * int(old_edge) ** 2 * 4 / 1024 / 1024:.0f} MB -> "
          f"{5 * int(edge) ** 2 * 4 / 1024 / 1024:.0f} MB（按 5 张贴图估算）")
    print(f"已改引用   : {', '.join(patched) if patched else '（无）'}")


if __name__ == "__main__":
    main()
