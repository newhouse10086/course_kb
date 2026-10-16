"""WS 实测：连到一个已有会话，看服务端发不发 `history` 帧（零 LLM —— 只连接，不发消息）。

用户报的 bug: 新建并对话 → 点别的会话 → 再回来 → 消息加载不出来。
本探针只证明"服务端到底发不发 history 帧"，不触发任何模型调用。
"""
import asyncio
import json
import ssl  # noqa: F401
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

import websockets

BASE = "http://127.0.0.1:8787"
WS = "ws://127.0.0.1:8787"
cj = CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def login():
    d = json.dumps({"username": "teacher", "password": "Teacher2026lab"}).encode()
    r = urllib.request.Request(BASE + "/api/v1/auth/login", data=d, method="POST")
    r.add_header("Content-Type", "application/json")
    with op.open(r, timeout=20) as x:
        return x.status


def cookie_header():
    return "; ".join(f"{c.name}={c.value}" for c in cj)


def list_conversations():
    r = urllib.request.Request(BASE + "/api/v1/conversations")
    r.add_header("Cookie", cookie_header())
    with op.open(r, timeout=20) as x:
        d = json.loads(x.read().decode())
    return d.get("conversations") or d.get("items") or []


async def probe(session_id, label, seconds=8.0):
    url = f"{WS}/api/v1/chat/{session_id}?mode=chat"
    frames = []
    try:
        async with websockets.connect(url, additional_headers={"Cookie": cookie_header()}, open_timeout=10) as ws:
            try:
                while True:
                    raw = await asyncio.wait_for(ws.recv(), timeout=seconds)
                    try:
                        f = json.loads(raw)
                    except Exception:
                        f = {"type": "?", "raw": raw[:80]}
                    frames.append(f)
                    t = f.get("type")
                    if t in ("ready", "history"):
                        extra = ""
                        if t == "history":
                            extra = f"  ★ messages={len(f.get('messages') or [])}"
                        frames[-1]["_note"] = extra
                    if len(frames) > 40:
                        break
            except asyncio.TimeoutError:
                pass
    except Exception as e:  # noqa: BLE001
        return label, session_id, f"连接失败: {type(e).__name__}: {e}", []
    return label, session_id, "ok", frames


async def main():
    st = login()
    print(f"登录 = {st}")
    convs = list_conversations()
    print(f"会话数 = {len(convs)}")
    print()
    # 取前 3 个已有会话探测
    picks = convs[:3]
    for c in picks:
        cid = c.get("id")
        label, sid, status, frames = await probe(cid, "已有会话", 6.0)
        types = [f.get("type") for f in frames]
        has_history = "history" in types
        print(f"  {sid}  title={c.get('title')!r}")
        print(f"    状态: {status}")
        print(f"    帧序列: {types}")
        print(f"    ★ 收到 history 帧 = {'是' if has_history else '**否**'}")
        for f in frames:
            if f.get("type") == "history":
                print(f"      messages = {len(f.get('messages') or [])}  truncated={f.get('truncated')}")
        print()
    # 新建一个会话再探（对照）
    d = json.dumps({"title": "探针-临时"}).encode()
    r = urllib.request.Request(BASE + "/api/v1/conversations", data=d, method="POST")
    r.add_header("Content-Type", "application/json")
    r.add_header("Cookie", cookie_header())
    with op.open(r, timeout=20) as x:
        newc = json.loads(x.read().decode())
    nid = (newc.get("conversation") or {}).get("id")
    print(f"  新建会话 {nid}（对照）")
    label, sid, status, frames = await probe(nid, "新会话", 6.0)
    print(f"    帧序列: {[f.get('type') for f in frames]}")
    print(f"    ★ 收到 history 帧 = {'是' if 'history' in [f.get('type') for f in frames] else '**否**'}")


asyncio.run(main())
