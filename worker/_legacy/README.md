# `worker/_legacy/` —— v1 资产（**已废弃，保留供审计**）

这里是从 v1（Python + FastAPI + SQLite + pi RPC 桥）迁过来的代码与测试，**不属于 v2 运行路径**。
v2 已改为 **TS/Node 后端主体 + Python 媒体 worker（CLI + JSONL）**（见 `docs/ARCHITECTURE_V2.md`），
所以：

* `store/`、`fastapi_main.py` —— v1 的 SQLite 层与 REST 层，**已由 TS 重写**（`apps/server/src/store`、`src/routes`）。
* `tests/{test_store,test_api_documents}.py` —— 测上面两个模块，**已失效**。
* `tests/{test_pi_bridge,test_pi_launcher}.py` —— 测 v1 的 `server/pi_bridge`（RPC 子进程），该模块
  **已删除**，v2 改用 pi 官方 SDK 进程内集成。
* `tests/test_web_*.py` —— 测 v1 的原生 HTML/JS 页面（`web/`，靠 headless Chrome 断言 DOM），
  **已由 Vue3 取代**（`apps/web/`，T-FRONTEND）。

**保留而不删除**：审计「哪些 v1 资产被废弃、为什么」。
**活跃测试**看 `worker/tests/`（Python worker）与 `apps/server/test/`（TS 后端）。

> `tests/conftest.py` 里的 `collect_ignore_glob = ["*.py"]` 保证任何 `pytest` 调用都不会收集这里
> （这些文件仍 import 已不存在的 `server.*`，一旦收集就会在**收集期**报错）。
