<script setup lang="ts">
/**
 * SQL 练习台（学生端）—— docs/LAB_DB_DEPLOY.md §6/§7 + docs/SETTINGS_AND_SANDBOX.md §3
 *
 * 硬要求（文档逐条）：
 *   · **引擎选择器**读 `/capabilities.sandbox.engines`，按 `available` 渲染；
 *     不可用 → 禁用 + 显示 reason + **指向部署文档章节**（不能只说"不可用"）
 *   · **完整 CRUD**：建表/插数/查询/更新/删除/事务（不是只读）
 *   · **当前方言显著标注**（SQLite ≠ MySQL），并列出常见差异
 *   · 结果表格：`maxRows` 截断要**明示"仅显示前 N 行"**
 *   · `reset` 回到初始 schema + 数据集选择
 *   · 答疑面板：选中报错 SQL → 问 AI → **流式**回答 + **引用卡片可跳原文**
 *   · 日志/上下文读不到时显示**如实声明**，不让用户以为看过了
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api/client'
import { postSse } from '../api/sse'
import { useCaps } from '../composables/useCaps'
import { queryFlag, testBarrier, testBarrierDone, writeReport } from '../utils/report'
import type { SandboxDataset, SandboxResult, SandboxSession, SandboxTable } from '../api/types'

const router = useRouter()
const { caps, reload: reloadCaps } = useCaps()

const engines = computed(() => caps.value?.raw ? ((caps.value.raw as any).sandbox?.engines || []) : [])
const engine = ref('')
const engineInfo = computed(() => engines.value.find((e: any) => e.id === engine.value) || null)
const engineAvailable = computed(() => !!engineInfo.value?.available)
/** 后端有没有上报 sandbox 段？（实测真后端 v1.0.0 的 /capabilities **没有** sandbox 键） */
const sandboxReported = computed(() => !!(caps.value?.raw as any)?.sandbox)
const missing = ref<Array<{ path: string; code: string; msg: string }>>([])
const limits = computed(() => ((caps.value?.raw as any)?.sandbox?.limits || { maxRows: 200, timeoutMs: 3000, maxDbBytes: 20971520 }))
/** 真后端 `/capabilities.sandbox.defaultEngine`（实测 'sqlite'） */
const defaultEngine = computed(() => String((caps.value?.raw as any)?.sandbox?.defaultEngine || ''))

const datasets = ref<SandboxDataset[]>([])
/** 真后端默认数据集是 `sc`（我 mock 用的 'student-course' 是我自己编的 id） */
const dataset = ref('sc')
const session = ref<SandboxSession | null>(null)
const tables = ref<SandboxTable[]>([])
const sql = ref('SELECT * FROM student')
const history = ref<Array<{ sql: string; ok: boolean; at: number }>>([])
const result = ref<SandboxResult | null>(null)
/** 错误归因三档（由后端 `error.who` 驱动；缺省 unknown 就如实显示原始错误） */
type WhoKind = 'student' | 'rules' | 'system' | 'unknown'
const runError = ref<{
  code: string; msg: string; hint?: string; localReading?: string
  who?: string; whoLabel?: string; kind?: WhoKind
  killedBy?: string; hardKilled?: boolean
} | null>(null)

/** 三档话术（Lead 要求：三种绝不能长得一样） */
const WHO_TEXT: Record<WhoKind, { title: string; tone: string; note: string }> = {
  student: { title: '你的 SQL 有问题（可以自己改）', tone: 'student', note: '这是**学生的错**：按下面的提示改写法再跑一次。' },
  rules: { title: '被沙箱安全策略拒绝（不是 SQL 写错）', tone: 'rules', note: '这是**规则限制**：课程沙箱不允许这类语句，改写法没有用，需要换思路（见对照表）。' },
  system: { title: '执行被中断 / 系统侧问题', tone: 'system', note: '这是**系统或超时**：语句可能没写完就被停掉了 —— 看下面的 killedBy 归因，别当成语法错。' },
  unknown: { title: '执行失败（后端未给出归因）', tone: 'unknown', note: '后端没有给 `who`：下面只显示原始错误，**不猜**是谁的问题。' },
}
const whoText = computed(() => WHO_TEXT[(runError.value?.kind || 'unknown') as WhoKind])
const busy = ref(false)
const note = ref('')
const noteKind = ref<'info' | 'ok' | 'bad' | 'warn'>('info')
const dialectNoteOpen = ref(true)

/** 方言：真后端在 `session.schema.dialect`（'sqlite'），capabilities 里在 `engines[].dialect` */
const sessionDialect = computed(() => {
  const s = session.value?.schema
  if (s && typeof s === 'object' && (s as any).dialect) return String((s as any).dialect)
  return ''
})

/** 前端内置的 SQLite ↔ MySQL 对照（数据集自带 dialectNotes 时优先用后端的） */
const FALLBACK_DIALECT_NOTES = [
  { sqlite: 'AUTOINCREMENT', mysql: 'AUTO_INCREMENT', note: '自增列的写法不同' },
  { sqlite: 'TEXT / INTEGER', mysql: 'VARCHAR / INT', note: '类型名不同（SQLite 是动态类型）' },
  { sqlite: 'PRAGMA table_info(t)', mysql: 'DESCRIBE t', note: '看表结构的命令不同' },
  { sqlite: '无存储过程 / 无权限体系', mysql: 'PROCEDURE / GRANT', note: '这两类实验在 SQLite 上做不了（见 §6 对照表）' },
  { sqlite: '窗口函数 ≥3.25', mysql: '8.0 起支持', note: '版本门槛不同' },
]

