"""真后端实测驱动的最后一批修复

1. 真沙箱会话是**按 (user,dataset) 持久**的（同 sessionId）→ 自检必须幂等：
   建表前 `DROP TABLE IF EXISTS stu_note`（否则第二次跑就是 "table already exists" → E_SQL_EXEC）
2. 整批 statements 的 DOM 断言要在**整批执行后立刻**做（后面的 SELECT 会把 result 换掉）
3. 引用断言改成条件式：真模型这次 **403 上游失败**（后端如实报 E_LLM）→ 断言"要么有引用，要么如实报错"
4. 设置页自检 idle-aware：真环境**空闲**时不该断言"运行中"文案；
   改为验证 idle 路径 + **502 探测失败回滚**（用不存在的模型名，安全、不改状态）
"""
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
web = Path(r"D:\temp临时脚本\26-10-13 数据库数据仓库课程优化\course-kb\apps\web")

# ---------- Lab.vue ----------
lv = web / "src" / "views" / "Lab.vue"
t = lv.read_text(encoding="utf-8")

def rep(old, new, label, path=None):
    global t
    if old in t:
        t = t.replace(old, new, 1); print("OK:", label)
    else:
        print("MISS:", label)

# 1) 幂等：先 DROP
rep("""  const ddl = await exec('CREATE TABLE stu_note (id INTEGER PRIMARY KEY, txt TEXT)')""",
    """  // ⚠️ 真沙箱会话按 (user,dataset) **持久**（sessionId 固定）→ 自检必须幂等，否则第二次跑
  //    就是 "table stu_note already exists"（实测 E_SQL_EXEC）
  await exec('DROP TABLE IF EXISTS stu_note')
  const ddl = await exec('CREATE TABLE stu_note (id INTEGER PRIMARY KEY, txt TEXT)')""", "ddl idempotent")

# 2) 整批 statements DOM 断言提前
rep("""  const rb = await exec("BEGIN; INSERT INTO tx_probe (id, v) VALUES (1, 'x'); ROLLBACK")
  const afterRb = await cnt()""",
    """  const rb = await exec("BEGIN; INSERT INTO tx_probe (id, v) VALUES (1, 'x'); ROLLBACK")
  // statements 的 DOM 断言必须**立刻**做：后面任何一次查询都会把 result 换掉（实测踩到）
  const rbStatementsShown = !!document.querySelector('[data-testid="statements"]')
  const afterRb = await cnt()""", "statements ordering")
rep("""  need('multi_statements_rendered', !!document.querySelector('[data-testid="statements"]'))""",
    """  need('multi_statements_rendered', rbStatementsShown)""", "statements assertion")

# 3) 引用/答疑条件断言
rep("""  need('ask_cites_kb_or_reports_failure',
    askError.value ? true : citations.value.length > 0 && citations.value.every((c) => c.href.includes('#/wiki')))""",
    """  need('ask_cites_kb_or_reports_failure',
    askError.value ? true : citations.value.length > 0 && citations.value.every((c) => c.href.includes('#/wiki')))
  // 真环境实测：上游 403 → 后端如实给 E_LLM，页面必须显示出来（不许静默）
  if (askError.value) {
    need('ask_error_visible', !!document.querySelector('[data-testid="ask-error"]'))
    rec('ask_error_text', askError.value.slice(0, 120))
  }""", "ask conditional")

# 4) tx_probe 也幂等
rep("""  await exec('CREATE TABLE tx_probe (id INTEGER PRIMARY KEY, v TEXT)')""",
    """  await exec('DROP TABLE IF EXISTS tx_probe')
  await exec('CREATE TABLE tx_probe (id INTEGER PRIMARY KEY, v TEXT)')""", "tx idempotent")

lv.write_text(t, encoding="utf-8")

# ---------- Settings.vue：idle-aware 自检 ----------
sv = web / "src" / "views" / "Settings.vue"
s = sv.read_text(encoding="utf-8")

old = """  rec('running_visible', !!running.value && running.value.done > 0)"""
if old in s:
    print("OK: settings selftest anchor")
else:
    print("MISS: settings selftest anchor")

# 找到 selftest 里 running 相关断言块
start = s.index("async function runSelftest()")
block = s[start:]
old_running = """  rec('running_visible', !!running.value && running.value.done > 0)"""
if old_running in s:
    s = s.replace(old_running, """  // 真环境可能是**空闲**的（实测 busy=false）→ 分两条路各自断言，不能假设"一定有任务在跑"
  const idle = !running.value
  rec('running_task', running.value ? `${running.value.kind} ${running.value.done}/${running.value.total}` : 'idle')
  rec('running_visible', idle ? true : running.value!.done > 0 || !!running.value!.stage)
  need('running_visible', idle || running.value!.done > 0 || !!running.value!.stage)""", 1)
    print("OK: running idle-aware")
else:
    print("MISS: running assertion")

old2 = """  rec('switch_button_label', switchLabel.value)
  need('switch_label_abort', switchLabel.value === '终止并切换')"""
if old2 in s:
    s = s.replace(old2, """  rec('switch_button_label', switchLabel.value)
  // 空闲时按钮是"切换模型"；有任务时必须是"终止并切换"（两种都对，取决于真实队列状态）
  need('switch_label_abort', idle ? switchLabel.value === '切换模型' : switchLabel.value === '终止并切换')""", 1)
    print("OK: label idle-aware")
else:
    print("MISS: label assertion")

old3 = """    rec('confirm_default_mode', confirmMode.value)
    need('confirm_mode_abort_when_running', confirmMode.value === 'abort')"""
if old3 in s:
    s = s.replace(old3, """    rec('confirm_default_mode', confirmMode.value)
    need('confirm_mode_abort_when_running', idle ? confirmMode.value === 'now' : confirmMode.value === 'abort')""", 1)
    print("OK: mode idle-aware")
else:
    print("MISS: mode assertion")

# 409/断点 断言 → 只在有任务时要求；空闲时改为验证 502 探测失败回滚（安全）
old4 = """    // ② 先试 mode=now（运行中）→ 409 E_MODEL_BUSY
    confirmMode.value = 'now'"""
if old4 in s:
    s = s.replace(old4, """    // ② 空闲时：走**502 探测失败 + 回滚**路径（用不存在的模型名，安全，不改任何状态）
    if (idle) {
      const before = activeModel.value
      picked.value = 'no-such-model-xyz'
      confirmMode.value = 'now'
      await doSwitch()
      rec('probe_failed_rollback', { note: note.value.slice(0, 90), kind: noteKind.value, active: activeModel.value })
      need('probe_failed_rollback', note.value.includes('回滚') && activeModel.value === before)
      picked.value = before
      const st2 = report_checks_snapshot()
      rec('idle_path_verified', true)
      return st2
    }
    // ② 先试 mode=now（运行中）→ 409 E_MODEL_BUSY
    confirmMode.value = 'now'""", 1)
    print("OK: idle 502 path")
else:
    print("MISS: 409 block")

sv.write_text(s, encoding="utf-8")
print("done")
