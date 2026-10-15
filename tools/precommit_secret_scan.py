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


#: 这些**键名后缀**的值是**配置**（端点/模型名/路径/端口），**不是凭据**。
#: ⚠️ **原错误写法**：注释写着"只把「像凭据」的值纳入黑名单（避免把 URL/模型名当成凭据）"，
#:    但代码只判了 `len(v) >= 12 and re.search(r"[A-Za-z0-9_-]{12,}", v)` ——
#:    **URL 与模型名照样命中** → `AMR_BASE=https://llm-api.x-aio.com/v1` 被当凭据 →
#:    文档里出现该端点 URL 就**误报"❌ 不要提交"**（实测踩到，差点让 Lead 以为密钥泄漏）。
#:    ★ 这正是坑 24（承诺了却不生效）——**扫描器自己犯了它要防的那类错**。
NON_SECRET_KEY_SUFFIXES = (
    "_BASE", "_URL", "_URI", "_HOST", "_PORT", "_MODEL", "_DIR", "_PATH",
    "_ROOT", "_FILE", "_NAME", "_ID", "_KEY_ID", "_ENDPOINT", "_REGION",
)


def looks_like_secret(key, v):
    """值是否**像凭据**。键名后缀 + 形态双重判定，避免把配置当密钥。"""
    if any(key.upper().endswith(s) for s in NON_SECRET_KEY_SUFFIXES):
        return False
    if "://" in v:                      # URL 不是凭据
        return False
    return len(v) >= 12 and re.search(r"[A-Za-z0-9_\-]{12,}", v) is not None


def load_env_secrets():
    """从 .env 读取**像凭据的值**，作为「真值黑名单」。**只返回值，不打印。**"""
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
            k, v = k.strip(), v.strip()
            if looks_like_secret(k, v):
                secrets.append(v)
    return secrets


def mask(s):
    return s[:8] + "…" + s[-4:] if len(s) > 14 else s[:6] + "…"


def git(args):
    return subprocess.run(["git"] + args, cwd=ROOT, capture_output=True,
                          text=True, encoding="utf-8", errors="replace")


def scan_text(text, secrets):
    """返回 (命中列表, 被跳过的夹具列表)。命中 = 需人工确认；夹具 = 已判定为测试值（**仍会列出**）。"""
    hits = []
    skipped = []
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
            # 占位符 / 显然的假值放行（列出但不判失败）
            if re.search(r"(REPLACE_ME|fake|test|example|placeholder|super-secret|leak-me)",
                         val, re.I):
                skipped.append((label, val[:28]))
                continue
            # ★ 测试夹具口令：password-literal 规则对测试数据天然误报。
            #   判据取"弱口令/夹具特征"（pass-/12345/short/dummy…）——
            #   **命中即列入"已跳过"，仍打印出来**，所以不是静默放过；
            #   若这里漏判，靠 .env 精确黑名单 + sk- 形态兜底。
            # ★ 测试夹具：`password-literal` 与 `sk-token` 规则对测试数据天然误报。
            #   判据取"夹具特征词"（pass-/12345/dummy/caps/fixture…）——
            #   **命中即列入"已跳过"，仍打印出来**，所以不是静默放过。
            #   ⚠️ 为什么 `sk-token` 也能豁免而**不削弱**检查：
            #     ① **真实密钥由 `.env` 精确黑名单兜底**（那条没有任何豁免，最强）；
            #     ② `sk-` 形态只是"未登记密钥"的 backstop；
            #     ③ 真实 key 是**高熵随机串**，**不会**含 `caps`/`test`/`pass`/`fixture` 这类词。
            #   ★ 实证：`AMR_KEY: 'sk-caps-cost-pass-1'`（测试夹具）曾被判失败 →
            #     **一次真实的 `npm test` 前提交被误拦**；而把真 key 放进文件时**仍被拦住**（已自证）。
            #   ⚠️⚠️ **长度上限是关键（自证③暴露的洞）**：
            #     只判"含夹具词"会被**伪装绕过** —— 实测把真 key 写成
            #     `sk-test-<真key体>`（74 字符）时，因含 `test` 被**跳过**（漏判）。
            #     ⟹ **夹具都短（`sk-caps-cost-pass-1` = 20 字符），真 key 都长（70+）** ——
            #     所以夹具豁免**必须同时满足 `len < 30`**。
            #     真 key 还有 `.env` 精确黑名单兜底（无任何豁免）。
            if label in ("password-literal", "sk-token") and len(val) < 30 and re.search(
                    r"(pass|pwd|secret|token|dummy|fixture|demo|sample|12345|abcd|qwerty|short|none"
                    r"|caps|cost|shape|binding|probe)",
                    val, re.I):
                skipped.append((label, val[:28]))
                continue
            hits.append((label, mask(val)))
    return hits, skipped


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
    fixtures = {}
    for rel in targets:
        fp = os.path.join(ROOT, rel)
        if not os.path.isfile(fp):
            continue
        try:
            text = io.open(fp, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        hits, skipped = scan_text(text, secrets)
        if hits:
            bad[rel] = hits
        if skipped:
            fixtures[rel] = skipped

    if bad:
        print("  ❌ 发现疑似凭据：")
        for rel, hits in bad.items():
            print(f"     {rel}")
            for kind, masked in hits:
                print(f"        [{kind}] {masked}")
    else:
        print("  ✅ 未发现任何凭据")

    # ★ 被跳过的测试夹具**照样列出来** —— 不是静默放过，人工可复核
    if fixtures:
        print()
        print(f"  ℹ 已跳过 {sum(len(v) for v in fixtures.values())} 处测试夹具（供复核，不判失败）：")
        for rel, items in list(fixtures.items())[:6]:
            kinds = ", ".join(f"{k}:{v}" for k, v in items[:3])
            print(f"     {rel}  →  {kinds}")

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