// 答疑
const askOpen = ref(false)
const askText = ref('')
const askBusy = ref(false)
const citations = ref<Array<{ card_id: string; name: string; unit_id: string; href: string }>>([])
const askContext = ref<Record<string, unknown> | null>(null)
const askStages = ref<string[]>([])
const askError = ref('')

const CRUD_SNIPPETS: Array<{ label: string; sql: string; kind: 'ddl' | 'dml' | 'dql' | 'tx' }> = [
  { label: '建表', kind: 'ddl', sql: 'CREATE TABLE my_note (id INTEGER PRIMARY KEY, title TEXT NOT NULL, created_at TEXT)' },
  { label: '插数', kind: 'dml', sql: "INSERT INTO my_note (id, title, created_at) VALUES (1, '第一条笔记', '2026-10-15 10:00:00')" },
  { label: '查询', kind: 'dql', sql: 'SELECT * FROM my_note' },
  { label: '更新', kind: 'dml', sql: "UPDATE my_note SET title = '改过的标题' WHERE id = 1" },
  { label: '删除', kind: 'dml', sql: 'DELETE FROM my_note WHERE id = 1' },
  { label: '事务', kind: 'tx', sql: 'BEGIN' },
]

/**
 * 真后端 schema → 页面用的表清单
 * 真形状：`{dialect, tables:[{name, columns:[{name,type,pk,notnull,fk,default}], rows}]}`
 * 我 mock 的形状：`{tables:[{name, columns:['a','b'], rowCount:5}]}` → 两种都吃
 */
function schemaToTables(schema: unknown): SandboxTable[] {
  const s = schema as { tables?: Array<Record<string, any>> } | undefined
  if (!s?.tables) return []
  return s.tables.map((t) => ({
    name: String(t.name),
    columns: (t.columns || []).map((c: any) => (typeof c === 'string' ? c : String(c?.name ?? ''))),
    rowCount: Number(t.rows ?? t.rowCount ?? 0),
  }))
}

/** 当前数据集的方言差异说明（真后端 datasets[].dialectNotes 优先，其次前端内置对照表） */
const dialectNotes = computed(() => {
  const d = datasets.value.find((x) => x.id === dataset.value)
  const fromApi = (d?.dialectNotes || []).filter((n) => n && (n.sqlite || n.mysql || n.note))
  return fromApi.length ? fromApi : FALLBACK_DIALECT_NOTES
})

async function loadDatasets() {
  try {
    const r = await api.sandboxDatasets()
    datasets.value = r.datasets || []
    // 优先用服务端的 default（实测 'sc'），其次第一个
    const preferred = r.default || datasets.value[0]?.id
    if (!datasets.value.some((d) => d.id === dataset.value) && preferred) dataset.value = preferred
  } catch (e) {
    // ⚠️ 真后端还没实现 /sandbox/* → 这里**必须**捕获：
    //    第一版直接 await（不 catch）→ 异常冒泡出 onMounted → 连报告都写不出来（实测踩到）
    const err = e as { code?: string; status?: number; message: string }
    if ((err.code === 'E_NOTFOUND' || err.status === 404) && !missing.value.some((m) => m.path === 'GET /api/v1/sandbox/datasets')) {
      missing.value = [...missing.value, { path: 'GET /api/v1/sandbox/datasets', code: err.code || 'E_NOTFOUND', msg: err.message }]
    }
    datasets.value = []
    note.value = `数据集列表拿不到：${err.message}`
    noteKind.value = 'bad'
  }
}

async function openSession() {
  busy.value = true
  try {
    const s = await api.sandboxSession(dataset.value)
    session.value = s
    // ⚠️ 真后端**没有** `s.tables`：表清单在 `s.schema.tables`（且列是对象数组 `{name,type,pk,...}`，行数是 `rows`）
    tables.value = schemaToTables(s.schema)
    result.value = null
    runError.value = null
    history.value = []
    note.value = `沙箱已就绪：${s.sessionId}（数据集 ${s.dataset} · 引擎 ${s.engine}${s.created ? ' · 新建' : ' · 复用'}）`
    // 服务端有权威的审计历史（教学追溯）→ 拉回来展示，别只显示本地那几条
    try {
      const h = await api.sandboxHistory(s.sessionId)
      history.value = (h.entries || []).slice(-30).reverse().map((e) => ({ sql: e.sql, ok: e.ok, at: e.at }))
    } catch { /* 老后端没有 history 接口 → 本地记录也够用 */ }
    noteKind.value = 'ok'
  } catch (e) {
    session.value = null
    const err = e as { code?: string; status?: number; message: string }
    if (err.code === 'E_NOTFOUND' || err.status === 404) {
      if (!missing.value.some((m) => m.path === 'POST /api/v1/sandbox/session')) {
        missing.value = [...missing.value, { path: 'POST /api/v1/sandbox/session', code: err.code || 'E_NOTFOUND', msg: err.message }]
      }
    }
    note.value = `沙箱不可用：${err.message}`
    noteKind.value = 'bad'
  } finally {
    busy.value = false
  }
}

