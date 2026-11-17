#!/usr/bin/env python3
"""从 DeepSeek 官方导出的 ZIP 中裁剪出部分会话，生成可导入的小 ZIP。

归档结构（export_format_version 3）：
    manifest.json                     第一个条目
    user.json                         可选，导入时跳过
    chat_sessions/{sid}.json          每个会话
    chat_session_index.json           会话索引，须与保留的会话一一对应
    chat_sessions/{sid}_files/...     图片原件

会话 JSON 按原始字节写出。导入方另有约束：manifest 版本须等于 3、
索引与会话一一对应、仅支持 ZIP32。

用法：
    python split-official-export.py --src deepseek_data-YYYY-MM-DD.zip --out demo.zip
    python split-official-export.py --src big.zip --out demo.zip --auto 5
    python split-official-export.py --src big.zip --out demo.zip --pick a9bf61e1 b08c8556
"""
from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path

MANIFEST = "manifest.json"
INDEX = "chat_session_index.json"
VERSION = 3


def list_sessions(z: zipfile.ZipFile) -> dict[str, str]:
    """会话 id 前 8 位 → zip 内条目名"""
    out = {}
    for n in z.namelist():
        if n.startswith("chat_sessions/") and n.endswith(".json") and "_files/" not in n:
            out[Path(n).stem[:8]] = n
    return out


def describe(z: zipfile.ZipFile, name: str, infos: dict) -> dict:
    raw = z.read(name)
    data = json.loads(raw)
    msgs = data.get("messages") or []
    types = {f.get("type") for m in msgs for f in (m.get("fragments") or [])}
    sid = data["id"]
    attach = [(n, infos[n].file_size) for n in infos if n.startswith(f"chat_sessions/{sid}_files/")]
    return {
        "sid": sid, "name": name, "data": data, "raw": raw,
        "messages": len(msgs), "types": types,
        # 轮次按模型回复条数计
        "turns": sum(1 for m in msgs if m.get("role") == "ASSISTANT"),
        "json_kb": len(raw) / 1024, "attach": attach,
    }


def passes_turn_filter(info: dict, args: argparse.Namespace) -> bool:
    if info["turns"] < args.min_turns:
        return False
    if args.max_turns and info["turns"] > args.max_turns:
        return False
    return True


def score(info: dict) -> int:
    """自动挑选时的打分：工具步骤 > 读链接 > 思考 > 轮次适中 > 体积小"""
    v = 0
    t = info["types"]
    if "READ_LINK" in t:
        v += 100
    if "TOOL_SEARCH" in t:
        v += 40
    if "TOOL_OPEN" in t:
        v += 30
    if "THINK" in t:
        v += 20
    if "FILE" in t:
        v += 15
    if 4 <= info["messages"] <= 40:
        v += 30
    elif info["messages"] > 80:
        v -= 40
    v += max(0, 20 - int(info["json_kb"] / 25))
    return v


def main() -> int:
    ap = argparse.ArgumentParser(description="裁剪 DeepSeek 官方导出 ZIP")
    ap.add_argument("--src", required=True, help="官方导出的大 ZIP")
    ap.add_argument("--out", required=True, help="输出的 demo ZIP")
    ap.add_argument("--pick", nargs="*", help="指定会话 id 前缀（不指定则自动挑选）")
    ap.add_argument("--auto", type=int, default=5, help="自动挑选的会话数，默认 5")
    ap.add_argument("--min-turns", type=int, default=0, help="只保留模型回复条数 >= N 的会话")
    ap.add_argument("--max-turns", type=int, default=0, help="只保留模型回复条数 <= N 的会话（0 不限）")
    ap.add_argument("--max-json-kb", type=int, default=700, help="单个会话 JSON 上限")
    ap.add_argument("--max-attach-kb", type=int, default=400, help="单个附件上限，超过不打包")
    ap.add_argument("--list", action="store_true", help="只列出候选，不生成")
    args = ap.parse_args()

    src, out = Path(args.src), Path(args.out)
    if not src.exists():
        print(f"源文件不存在: {src}")
        return 1

    with zipfile.ZipFile(src) as z:
        infos = {i.filename: i for i in z.infolist()}
        index = json.loads(z.read(INDEX))
        sessions = list_sessions(z)

        if args.pick:
            chosen = []
            for p in args.pick:
                name = sessions.get(p[:8])
                if not name:
                    print(f"⚠ 未找到会话 {p}，跳过")
                    continue
                info = describe(z, name, infos)
                if not passes_turn_filter(info, args):
                    print(f"⚠ 会话 {p[:8]} 轮次 {info['turns']} 不满足筛选条件，跳过")
                    continue
                chosen.append(info)
        else:
            cands = []
            skipped_turns = 0
            for prefix, name in sessions.items():
                if infos[name].file_size > args.max_json_kb * 1024:
                    continue
                info = describe(z, name, infos)
                if not passes_turn_filter(info, args):
                    skipped_turns += 1
                    continue
                cands.append(info)
            if skipped_turns:
                print(f"轮次筛选排除 {skipped_turns} 个会话")
            cands.sort(key=score, reverse=True)
            chosen = cands[: args.auto]

        if args.list:
            for c in sorted(chosen, key=score, reverse=True):
                print(f"{c['sid'][:8]}  {c['turns']:3d} 轮 / {c['messages']:3d} 条  "
                      f"{c['json_kb']:7.1f}KB  {c['data'].get('title')}")
                print(f"          {','.join(sorted(x for x in c['types'] if x))}")
            return 0

        print(f"选中 {len(chosen)} 个会话:\n")
        for c in chosen:
            print(f"  {c['sid'][:8]}  {c['turns']:3d} 轮 / {c['messages']:3d} 条  "
                  f"{c['json_kb']:7.1f}KB  {c['data'].get('title')}")
            print(f"      {','.join(sorted(x for x in c['types'] if x))}")
            kept = [(n, s) for n, s in c["attach"] if s <= args.max_attach_kb * 1024]
            if c["attach"]:
                print(f"      附件 {len(c['attach'])} 个 → 带入 {len(kept)} 个 "
                      f"/ {sum(s for _, s in kept)/1024:.0f}KB")
            print()

        sel = {c["sid"] for c in chosen}
        new_index = [e for e in index if e.get("id") in sel]
        print(f"索引: {len(index)} → {len(new_index)} 条")

        out.parent.mkdir(parents=True, exist_ok=True)
        count = 0
        with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as o:
            # manifest 必须第一个
            o.writestr(MANIFEST, json.dumps({"export_format_version": VERSION}, separators=(",", ":")))
            for c in chosen:
                o.writestr(c["name"], c["raw"])
            o.writestr(INDEX, json.dumps(new_index, ensure_ascii=False, separators=(",", ":")))
            for c in chosen:
                for n, s in c["attach"]:
                    if s <= args.max_attach_kb * 1024:
                        o.writestr(n, z.read(n))
                        count += 1

    size = out.stat().st_size
    print(f"\n已写出 {out}")
    print(f"  {size/1024/1024:.2f} MB | 条目 {len(chosen)+2+count} 个（附件 {count}）")
    print(f"  原包 {src.stat().st_size/1024/1024:.1f} MB → 缩小 {src.stat().st_size/size:.0f} 倍")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
