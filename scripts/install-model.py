#!/usr/bin/env python3
"""把一个 Live2D 模型装进桌宠的模型目录，并补齐它缺少的运行时元数据。

为什么需要它：这些模型都是给 VTube Studio 用的。VTube 把「动作、表情、眨眼参数」
记在自己的 .vtube.json 里，而 pixi-live2d-display 只认 model3.json —— 直接搬过来
会得到一个不会动、不会眨眼、表情全空的花瓶。这个脚本负责把信息搬运过去。

四件事（顺序不能反）：
  1. 只挑运行时真正需要的文件复制过去（跳过 UI 图、插画、psd、图标）
  2. 调 downscale-textures.py 把贴图降采样
  3. 补全 model3.json：Motions / Expressions / Groups
  4. 写 pet-model.json 清单（托盘里显示的名字、待机动作组名）

用法：
  python3 scripts/install-model.py <源模型目录> <目标目录名> --name "托盘显示名"
  python3 scripts/install-model.py /tmp/extract/MyModel my-model --name "我的形象"

源模型目录必须正好含有一个 *.model3.json（在其顶层）。
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODELS_ROOT = REPO_ROOT / "src/renderer/public/models"
DOWNSCALE = REPO_ROOT / "scripts/downscale-textures.py"

# VTube 的 Input 名 → model3.json 的 Groups。眨眼和口型必须声明，
# 否则跑动作时这两组参数会被动作完全接管，看起来就是「动起来就不眨眼了」。
EYEBLINK_INPUTS = {"EyeOpenLeft", "EyeOpenRight"}
LIPSYNC_INPUTS = {"MouthOpen"}
# .vtube.json 缺失时，退回到按参数 ID 命名约定猜
EYEBLINK_ID_HINTS = ("ParamEyeLOpen", "ParamEyeROpen")
LIPSYNC_ID_HINTS = ("ParamMouthOpenY", "ParamMouthOpen", "ParamMouthA")

MODEL_MANIFEST = "pet-model.json"


def fail(message: str) -> "None":
    raise SystemExit(f"错误：{message}")


def find_model3(src: Path) -> Path:
    found = sorted(src.glob("*.model3.json"))
    if not found:
        fail(f"{src} 顶层没有 *.model3.json（是不是指到了父目录？）")
    if len(found) > 1:
        names = "、".join(p.name for p in found)
        fail(f"{src} 顶层有多个 model3.json，无法判断用哪个：{names}")
    return found[0]


def load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"读取 {path} 失败：{error}")


def referenced_files(model3: dict) -> list[str]:
    """model3.json 里所有指向独立文件的引用（贴图、moc3、物理、姿势…）"""
    refs: list[str] = []
    for key, value in (model3.get("FileReferences") or {}).items():
        # Motions/Expressions 交给后面单独处理
        if key in ("Motions", "Expressions"):
            continue
        if isinstance(value, str) and value:
            refs.append(value)
        elif isinstance(value, list):
            refs.extend(v for v in value if isinstance(v, str) and v)
    return refs


def build_copy_plan(src: Path, model3: dict, entry: Path) -> list[Path]:
    """运行时需要的文件：入口 + 显式引用 + 全部动作/表情 + vtube.json（留作再加工的源）"""
    plan: list[Path] = [entry]

    for ref in referenced_files(model3):
        candidate = src / ref.replace("\\", "/")
        if candidate.is_file():
            plan.append(candidate)
        else:
            print(f"  ! 引用找不到，跳过：{ref}")

    plan.extend(sorted(src.rglob("*.motion3.json")))
    plan.extend(sorted(src.rglob("*.exp3.json")))

    vtube = sorted(src.glob("*.vtube.json"))
    plan.extend(vtube)

    # 去重但保持顺序
    seen: set[Path] = set()
    unique: list[Path] = []
    for path in plan:
        if path not in seen:
            seen.add(path)
            unique.append(path)
    return unique


def copy_files(src: Path, dst: Path, files: list[Path]) -> None:
    for path in files:
        target = dst / path.relative_to(src)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)


def build_index(dst: Path) -> dict[str, str]:
    """文件名 → 相对模型目录的路径。VTube 的引用只写文件名，不带子目录。"""
    index: dict[str, str] = {}
    for path in sorted(dst.rglob("*")):
        if path.is_file():
            index.setdefault(path.name, path.relative_to(dst).as_posix())
    return index


def pick_idle_files(index: dict[str, str], vtube: dict | None) -> list[str]:
    """待机动作：优先听 vtube 的 IdleAnimation，其次按文件名猜"""
    if vtube:
        ref = str((vtube.get("FileReferences") or {}).get("IdleAnimation") or "")
        if ref:
            hit = index.get(Path(ref.replace("\\", "/")).name)
            if hit:
                return [hit]

    guesses: list[str] = []
    for name, rel in sorted(index.items()):
        if not name.endswith(".motion3.json"):
            continue
        if "idle" in name.lower() or name.startswith("待机"):
            guesses.append(rel)
    return guesses


def build_motions(index: dict[str, str], vtube: dict | None) -> dict:
    idle = pick_idle_files(index, vtube)
    motions: dict[str, list[dict]] = {}

    if idle:
        # Idle 这个组名不能改：pixi-live2d-display 内部用 groups.idle = "Idle"
        # 来识别待机动作，换名字它就不会自动接管了。
        motions["Idle"] = [
            {"File": rel, "FadeInTime": 0.6, "FadeOutTime": 0.6} for rel in idle
        ]

    idle_set = set(idle)
    others = sorted(
        rel
        for name, rel in index.items()
        if name.endswith(".motion3.json") and rel not in idle_set
    )
    if others:
        # 其余动作打包成一组，将来点击形象可以随机抽一个播
        motions["Tap"] = [
            {"File": rel, "FadeInTime": 0.4, "FadeOutTime": 0.4} for rel in others
        ]
    return motions


def build_expressions(index: dict[str, str], vtube: dict | None) -> list[dict]:
    """表情：vtube 的热键表带可读名字，先从它来；剩下的按文件名补"""
    expressions: list[dict] = []
    used: set[str] = set()
    names: set[str] = set()

    def add(display_name: str, rel: str) -> None:
        name = display_name.strip() or Path(rel).name[: -len(".exp3.json")]
        # 重名会让 model.expression(name) 永远只命中第一个，加后缀区分
        if name in names:
            suffix = 2
            while f"{name} ({suffix})" in names:
                suffix += 1
            name = f"{name} ({suffix})"
        names.add(name)
        used.add(rel)
        expressions.append({"Name": name, "File": rel})

    if vtube:
        for hotkey in vtube.get("Hotkeys") or []:
            if hotkey.get("Action") != "ToggleExpression":
                continue
            ref = str(hotkey.get("File") or "")
            if not ref:
                continue
            rel = index.get(Path(ref.replace("\\", "/")).name)
            if rel and rel not in used and rel.endswith(".exp3.json"):
                add(str(hotkey.get("Name") or ""), rel)

    for name, rel in sorted(index.items()):
        if name.endswith(".exp3.json") and rel not in used:
            add("", rel)

    expressions.sort(key=lambda item: item["Name"])
    return expressions


def cdi_parameter_ids(dst: Path, index: dict[str, str]) -> set[str]:
    """cdi3.json 里的参数表，用于在 vtube.json 缺失时按 ID 命名约定兜底"""
    rel = next((rel for name, rel in index.items() if name.endswith(".cdi3.json")), None)
    if not rel:
        return set()
    data = load_json(dst / rel)
    return {str(p.get("Id", "")) for p in data.get("Parameters") or []}


def build_groups(vtube: dict | None, cdi_ids: set[str], model3: dict) -> list[dict]:
    """眨眼 / 口型参数组：优先从 vtube 的参数映射推，其次从 cdi3 的参数表推"""
    blink: list[str] = []
    lipsync: list[str] = []

    for setting in (vtube or {}).get("ParameterSettings") or []:
        out = str(setting.get("OutputLive2D") or "")
        source = str(setting.get("Input") or "")
        if not out:
            continue
        if source in EYEBLINK_INPUTS and out not in blink:
            blink.append(out)
        if source in LIPSYNC_INPUTS and out not in lipsync:
            lipsync.append(out)

    if not blink:
        blink = [i for i in EYEBLINK_ID_HINTS if i in cdi_ids]
    if not lipsync:
        lipsync = [i for i in LIPSYNC_ID_HINTS if i in cdi_ids]

    # 还是推导不出来就沿用模型原本声明的（过滤掉空 Ids 的占位组）
    if not blink or not lipsync:
        for group in model3.get("Groups") or []:
            ids = [str(i) for i in group.get("Ids") or []]
            if not ids:
                continue
            if group.get("Name") == "EyeBlink" and not blink:
                blink = ids
            elif group.get("Name") == "LipSync" and not lipsync:
                lipsync = ids

    groups: list[dict] = []
    if lipsync:
        groups.append({"Target": "Parameter", "Name": "LipSync", "Ids": lipsync})
    if blink:
        groups.append({"Target": "Parameter", "Name": "EyeBlink", "Ids": sorted(blink)})
    return groups


def main() -> None:
    parser = argparse.ArgumentParser(
        description="把 Live2D 模型装进桌宠并补齐运行时元数据",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("source", type=Path, help="源模型目录")
    parser.add_argument("slug", help="目标目录名，例如 qpet-a")
    parser.add_argument("--name", default="", help="托盘里显示的名字，默认用 slug")
    parser.add_argument("--texture-size", default="2048", help="贴图边长，默认 2048")
    parser.add_argument(
        "--models-root", type=Path, default=DEFAULT_MODELS_ROOT, help="模型根目录"
    )
    parser.add_argument(
        "--keep-textures", action="store_true", help="不降采样，保留原始贴图分辨率"
    )
    args = parser.parse_args()

    src = args.source.resolve()
    if not src.is_dir():
        fail(f"源目录不存在：{src}")

    dst = args.models_root.resolve() / args.slug
    if dst.exists():
        fail(f"目标目录已存在：{dst}（先删掉它再重跑）")

    model3_src = find_model3(src)
    model3 = load_json(model3_src)
    print(f"源    : {src}")
    print(f"入口  : {model3_src.name}")
    print(f"目标  : {dst}")

    files = build_copy_plan(src, model3, model3_src)
    print(f"\n[1/4] 复制 {len(files)} 个文件")
    dst.mkdir(parents=True)
    try:
        copy_files(src, dst, files)

        vtube_rel = next(
            (rel for name, rel in build_index(dst).items() if name.endswith(".vtube.json")),
            None,
        )
        vtube = load_json(dst / vtube_rel) if vtube_rel else None
        if vtube is None:
            print("  ! 没有 .vtube.json，动作/表情只能按文件名推断")

        print("\n[2/4] 贴图")
        if args.keep_textures:
            print("  按 --keep-textures 跳过")
        else:
            result = subprocess.run(
                [sys.executable, str(DOWNSCALE), str(dst), args.texture_size],
                capture_output=True,
                text=True,
            )
            print("\n".join("  " + line for line in result.stdout.rstrip().splitlines()))
            if result.returncode != 0:
                fail(f"降采样失败：{result.stderr.strip() or result.stdout.strip()}")

        print("\n[3/4] 补全 model3.json")
        index = build_index(dst)
        # 降采样会改贴图目录名，所以必须重新读一遍
        model3 = load_json(dst / model3_src.name)
        refs = model3.setdefault("FileReferences", {})

        motions = build_motions(index, vtube)
        if motions:
            refs["Motions"] = motions
        expressions = build_expressions(index, vtube)
        if expressions:
            refs["Expressions"] = expressions
        groups = build_groups(vtube, cdi_parameter_ids(dst, index), model3)
        if groups:
            model3["Groups"] = groups

        (dst / model3_src.name).write_text(
            json.dumps(model3, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"  动作组  : {', '.join(f'{k}({len(v)})' for k, v in motions.items()) or '无'}")
        print(f"  表情    : {len(expressions)} 个")
        for group in groups:
            print(f"  {group['Name']:8}: {', '.join(group['Ids'])}")

        print("\n[4/4] 写清单")
        idle_group = "Idle" if motions.get("Idle") else ""
        manifest = {
            "_readme": "托盘里显示的名字。改完保存，下次启动或切换形象时生效。",
            "name": args.name or args.slug,
            "idleMotionGroup": idle_group,
        }
        (dst / MODEL_MANIFEST).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"  {MODEL_MANIFEST}: name={manifest['name']!r} idleMotionGroup={idle_group!r}")

    except BaseException:
        # 中途失败不留半个模型目录，否则托盘会扫到一个加载不出来的残骸
        shutil.rmtree(dst, ignore_errors=True)
        raise

    size = sum(p.stat().st_size for p in dst.rglob("*") if p.is_file())
    print(f"\n完成：{dst.relative_to(args.models_root.resolve())}（{size / 1024 / 1024:.1f} MB）")


if __name__ == "__main__":
    main()