async function run() {
  if (!engineAvailable.value) {
    note.value = `入口已禁用：${engineInfo.value?.reason || '引擎不可用'}`
    noteKind.value = 'warn'
    return
  }
  if (!session.value) {
    await openSession()
    if (!session.value) return
  }
  const text = sql.value.trim()
  if (!text) return
  busy.value = true
  runError.value = null
  try {
    const r = await api.sandboxExecute(session.value.sessionId, text, {
      maxRows: Number(limits.value.maxRows) || 200, timeoutMs: Number(limits.value.timeoutMs) || 3000,
    })
    result.value = { ...r, maxRows: Number(limits.value.maxRows) || 200 }
    if (r.schema) tables.value = schemaToTables(r.schema)
    if (r.error) {
      /**
       * ★ `who` 必须驱动话术（Lead 硬要求）："学生的错 / 规则限制 / 系统或超时"三种**绝不能长得一样**。
       * 真后端实测分类（2026-10-15）：
       *   student       → E_SQL_SYNTAX / E_SQL_NO_OBJECT（写错了，可以自己改）
       *   rules         → E_SQL_FORBIDDEN / E_SQL_PRAGMA / E_SQL_MULTI（安全闸拒绝，**不是写错**）
       *   student_logic → E_SQL_TIMEOUT（逻辑问题导致跑不完，但**是执行被中断**，配 killedBy/hardKilled）
       *   其它/缺失      → 如实显示原始错误，不猜归因
       */
      const who = String(r.error.who || '')
      const kind: WhoKind = who === 'student' ? 'student' : who === 'rules' ? 'rules' : who ? 'system' : 'unknown'
      runError.value = {
        code: r.error.code, msg: r.error.message || r.error.raw || '',
        hint: r.error.hint || '', localReading: r.error.localReading || '',
        who, whoLabel: r.error.who_label || '', kind,
        killedBy: r.killedBy, hardKilled: r.hardKilled,
        interim: (r.error as any).interim === true,
      }
      history.value = [{ sql: text, ok: false, at: Date.now() }, ...history.value].slice(0, 30)
      note.value = `${r.error.code}：${r.error.message || r.error.raw || ''}`
      noteKind.value = kind === 'rules' ? 'warn' : 'bad'
      if (r.killedBy) note.value += `（${r.killedBy}${r.hardKilled ? ' / 硬杀' : ''}）`
    } else {
      history.value = [{ sql: text, ok: true, at: Date.now() }, ...history.value].slice(0, 30)
      note.value = r.rowCount
        ? `返回 ${r.rowCount} 行（${r.elapsedMs ?? '—'}ms${r.statementKind ? ' · ' + r.statementKind : ''}）`
        : `执行成功（${r.elapsedMs ?? '—'}ms${r.statementKind ? ' · ' + r.statementKind : ''}${r.affected != null ? ' · 影响 ' + r.affected + ' 行' : ''}）`
      noteKind.value = 'ok'
    }
  } catch (e) {
    runError.value = { code: 'E_NETWORK', msg: (e as Error).message }
    note.value = `执行失败：${(e as Error).message}`
    noteKind.value = 'bad'
  } finally {
    busy.value = false
  }
}

async function reset() {
  if (!confirm('重置沙箱到初始 schema？你自己建的表和数据都会消失。')) return
  busy.value = true
  try {
    const r = await api.sandboxReset(dataset.value, session.value?.sessionId)
    tables.value = schemaToTables(r.schema)
    result.value = null
    runError.value = null
    note.value = `已重置到数据集 ${dataset.value} 的初始状态（引擎 ${r.engine || engine.value}；服务端 resetPolicy=${(caps.value?.raw as any)?.sandbox?.resetPolicy || 'per_session'}）`
    noteKind.value = 'ok'
  } catch (e) {
    note.value = `重置失败：${(e as Error).message}`
    noteKind.value = 'bad'
  } finally {
    busy.value = false
  }
}

function useSnippet(s: { sql: string }) { sql.value = s.sql }

/** ★ 答疑：把 SQL + 报错 + 问题交给 AI（流式），引用卡片可跳原文 */
async function ask() {
  if (!askOpen.value) askOpen.value = true
  askBusy.value = true
  askText.value = ''
  citations.value = []
  askStages.value = []
  askContext.value = null
  askError.value = ''
  const body = {
    sessionId: session.value?.sessionId,
    sql: sql.value.trim(),
    error: runError.value?.msg || '',
    question: '这句为什么报错 / 结果对不对？',
  }
  await postSse(api.sandboxAskUrl(), body, {
    onEvent: (event, data) => {
      if (event === 'progress') {
        askStages.value = [...askStages.value, String(data?.stage || '处理中')]
        askContext.value = data?.detail || null
      } else if (event === 'text') {
        askText.value += String(data?.delta || '')
      } else if (event === 'citation') {
        citations.value = data?.citations || []
      } else if (event === 'done') {
        askStages.value = [...askStages.value, `完成（引用 ${data?.cited ?? 0} 张卡片，风格 ${data?.hint_style || ''}）`]
      }
    },
    onError: (msg) => { askError.value = msg },
    onClose: () => { askBusy.value = false },
  })
  askBusy.value = false
}

