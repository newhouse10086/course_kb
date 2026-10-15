"""Step 6：Lab 页写 session_id 上下文 + 工具帧按 id 分组（Lead/backend-api 要求）"""
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
web = Path(r"D:\temp临时脚本\26-10-13 数据库数据仓库课程优化\course-kb\apps\web")

# ---------- 1) Lab：沙箱 session_id 进上下文 ----------
p = web / "src" / "views" / "Lab.vue"
t = p.read_text(encoding="utf-8")
def rep(old, new, label):
    global t
    if old in t: t = t.replace(old, new, 1); print("OK:", label)
    else: print("MISS:", label)

rep("""import { api } from '../api/client'""",
"""import { setAssistantContext } from '../composables/useAssistantContext'
import { api } from '../api/client'""", "Lab import")
rep("""async function openSession() {""",
"""/**
 * ★ 小助手上下文（Lead 裁定）：把**沙箱会话 id** 带上 —— 这样"问助教"能直接看这位学生的 SQL 与报错。
 * ⚠️ 只传 id（不传 SQL/报错文本）：客户端传的东西不可信，服务端按 userId 校验归属后自己取。
 */
function syncAssistantContext() {
  const sid = session.value?.sessionId
  setAssistantContext(sid ? { session_id: sid } : {}, sid ? `沙箱会话 ${sid.slice(0, 18)}…` : '')
}

async function openSession() {""", "Lab sync 函数")
rep("""    note.value = `沙箱已就绪：${s.sessionId}（数据集 ${s.dataset} · 引擎 ${s.engine}${s.created ? ' · 新建' : ' · 复用'}）`""",
"""    note.value = `沙箱已就绪：${s.sessionId}（数据集 ${s.dataset} · 引擎 ${s.engine}${s.created ? ' · 新建' : ' · 复用'}）`
    syncAssistantContext()""", "会话就绪后同步")
p.write_text(t, encoding="utf-8")

# ---------- 2) Chat：工具帧按 id 分组（同 id 的 tool_start 不重复 push） ----------
p2 = web / "src" / "views" / "Chat.vue"
c = p2.read_text(encoding="utf-8")
old = """    case 'tool_start':
      updateLast((m) => m.tools.push({ id: String((e as any).id), tool: String((e as any).tool), args: (e as any).args, done: false }))
      // ★ 同轮归组：wiki 那次"去查 sqlite"就是这条，不显示用户就不知道它做了额外工作
      roundTools.value = [...roundTools.value, { id: String((e as any).id), tool: String((e as any).tool), args: (e as any).args, done: false }]
      break"""
new = """    case 'tool_start': {
      /**
       * ★ **按 call id 分组**（backend-api/Lead 2026-10-15）：
       *   同一次工具调用可能被重复发 `tool_start`（帧层重复）→ **同 id 不重复显示**；
       *   id 不同 = 模型真的调了两次 → **如实显示两次**（去重会变成谎报）。
       *   这样不依赖"重复发 vs 真调两次"的结论，天然正确。
       */
      const tid = String((e as any).id)
      updateLast((m) => {
        const exist = m.tools.find((x) => x.id === tid)
        if (exist) { exist.args = (e as any).args ?? exist.args; return }
        m.tools.push({ id: tid, tool: String((e as any).tool), args: (e as any).args, done: false })
      })
      roundTools.value = roundTools.value.some((x) => x.id === tid)
        ? roundTools.value
        : [...roundTools.value, { id: tid, tool: String((e as any).tool), args: (e as any).args, done: false }]
      break
    }"""
if old in c:
    c = c.replace(old, new, 1); print("OK: 工具帧按 id 分组")
else:
    print("MISS: tool_start")
p2.write_text(c, encoding="utf-8")
print("done")
