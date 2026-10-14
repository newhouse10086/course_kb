# -*- coding: utf-8 -*-
"""提交前安全核验（**通用版，本文件不含任何真实凭据**）。

设计要点：
  · 真实凭据从 `.env` **读取**，不硬编码（否则扫描器自己就成了泄露源 —— 踩过）
  · 额外做通用形态检测（`sk-` 长串 / Bearer / password 赋值）
  · 只输出结论与打码后的位置，**不打印凭据内容**

用法：
    python tools/precommit_secret_scan.py            # 扫 git 暂存区
    python tools/precommit_secret_scan.py --all      # 扫工作区全部文件
"""
import io
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env_secrets():
    """从 .env 读取所有值，作为「真值黑名单」。**只返回值，不打印。**"""
    secrets = []
    for name in (".env", ".env.local"):
        fp = os.path.join(ROOT, name)
        if not os.path.exists(fp):
            continue
        for ln in io.open(fp, encoding="utf-8", errors="replace"):
            ln = ln.strip()
            if not ln or ln.startswith("#") or "=" not in ln:
                continue
            k, v = ln.split("=", 1)
            v = v.strip()
            # 只把「像凭据」的值纳入黑名单（避免把 URL/模型名当成凭据）
            if len(v) >= 12 and re.search(r"[A-Za-z0-9_-]{12,}", v):
                secrets.append(v)
    return secrets


def mask(s):
    return s[:8] + "…" + s[-4:] if len(s) > 14 else s[:6] + "…"


def git(args):
    return subprocess.run(["git"] + args, cwd=ROOT, capture_output=True,
                          text=True, encoding="utf-8", errors="replace")


def scan_text(text, secrets):
    """返回命中的 (类型, 打码值) 列表。"""
    hits = []
    for s in secrets:
        if s in text:
            hits.append(("env-value", mask(s)))
    for pat, label in (
        (r"sk-[A-Za-z0-9_-]{20,}", "sk-token"),
        (r"Bearer\s+[A-Za-z0-9_.-]{24,}", "bearer"),
        (r"password\s*[:=]\s*[\"'][^\"']{8,}[\"']", "password-literal"),
    ):
        for m in re.finditer(pat, text):
            val = m.group(0)
            # 占位符/显然的假值放行
            if re.search(r"(REPLACE_ME|fake|test|example|placeholder|super-secret|leak-me)",
                         val, re.I):
                continue
            hits.append((label, mask(val)))
    return hits


def main():
    use_all = "--all" in sys.argv
    secrets = load_env_secrets()

    print("=" * 72)
    print("提交前安全核验（通用版）")
    print("=" * 72)
    print(f"  黑名单来源: .env 中 {len(secrets)} 个值（**不回显**）")

    if use_all:
        targets = []
        for root, dirs, files in os.walk(ROOT):
            dirs[:] = [d for d in dirs if d not in
                       {"node_modules", "__pycache__", ".git", "data", "dist",
                        ".pytest_cache", "coverage"}]
            for fn in files:
                if fn.endswith((".md", ".ts", ".py", ".json", ".yaml", ".yml",
                                ".js", ".vue", ".html", ".txt", ".sh")):
                    targets.append(os.path.relpath(os.path.join(root, fn), ROOT))
    else:
        r = git(["diff", "--cached", "--name-only"])
        targets = [f for f in r.stdout.split("\n") if f.strip()]

    print(f"  扫描目标  : {'工作区' if use_all else 'git 暂存区'} {len(targets)} 个文件")
    print()

    bad = {}
    for rel in targets:
        fp = os.path.join(ROOT, rel)
        if not os.path.isfile(fp):
            continue
        try:
            text = io.open(fp, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        hits = scan_text(text, secrets)
        if hits:
            bad[rel] = hits

    if bad:
        print("  ❌ 发现疑似凭据：")
        for rel, hits in bad.items():
            print(f"     {rel}")
            for kind, masked in hits:
                print(f"        [{kind}] {masked}")
    else:
        print("  ✅ 未发现任何凭据")

    # 额外：确认 .env 本身不会被提交
    print()
    if not use_all:
        envs = [f for f in targets if os.path.basename(f).startswith(".env")]
        print(f"  {'❌ ' + str(envs) if envs else '✅ 暂存区无 .env'}")
        if envs:
            bad["<.env staged>"] = [("staged", ".env")]

    print()
    print("=" * 72)
    print("结论: " + ("❌ 不要提交" if bad else "✅ 可以提交"))
    print("=" * 72)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