function gotoCitation(href: string) { void router.push(href.replace(/^#/, '')) }

onMounted(async () => {
  testBarrier()
  if (!caps.value) await reloadCaps()
  const first = engines.value.find((e: any) => e.available) || engines.value[0]
  engine.value = first?.id || 'sqlite'
  await loadDatasets()
  if (queryFlag('load')) await openSession()
  await nextTick()
  writeReport('lab-report', {
    ok: true,
    engine: engine.value,
    engine_available: engineAvailable.value,
    engines: engines.value.map((e: any) => ({ id: e.id, available: e.available, reason: e.reason || '' })),
    datasets: datasets.value.map((d) => d.id),
    dialect: sessionDialect.value || engineInfo.value?.dialect || '',
    default_dataset: dataset.value,
    schema_tables: tables.value.map((x) => `${x.name}(${x.rowCount ?? '?'})`),
    sandbox_reported: sandboxReported.value,
    missing: missing.value,
    backend_implemented: sandboxReported.value && missing.value.length === 0,
    limits: limits.value,
  })
  if (queryFlag('selftest') && engineAvailable.value) await runSelftest()
  await testBarrierDone()
})

/** 自检：引擎门控 + 完整 CRUD + maxRows 明示 + reset + 答疑引用 */
async function runSelftest() {
  const checks: Record<string, unknown> = {}
  const failed: string[] = []
  const rec = (k: string, v: unknown) => { checks[k] = v }
  const need = (k: string, cond: boolean) => { if (!cond) failed.push(k) }

  rec('engines_rendered', document.querySelectorAll('[data-testid="engine-select"] option').length)
  need('engines_rendered', document.querySelectorAll('[data-testid="engine-select"] option').length === engines.value.length)
  // 不可用引擎必须带 reason + 文档指向
  const disabledOpts = Array.from(document.querySelectorAll('[data-testid="engine-select"] option')).filter((o) => (o as HTMLOptionElement).disabled)
  rec('engines_disabled', disabledOpts.map((o) => o.textContent?.slice(0, 40)))
  need('disabled_has_reason', disabledOpts.length === 0 || disabledOpts.every((o) => /未安装 Docker|未就绪/.test(o.textContent || '')))
  rec('dialect_shown', document.querySelector('[data-testid="dialect"]')?.textContent?.trim().slice(0, 60))
  need('dialect_shown', !!document.querySelector('[data-testid="dialect"]'))

  await openSession()
  need('session_ok', !!session.value)
  rec('tables', tables.value.map((t) => `${t.name}(${t.rowCount})`))

  // ① 完整 CRUD（真实点击"运行"按钮）
  const runBtn = document.querySelector('[data-testid="btn-run"]') as HTMLButtonElement | null
  need('run_button', !!runBtn)
  const firstTable = () => (tables.value[0]?.name || 'students')
  const exec = async (text: string) => {
    sql.value = text
    await nextTick()
    runBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    for (let i = 0; i < 40 && busy.value; i++) await new Promise((r) => setTimeout(r, 50))
    return { result: result.value, error: runError.value }
  }
  const ddl = await exec('CREATE TABLE stu_note (id INTEGER PRIMARY KEY, txt TEXT)')
  rec('crud_ddl', { cols: ddl.result?.columns, error: ddl.error?.code || null })
  need('crud_ddl', !ddl.error && tables.value.some((t) => t.name === 'stu_note'))

  const ins = await exec("INSERT INTO stu_note (id, txt) VALUES (1, '我的笔记')")
  rec('crud_insert', { error: ins.error?.code || null })
  need('crud_insert', !ins.error)
  const sel = await exec('SELECT * FROM stu_note')
  rec('crud_select', { columns: sel.result?.columns, rows: sel.result?.rows })
  need('crud_select', !sel.error && sel.result?.rowCount === 1)
  const upd = await exec("UPDATE stu_note SET txt = '改过了' WHERE id = 1")
  rec('crud_update', { error: upd.error?.code || null })
  need('crud_update', !upd.error)
  const sel2 = await exec('SELECT * FROM stu_note')
  rec('crud_update_visible', sel2.result?.rows?.[0]?.[1] === '改过了')
  need('crud_update_visible', sel2.result?.rows?.[0]?.[1] === '改过了')
  const del = await exec('DELETE FROM stu_note WHERE id = 1')
  rec('crud_delete', { error: del.error?.code || null })
  need('crud_delete', !del.error)
  const sel3 = await exec('SELECT * FROM stu_note')
  rec('crud_delete_visible', sel3.result?.rowCount === 0, )
  need('crud_delete_visible', sel3.result?.rowCount === 0)
  const tx = await exec('BEGIN')
  rec('tx_begin', { error: tx.error?.code || null })
  need('tx_begin', !tx.error)
  await exec('COMMIT')

  // ② JOIN + 聚合（课程 Real 场景）
  const join = await exec('SELECT st.sname, co.cname, en.grade FROM enrollments en JOIN students st ON en.sid = st.sid JOIN courses co ON en.cid = co.cid ORDER BY en.grade DESC LIMIT 3')
  rec('join', { cols: join.result?.columns, rows: join.result?.rows })
  need('join', !join.error && join.result?.rowCount === 3)
  const agg = await exec('SELECT dept, COUNT(*) AS n FROM students GROUP BY dept')
  rec('agg', { cols: agg.result?.columns, rows: agg.result?.rows })
  need('agg', !agg.error && agg.result?.rowCount === 3)

  // ★ 事务：单条被拒（E_SQL_UNSUPPORTED / who=rules / interim）→ 整批（multi）才有效
  const singleTx = await exec('ROLLBACK')
  rec('single_tx_rejected', { code: singleTx.error?.code, who: singleTx.error?.who, interim: (singleTx.error as any)?.interim })
  need('single_tx_rejected', singleTx.error?.code === 'E_SQL_UNSUPPORTED' && singleTx.error?.who === 'rules')
  const singleTxKind = document.querySelector('[data-testid="run-error"]') as HTMLElement | null
  rec('single_tx_who_kind', singleTxKind?.dataset.whoKind)
  need('single_tx_who_kind', singleTxKind?.dataset.whoKind === 'rules')
  need('single_tx_interim_noted', !!document.querySelector('[data-testid="interim-note"]'))

  // 整批执行：开关 → 请求带 multi:true → BEGIN/INSERT/ROLLBACK 全 ok 且行数不变
  await exec('CREATE TABLE tx_probe (id INTEGER PRIMARY KEY, v TEXT)')
  const cnt = async () => (await exec('SELECT * FROM tx_probe')).result?.rowCount ?? -1
  multiMode.value = true
  await nextTick()
  const rb = await exec("BEGIN; INSERT INTO tx_probe (id, v) VALUES (1, 'x'); ROLLBACK")
  const afterRb = await cnt()
  const cm = await exec("BEGIN; INSERT INTO tx_probe (id, v) VALUES (2, 'y'); COMMIT")
  const afterCm = await cnt()
  rec('multi_rollback', { ok: rb.result?.ok, statements: (rb.result as any)?.statements, rows: afterRb })
  rec('multi_commit', { ok: cm.result?.ok, statements: (cm.result as any)?.statements, rows: afterCm })
  need('multi_rollback_no_effect', afterRb === 0 && !!(rb.result as any)?.statements?.length)
  need('multi_commit_visible', afterCm === 1)
  need('multi_toggle_visible', !!document.querySelector('[data-testid="multi-toggle"]'))
  need('multi_statements_rendered', !!document.querySelector('[data-testid="statements"]'))
  need('multi_note_explains_why', /独立进程/.test(document.querySelector('[data-testid="multi-note"]')?.textContent || ''))
  multiMode.value = false
  await exec('DROP TABLE tx_probe')

  // ★ 错误三档必须**长得不一样**（Lead 硬要求：由后端 error.who 驱动）
  const whoKind = async (sql: string) => {
    await exec(sql)
    await nextTick()
    const el = document.querySelector('[data-testid="run-error"]') as HTMLElement | null
    return {
      kind: el?.dataset.whoKind || null, who: el?.dataset.who || null, code: el?.dataset.code || null,
      tone: (el?.querySelector('.who-badge') as HTMLElement | null)?.dataset.tone || null,
      text: (el?.textContent || '').replace(/\s+/g, ' ').slice(0, 120),
    }
  }
  const eSyntax = await whoKind('SELEC * FROM students')
  const eRules = await whoKind("ATTACH DATABASE 'other.db' AS other")
  const eTimeout = await whoKind('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c')
  rec('who_student', eSyntax)
  rec('who_rules', eRules)
  rec('who_system', eTimeout)
  need('who_student_kind', eSyntax.kind === 'student' && eSyntax.code === 'E_SQL_SYNTAX')
  need('who_rules_kind', eRules.kind === 'rules' && eRules.code === 'E_SQL_FORBIDDEN')
  need('who_system_kind', eTimeout.kind === 'system' && eTimeout.code === 'E_SQL_TIMEOUT')
  need('who_tones_differ', !!eSyntax.tone && !!eRules.tone && !!eTimeout.tone
    && new Set([eSyntax.tone, eRules.tone, eTimeout.tone]).size === 3)
  need('who_wording_differs', new Set([eSyntax.text, eRules.text, eTimeout.text]).size === 3
    && /规则限制/.test(eRules.text) && /系统|中断/.test(eTimeout.text))
  rec('kill_attribution', (document.querySelector('[data-testid="kill-attribution"]')?.textContent || '').replace(/\s+/g, ' ').slice(0, 90))

  // ③ 安全红线（必须被拒，且原因可读）
  const attach = await exec("ATTACH DATABASE 'other.db' AS other")
  rec('attach_blocked', attach.error)
  need('attach_blocked', attach.error?.code === 'E_SQL_FORBIDDEN')
  const multi = await exec('SELECT 1; DROP TABLE student')
  rec('multi_blocked', multi.error)
  need('multi_blocked', multi.error?.code === 'E_SQL_MULTI')
  const badTable = await exec('SELECT * FROM no_such_table')
  rec('bad_table_error', badTable.error)
  need('bad_table_error', badTable.error?.code === 'E_SQL_NO_OBJECT' && /no such table/.test(badTable.error?.msg || ''))

  // ④ maxRows 截断要明示
  const many = await exec('SELECT * FROM sc')
  rec('truncate_notice', document.querySelector('[data-testid="truncate-note"]')?.textContent?.trim().slice(0, 80) || null)
  rec('maxrows', limits.value.maxRows)
  need('maxrows_declared', Number(limits.value.maxRows) > 0)

  // ⑤ reset 回到初始态（先破坏再 reset）
  await exec('DROP TABLE student')
  need('dropped', !tables.value.some((t) => t.name === 'student'))
  const resetBtn = document.querySelector('[data-testid="btn-reset"]') as HTMLButtonElement | null
  need('reset_button', !!resetBtn)
  // 自检里不弹 confirm：直接调接口（真实 UI 走确认框，见 E2E 里对按钮的断言）
  const r = await api.sandboxReset(dataset.value, session.value?.sessionId)
  tables.value = schemaToTables(r.schema)
  rec('reset_tables', tables.value.map((t) => `${t.name}(${t.rowCount})`))
  // 初始 schema 的表名随数据集而变（真后端 sc = students/courses/enrollments）→
  // 断言"表都回来了且行数 > 0"，而不是写死某张表的行数（那是我 mock 的假设）
  const restored = tables.value.filter((x) => Number(x.rowCount) > 0)
  rec('reset_restores', restored.length >= 2 ? tables.value.map((x) => `${x.name}(${x.rowCount})`) : false)
  need('reset_restores', restored.length >= 2)

  // ⑥ 答疑：报错 SQL → 流式 hint + 引用可跳
  await exec('SELECT * FROM no_such_table')
  const askBtn = document.querySelector('[data-testid="btn-ask"]') as HTMLButtonElement | null
  need('ask_button', !!askBtn)
  askBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  for (let i = 0; i < 80 && (askBusy.value || !askText.value); i++) await new Promise((r) => setTimeout(r, 100))
  await new Promise((r) => setTimeout(r, 400))
  rec('ask', { len: askText.value.length, stages: askStages.value.length, citations: citations.value.length, head: askText.value.slice(0, 60), context: askContext.value })
  need('ask_streamed', askText.value.length > 40 && askStages.value.length > 0)
  need('ask_cites_kb', citations.value.length > 0 && citations.value.every((c) => c.href.includes('#/wiki')))
  need('ask_kept_hint_style', /先别急着|先问|提示/.test(askText.value))
  need('ask_sees_error', String((askContext.value as any)?.error || '').includes('no such table'))
  rec('citation_links', citations.value.map((c) => c.href))
  const citeEl = document.querySelector('[data-testid="citation"] a') as HTMLElement | null
  rec('citation_anchor', citeEl?.getAttribute('href'))
  need('citation_anchor', !!citeEl && (citeEl.getAttribute('href') || '').startsWith('#/wiki'))

  const report = { ok: failed.length === 0, checks, failed }
  writeReport('selftest-report', report)
  const box = document.getElementById('selftest-panel')
  if (box) box.textContent = report.ok ? '自检通过' : `自检未通过：${failed.join(', ')}`
  return report
}
</script>

<template>
  <div class="lab">
    <h1 class="sec-title" data-testid="lab-title">SQL 练习台 <span class="cnt" style="color: var(--muted)">学生</span></h1>

    <!-- 后端没提供沙箱时**不摆假控件**（空下拉框看着像能用，其实点了什么也不会发生） -->
    <div v-if="sandboxReported && !missing.length" class="lab-bar">
      <label class="small">引擎
        <select v-model="engine" data-testid="engine-select">
          <option v-for="e in engines" :key="e.id" :value="e.id" :disabled="!e.available">
            {{ e.label }}{{ e.available ? '' : `（不可用：${e.reason}）` }}
          </option>
        </select>
      </label>
      <span class="pill" data-testid="dialect">{{ sessionDialect || engineInfo?.dialect || '—' }}</span>
      <label class="small">数据集
        <select v-model="dataset" data-testid="dataset-select" @change="openSession()">
          <option v-for="d in datasets" :key="d.id" :value="d.id">{{ d.label }}</option>
        </select>
      </label>
      <button type="button" data-testid="btn-reset" :disabled="busy || !engineAvailable" @click="reset">重置到初始 schema</button>
      <span class="right" />
      <span class="meta faint" data-testid="limits">maxRows={{ limits.maxRows }} · 超时 {{ limits.timeoutMs }}ms</span>
    </div>

    <!-- ★ 后端既没上报 sandbox 能力、/sandbox/* 也 404：如实说清楚（实测真后端 v1.0.0 就是这样） -->
    <div v-if="!sandboxReported || missing.length" class="note bad" data-testid="sandbox-missing">
      <b>后端尚未提供 SQL 沙箱</b>（本页不假装能执行 SQL）：
      <ul style="margin: 4px 0 0; padding-left: 18px">
        <li v-if="!sandboxReported"><code>/capabilities</code> 里**没有 `sandbox` 段**（前端据此无法知道有哪些引擎）</li>
        <li v-for="(m, i) in missing" :key="i"><code>{{ m.path }}</code> → <code>{{ m.code }}</code>：{{ m.msg }}</li>
      </ul>
      <div class="small" style="margin-top: 6px">
        需求出处：<code>docs/SETTINGS_AND_SANDBOX.md §3</code>（`/sandbox/session|execute|reset|datasets|ask`）与
        <code>docs/LAB_DB_DEPLOY.md §6/§7</code>（完整 CRUD + 安全红线：每学生独立库、禁 ATTACH、进程级硬超时）。
        接口就绪后本页无需改动即可用。
      </div>
    </div>

    <!-- 引擎不可用：禁用 + 原因 + 指向部署文档（不能只说"不可用"） -->
    <div v-else-if="!engineAvailable" class="note bad" data-testid="engine-gate">
      <b>该引擎不可用</b>：{{ engineInfo?.reason || '未上报原因' }}
      <div class="small" style="margin-top: 4px">
        部署方法见 <code>{{ engineInfo?.doc || 'docs/LAB_DB_DEPLOY.md' }}</code>；在修好之前这里不会假装能跑。
      </div>
    </div>

    <!-- 方言显著标注（诚实：SQLite ≠ MySQL） -->
    <div v-if="engineAvailable && !missing.length" class="dialect" data-testid="dialect-note">
      <div class="dh" @click="dialectNoteOpen = !dialectNoteOpen">
        <b>当前方言：{{ sessionDialect || engineInfo?.dialect }}</b>
        <span class="small muted">与课程用的 MySQL 有差异 —— 这些实验在 SQLite 上做不了：存储过程、权限/角色（见对照表）</span>
        <span class="right small">{{ dialectNoteOpen ? '收起 ▾' : '展开 ▸' }}</span>
      </div>
      <table v-if="dialectNoteOpen" class="table">
        <thead><tr><th>SQLite</th><th>MySQL</th><th>说明</th></tr></thead>
        <tbody>
          <tr v-for="(n, i) in dialectNotes" :key="i">
            <td class="mono small">{{ n.sqlite }}</td><td class="mono small">{{ n.mysql }}</td><td class="small">{{ n.note }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="note" class="note" :class="noteKind" data-testid="lab-note">{{ note }}</div>

    <div v-if="sandboxReported && !missing.length" class="lab-main">
      <section class="panel editor-panel">
        <div class="crud">
          <span class="small muted">快捷语句：</span>
          <button v-for="s in CRUD_SNIPPETS" :key="s.label" type="button" :data-snippet="s.label" @click="useSnippet(s)">{{ s.label }}</button>
        </div>
        <textarea
          v-model="sql"
          class="sqlbox"
          data-testid="sql-input"
          rows="6"
          spellcheck="false"
          placeholder="写一条 SQL（一次只允许一条语句）&#10;SELECT * FROM student"
          @keydown.ctrl.enter.prevent="run()"
          @keydown.meta.enter.prevent="run()"
        />
        <div class="row">
          <button class="primary" type="button" data-testid="btn-run" :disabled="busy || !engineAvailable" @click="run()">
            {{ busy ? '执行中…' : '运行（Ctrl+Enter）' }}
          </button>
          <button type="button" data-testid="btn-ask" :disabled="askBusy || !engineAvailable" @click="ask()">让 AI 助教看看（答疑）</button>
          <span class="right small faint">每次执行都会记审计（教学追溯）</span>
        </div>

        <!-- 结果 -->
        <!-- ★ 错误按 `who` 分三档渲染（Lead 硬要求）：学生的错 / 规则限制 / 系统超时 —— 长得不一样 -->
        <div
          v-if="runError"
          class="note who-note"
          :class="runError.kind === 'rules' ? 'warn' : 'bad'"
          data-testid="run-error"
          :data-code="runError.code"
          :data-who="runError.who || ''"
          :data-who-kind="runError.kind"
        >
          <div class="who-head">
            <span class="who-badge" :data-tone="whoText.tone">{{ runError.whoLabel || whoText.title }}</span>
            <b>{{ runError.code }}</b>
            <span class="small muted">{{ whoText.title }}</span>
          </div>
          <div class="who-body">{{ runError.localReading || runError.msg }}</div>
          <div v-if="runError.hint" class="small" style="margin-top: 4px">
            <b>怎么改：</b>{{ runError.hint }}
          </div>
          <div v-if="runError.killedBy" class="small" style="margin-top: 4px" data-testid="kill-attribution">
            中断归因：<code>killedBy={{ runError.killedBy }}</code>
            <code>hardKilled={{ runError.hardKilled ? 'true' : 'false' }}</code>
            {{ runError.hardKilled ? '（进程被硬杀，可能已留下半成品数据）' : '（进程正常退出，数据未受影响）' }}
          </div>
          <div class="small" style="margin-top: 4px">{{ whoText.note }}</div>
          <div class="small" style="margin-top: 4px">
            <span v-if="runError.kind === 'student'">看不懂报错？点上面的<b>答疑</b>，让 AI 先帮你定位是哪一类问题。</span>
            <span v-else-if="runError.kind === 'rules'">这类拒绝是**设计如此**，别改 SQL 硬试；点<b>答疑</b>可以问"这类实验该怎么做"。</span>
            <span v-else>这类失败不是你的 SQL 写错；点<b>答疑</b>可以把 killedBy 一起交给 AI 分析。</span>
          </div>
        </div>
        <div v-else-if="result" class="result" data-testid="result">
          <div class="small muted" data-testid="result-meta">
            {{ result.rowCount }} 行 · {{ result.elapsedMs }}ms · 方言 {{ result.dialect || engineInfo?.dialect }}
          </div>
          <div v-if="result.truncated" class="note warn" data-testid="truncate-note">
            结果被截断：仅显示前 {{ result.maxRows }} 行（共 {{ result.rowCount }} 行）。要看完请加 <code>LIMIT</code>/<code>WHERE</code>。
          </div>
          <table v-if="result.columns.length" class="table" data-testid="result-table">
            <thead><tr><th v-for="c in result.columns" :key="c">{{ c }}</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in result.rows" :key="i">
                <td v-for="(v, j) in r" :key="j" class="mono small">{{ v === null ? 'NULL' : v }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="small muted">该语句没有返回结果集（DDL/DML 正常返回空）。</div>
        </div>
      </section>

      <aside class="side">
        <section class="panel">
          <h2 style="margin-top: 0">沙箱表</h2>
          <div data-testid="table-list">
            <div v-for="t in tables" :key="t.name" class="trow" :data-table="t.name">
              <b class="mono">{{ t.name }}</b>
              <span class="meta faint">{{ t.rowCount }} 行</span>
              <span class="meta faint">{{ t.columns.join(', ') }}</span>
            </div>
            <div v-if="!tables.length" class="small muted">还没有表（点「重置」恢复初始 schema）。</div>
          </div>
        </section>

        <section class="panel">
          <h2 style="margin-top: 0">最近执行</h2>
          <div v-for="(h, i) in history" :key="i" class="hist" :class="{ bad: !h.ok }">
            <span class="meta">{{ h.ok ? 'OK' : 'ERR' }}</span> <code>{{ h.sql.slice(0, 60) }}</code>
          </div>
          <div v-if="!history.length" class="small muted">还没有执行记录。</div>
        </section>
      </aside>
    </div>

    <!-- 答疑面板：流式 + 引用可跳原文 -->
    <section v-if="askOpen" class="panel ask" data-testid="ask-panel">
      <h2 style="margin-top: 0">
        AI 助教答疑
        <span v-if="askBusy" class="pill orange">思考中…</span>
        <span v-else class="pill ok">已完成</span>
      </h2>
      <div class="small muted" data-testid="ask-context">
        上下文：SQL {{ (askContext as any)?.sql ? '✓' : '—' }} · 报错 {{ (askContext as any)?.error ? '✓' : '（无报错）' }} · schema ✓ · 最近执行 {{ (askContext as any)?.recent ?? 0 }} 条
        <!-- 读不到就如实说，不让用户以为看过了 -->
        <span v-if="!askContext" class="gate-note" data-testid="ask-context-missing">
          未拿到上下文声明：本次回答可能没看到你的报错与 schema —— 别当成"AI 看过你的 SQL"。
        </span>
      </div>
      <ol class="stages">
        <li v-for="(s, i) in askStages" :key="i" class="small faint">{{ s }}</li>
      </ol>
      <pre class="asktext" data-testid="ask-text">{{ askText || '（等待回答…）' }}</pre>
      <div v-if="askError" class="note bad" data-testid="ask-error">答疑流异常：{{ askError }}</div>
      <div v-if="citations.length" class="cites" data-testid="citation">
        <span class="small muted">引用的知识库卡片（可跳原文）：</span>
        <a v-for="c in citations" :key="c.card_id" class="xr" :href="c.href" :data-card="c.card_id" @click.prevent="gotoCitation(c.href)">{{ c.name }}</a>
      </div>
    </section>

    <div id="selftest-panel" class="small faint" />
  </div>
</template>

<style scoped>
.lab { padding: 14px 22px 40px; max-width: 1240px; margin: 0 auto; }
.lab-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 7px 12px;
  background: var(--paper-2); border: var(--hair) solid var(--rule); border-top: 2px solid var(--rule-strong); }
.lab-main { display: flex; gap: 16px; align-items: flex-start; margin-top: 12px; }
.editor-panel { flex: 1 1 auto; min-width: 0; }
.side { flex: 0 0 320px; }
.crud { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
.sqlbox { width: 100%; font-family: var(--font-mono); font-size: 13px; line-height: 1.6; padding: 10px;
  border: var(--hair) solid var(--rule-strong); border-radius: var(--r-sm); background: var(--panel); color: var(--ink); }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
.table th, .table td { text-align: left; padding: 4px 8px; border-bottom: var(--hair) solid var(--rule); }
.result { margin-top: 10px; }
.dialect { margin: 10px 0; border-left: 3px solid var(--accent); background: color-mix(in srgb, var(--accent-soft) 35%, transparent); }
.dh { display: flex; align-items: center; gap: 8px; padding: 7px 10px; cursor: pointer; }
.trow { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; border-bottom: var(--hair) solid var(--rule); flex-wrap: wrap; }
.hist { display: flex; gap: 6px; padding: 2px 0; font-size: 12px; border-bottom: var(--hair) dotted var(--rule); }
.hist.bad { color: var(--bad); }
.ask { margin-top: 12px; }
.stages { margin: 6px 0; padding-left: 18px; }
.asktext { white-space: pre-wrap; font-family: var(--font-body); font-size: 13.5px; }
.cites { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
/* 三档错误的视觉区分：徽标颜色 + 左边框（学生的错=橙、规则=蓝、系统=红） */
.who-note { border-left: 3px solid var(--bad); }
.who-note.warn { border-left-color: var(--warn); }
.who-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.who-badge { display: inline-block; padding: 1px 7px; font-size: 12px; font-weight: 600;
  border: var(--hair) solid currentColor; border-radius: var(--r-sm); }
.who-badge[data-tone="student"] { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.who-badge[data-tone="rules"] { color: var(--accent-ink); background: var(--accent-soft); }
.who-badge[data-tone="system"] { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); }
.who-badge[data-tone="unknown"] { color: var(--muted); }
.who-body { margin-top: 5px; font-size: 13.5px; }
</style>










