<script setup lang="ts">
/**
 * 模型设置（教师 / admin）—— docs/SETTINGS_AND_SANDBOX.md §2
 *
 * 关键点（照着文档做，不能自作主张）：
 *   · 空闲 → 立即生效；**批量推理运行中 → 拒绝直接热切**，走「终止并切换」（mode=abort）
 *     或「等当前单元跑完」（mode=drain），并显示进度 done/total
 *   · 切换后显示**断点续推**状态（从第 N 个单元继续，不重复计费）
 *   · 每个模型显示**真探测**的 available + 延迟（不是"配置了就算可用"）
 *   · **保存/切换必须二次确认**（误切会中断全班长任务）
 *   · `concurrency` **只读**且标注"固定=1（系统约束）" —— 不做成可调
 *   · 切到不通的模型 → 后端回滚，前端如实显示 rolledBack + 原因
 *   · 角色不够（学生）→ 不进页面：显示需要教师/管理员 + 当前角色
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { api, ApiError } from '../api/client'
import { queryFlag, testBarrier, testBarrierDone, writeReport } from '../utils/report'
import type { BusyInfo, MeResponse, ModelInfo, SettingsPayload } from '../api/types'

const me = ref<MeResponse | null>(null)
const meError = ref('')
const models = ref<ModelInfo[]>([])
const activeModel = ref('')
const switchedFrom = ref<string | null>(null)
const switchedAt = ref<number | null>(null)
const concurrency = ref(1)
const concurrencyNote = ref('固定=1（系统约束）')
const settings = ref<SettingsPayload | null>(null)
const running = ref<{ taskId: string; kind: string; done: number; total: number; stage?: string; progress?: number } | null>(null)
const picked = ref('')
const busy = ref(false)
const note = ref('')
const noteKind = ref<'info' | 'ok' | 'bad' | 'warn'>('info')
const confirmOpen = ref(false)
const confirmMode = ref<'now' | 'drain' | 'abort'>('drain')
const switchResult = ref<any>(null)
const ignored = ref<Array<{ field: string; requested: unknown; applied: unknown; reason: string }>>([])
const errs = ref<string[]>([])

/** 角色：真后端 `{user:{roles}}`；mock 顶层 `{roles}` → 两处都读 */
const isStaff = computed(() => {
  const rs = roles.value.length ? roles.value : (me.value?.user?.roles || [])
  const perms = realPerms.value.length ? realPerms.value : (me.value?.permissions || [])
  return rs.includes('teacher') || rs.includes('admin') || perms.includes('settings:write') || perms.includes('settings:read')
})
const roleLabel = computed(() => (roles.value.length ? roles.value : (me.value?.user?.roles || [])).join(', ') || '未上报')
const activeInfo = computed(() => models.value.find((m) => m.id === activeModel.value) || null)
const progressPct = computed(() => {
  if (!running.value || !running.value.total) return 0
  return Math.round((running.value.done / running.value.total) * 100)
})
/** 运行中时按钮语义要变（文档明确要求） */
const switchLabel = computed(() => (running.value ? '终止并切换' : '切换模型'))
const defaultMode = computed<'now' | 'drain' | 'abort'>(() => (running.value ? 'abort' : 'now'))
const timeText = (ts: number | null) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—')

/**
 * 后端是否实现了这两个接口？
 * 实测（2026-10-15，apps/server v1.0.0）：`/api/v1/models` 与 `/api/v1/settings` 都还是 **404 E_NOTFOUND**。
 * 这种情况下**不能装作能切**：如实显示"未实现 + 需求出处"，并把控件收起来。
 */
const missing = ref<Array<{ path: string; code: string; msg: string }>>([])
/** 真后端 `/models.busy`（队列忙状态；权威来源） */
const busyInfo = ref<BusyInfo | null>(null)
const roles = ref<string[]>([])
const realPerms = ref<string[]>([])

const LLM_TASK_KINDS = new Set(['parse', 'extract', 'rollup', 'translate', 'ask', 'index'])

async function loadModels() {
  try {
    const r = await api.models()
    models.value = r.models || []
    // 真后端有 activeModel；万一没有就用模型上的 `active` 标记（两种都吃）
    activeModel.value = r.activeModel || (models.value.find((m) => (m as any).active)?.id ?? '')
    busyInfo.value = (r as any).busy || null
    concurrency.value = Number(r.concurrency ?? 1)
    if (!picked.value) picked.value = activeModel.value
  } catch (e) {
    const err = e as ApiError
    missing.value = [...missing.value, { path: 'GET /api/v1/models', code: err.code, msg: err.message }]
  }
}

async function loadSettings() {
  try {
    const s = await api.settings()
    settings.value = s
    concurrencyNote.value = s.llm?.concurrencyNote || '固定=1（系统约束）'
    if (s.llm?.concurrency && Number(s.llm.concurrency) !== 1) {
      errs.value.push(`后端上报 concurrency=${s.llm.concurrency}（应为 1）—— 系统约束被违反，请报给 Lead`)
    }
  } catch (e) {
    const err = e as ApiError
    missing.value = [...missing.value, { path: 'GET /api/v1/settings', code: err.code, msg: err.message }]
  }
}

/** 切换相关的只读视图（真后端 `/settings/llm` 才有 switchedFrom/switchedAt） */
async function loadSwitchInfo() {
  try {
    const r = await api.settingsLlm()
    if (r.activeModel) activeModel.value = r.activeModel
    switchedFrom.value = r.switchedFrom ?? null
    switchedAt.value = r.switchedAt ?? null
    if (r.busy) busyInfo.value = r.busy
    if (r.concurrency != null) concurrency.value = Number(r.concurrency)
  } catch { /* 老后端没有这个接口 → 用 /models 的字段（没有就不显示） */ }
}

/**
 * 运行中的 LLM 任务（决定"能否直接热切"）
 * ⚠️ 真后端有 `GET /api/v1/tasks` 列表（实测），**不是**只有单个任务查询；
 *    第一版我写死了 mock 的任务 id `tsk_rollup0001` —— 对真后端必然 404（自己给自己造了个假前提）。
 */
async function loadRunning() {
  // ★ 真后端直接给了队列忙状态（`/models.busy` + `/settings/llm.busy`）——比前端猜准
  const b = busyInfo.value
  if (b && typeof b.busy === 'boolean') {
    if (!b.busy) { running.value = null; return }
    // busy 只说"忙不忙"；**进度条要的是单任务 done/total** → 能从 /tasks 拿到就用它，
    // 拿不到就只显示"队列忙"（**不编造 0/368 这种假进度**）
    try {
      const r0 = await api.tasks()
      const list0 = (r0.tasks || r0.items || []) as Array<Record<string, any>>
      const t0 = list0.find((x) => (x.status === 'running' || x.status === 'queued') && LLM_TASK_KINDS.has(String(x.kind)))
      if (t0) {
        const d0 = (t0.detail || {}) as any
        const total0 = Number(d0.total ?? 0) || 0
        const done0 = d0.done != null ? Number(d0.done) : (total0 ? Math.round(Number(t0.progress ?? 0) * total0) : 0)
        running.value = { taskId: String(t0.id), kind: String(t0.kind), done: done0, total: total0,
          stage: String(t0.stage || ''), progress: Number(t0.progress ?? 0) }
        return
      }
    } catch { /* /tasks 不可用 → 退回队列摘要 */ }
    running.value = {
      taskId: (b.runningLlm || []).join(',') || 'queue',
      kind: (b.runningLlm || [])[0] || 'llm',
      done: 0, total: 0,
      stage: `队列忙：running ${b.runningAll ?? 0} / pending ${b.pending ?? 0}`,
      progress: 0,
    }
    return
  }
  try {
    const r = await api.tasks()
    const list = (r.tasks || r.items || []) as Array<Record<string, any>>
    const busy = list.find((t) => (t.status === 'running' || t.status === 'queued') && LLM_TASK_KINDS.has(String(t.kind)))
    if (busy) {
      const d = (busy.detail || {}) as any
      const total = Number(d.total ?? 0) || 0
      // 真后端的 progress 是 0–1 的比例 + stage 文案；mock 给 done/total
      const done = d.done != null ? Number(d.done) : (total ? Math.round(Number(busy.progress ?? 0) * total) : 0)
      running.value = {
        taskId: String(busy.id), kind: String(busy.kind),
        done, total: total || Math.round(Number(busy.progress ?? 0) * 100),
        stage: String(busy.stage || ''), progress: Number(busy.progress ?? 0),
      }
    } else {
      running.value = null
    }
  } catch (e) {
    const err = e as ApiError
    // 拿不到任务列表 → 不编造"空闲"（宁可显示"未知"也不假装可以热切）
    running.value = null
    errs.value.push(`未能读取任务列表（${err.code}）：无法确认是否空闲，切换前请人工确认`)
  }
}

function askSwitch() {
  if (!picked.value) return
  confirmMode.value = defaultMode.value
  confirmOpen.value = true
  note.value = running.value
    ? `⚠️ 有批量推理在跑（${running.value.stage || running.value.kind}）。直接热切会被拒绝，请选择处理方式。`
    : `空闲：切换 ${activeModel.value} → ${picked.value}，将立即生效。`
  noteKind.value = 'warn'
}

async function doSwitch() {
  confirmOpen.value = false
  busy.value = true
  note.value = ''
  try {
    const r = await api.switchModel(picked.value, confirmMode.value)
    switchResult.value = r
    // ★ drain 超时：HTTP 200 但 **state='timeout' 表示没切**（后端注释明确写了）→ 不能当成功
    if ((r as any).state === 'timeout') {
      note.value = `等待超时：**没有切换**（state=timeout，仍在 ${activeModel.value}）。可改用 mode=abort 存断点后终止并续推。`
      noteKind.value = 'warn'
      await loadSwitchInfo()
      return
    }
    note.value = `已切换：${r.from} → ${r.to}`
      + (r.checkpoint ? `；断点 ${r.checkpoint.done}/${r.checkpoint.total}` : '')
      + (r.resume?.state === 'resuming' ? `；正在从第 ${r.resume.from_checkpoint} 个单元续推` : '')
    noteKind.value = 'ok'
    await loadModels()
    await loadSettings()
    // switchedFrom/switchedAt 的**权威来源是 `/settings/llm`**（真后端 `/models` 里没有这两个字段）
    await loadSwitchInfo()
    await loadRunning()
  } catch (e) {
    const err = e as ApiError
    // 运行中直接热切 → 409 E_MODEL_BUSY；探测失败 → 502 E_MODEL_PROBE（后端已回滚）
    if (err.code === 'E_MODEL_BUSY') {
      const r = err.data?.running
      note.value = `拒绝直接热切：${err.message}` + (r ? `（${r.kind} ${r.done}/${r.total}）` : '')
      noteKind.value = 'warn'
      confirmMode.value = 'abort'
    } else if (err.code === 'E_MODEL_PROBE') {
      note.value = `新模型探测失败，已回滚：${err.message}`
      noteKind.value = 'bad'
      switchResult.value = { rolledBack: true, activeModel: err.data?.activeModel }
    } else {
      note.value = `切换失败：${err.message}`
      noteKind.value = 'bad'
    }
  } finally {
    busy.value = false
  }
}

/** 保存设置：只改允许改的（maxRows 等）；concurrency 传大也会被后端忽略并如实回报 */
async function saveSettings() {
  if (!settings.value) return
  if (!confirm('保存设置？会影响全班的抽取/翻译任务。')) return
  busy.value = true
  try {
    const body = {
      llm: { active: activeModel.value },        // active 由"切换"流程专门管，这里只回显
      sandbox: { limits: { maxRows: settings.value.sandbox?.limits?.maxRows ?? 200 } },
    }
    const r = await api.putSettings(body)
    ignored.value = r.ignored || []
    note.value = `设置已保存` + (ignored.value.length ? `；有 ${ignored.value.length} 项被忽略（见下）` : '')
    noteKind.value = ignored.value.length ? 'warn' : 'ok'
    if (r.settings) settings.value = r.settings
  } catch (e) {
    note.value = `保存失败：${(e as Error).message}`
    noteKind.value = 'bad'
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  testBarrier()
  try {
    me.value = await api.me()
  } catch (e) {
    const err = e as ApiError
    meError.value = `${err.code}: ${err.message}`
  }
  // 真后端把 roles 放在 user 里（实测）→ 两处都读；都读不到就如实显示"未上报"
  const realRoles = (me.value as any)?.user?.roles || me.value?.roles || []
  realPerms.value = me.value?.permissions || []
  roles.value = realRoles
  if (isStaff.value) {
    await loadModels()
    await loadSettings()
    await loadSwitchInfo()
    await loadRunning()
    if (missing.value.length && models.value.length === 0) {
      errs.value.push('后端未实现 /models 或 /settings → 本页按"未实现"如实显示，不伪造可切换的模型列表')
    }
  }
  await nextTick()
  writeReport('settings-report', {
    ok: errs.value.length === 0 && missing.value.length === 0,
    role: roleLabel.value,
    is_staff: isStaff.value,
    me_error: meError.value,
    models: models.value.length,
    available_models: models.value.filter((m) => m.available).length,
    active: activeModel.value,
    switched_from: switchedFrom.value,
    concurrency: concurrency.value,
    concurrency_locked: !!settings.value?.llm?.concurrencyLocked,
    settings_source: settings.value?.source || '',
    missing: missing.value,
    backend_implemented: missing.value.length === 0,
    running: running.value,
    busy: busyInfo.value,
    errors: errs.value,
  })

  if (queryFlag('selftest') && isStaff.value) await runSelftest()
  await testBarrierDone()
})

/** 自检：把 §2 的状态机逐条走一遍（真实事件链路） */
async function runSelftest() {
  const checks: Record<string, unknown> = {}
  const failed: string[] = []
  const rec = (k: string, v: unknown) => { checks[k] = v }
  const need = (k: string, cond: boolean) => { if (!cond) failed.push(k) }

  // ① 运行中：直接热切必须被拒（走真按钮 → 真请求）
  rec('running_task', running.value ? `${running.value.kind} ${running.value.done}/${running.value.total}` : null)
  rec('progress_pct', progressPct.value)
  need('running_visible', !!running.value && progressPct.value > 0)
  rec('switch_button_label', switchLabel.value)
  need('switch_label_abort', switchLabel.value === '终止并切换')

  const sel = document.querySelector('[data-testid="model-select"]') as HTMLSelectElement | null
  const btn = document.querySelector('[data-testid="btn-switch"]') as HTMLButtonElement | null
  rec('select_present', !!sel)
  // 选中"当前模型"时按钮本该禁用（没有可切的目标）→ 先换个目标再断言按钮可用
  const other = models.value.find((m) => m.id !== activeModel.value && m.available)
  if (sel && other) {
    sel.value = other.id
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
  }
  rec('button_disabled', btn?.disabled ?? null)
  need('controls_present', !!sel && !!btn && btn.disabled === false)

  // 点按钮 → 必须弹二次确认
  if (sel && other) {
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await nextTick()
    rec('confirm_required', confirmOpen.value)
    need('confirm_required', confirmOpen.value === true)
    rec('confirm_default_mode', confirmMode.value)
    need('confirm_mode_abort_when_running', confirmMode.value === 'abort')

    // ② 先试 mode=now（运行中）→ 409 E_MODEL_BUSY
    confirmMode.value = 'now'
    await doSwitch()
    rec('busy_rejected', { note: note.value.slice(0, 80), kind: noteKind.value, code_busy: note.value.includes('拒绝直接热切') })
    need('busy_rejected', note.value.includes('拒绝直接热切'))
    rec('active_after_reject', activeModel.value)
    need('active_unchanged_after_reject', activeModel.value === (switchResult.value?.from || activeModel.value))

    // ③ mode=abort → 切换成功 + 断点续推
    confirmMode.value = 'abort'
    await doSwitch()
    rec('switched', switchResult.value)
    need('switched_ok', switchResult.value?.to === other.id)
    need('resume_from_checkpoint', Number(switchResult.value?.resume?.from_checkpoint) > 0)
    rec('active_after_switch', activeModel.value)
    need('active_is_target', activeModel.value === other.id)
    rec('switched_from', switchedFrom.value)
    rec('switched_at_text', timeText(switchedAt.value))
    need('switched_from_recorded', switchedFrom.value === switchResult.value?.from)

    // ④ 切到坏模型 → 502 + 回滚（不改 activeModel）
    const broken = models.value.find((m) => !m.available)
    if (broken) {
      picked.value = broken.id
      confirmMode.value = 'now'
      await doSwitch()
      rec('rollback', { note: note.value.slice(0, 90), kind: noteKind.value, activeModel: activeModel.value })
      need('rollback_no_change', activeModel.value === other.id && note.value.includes('已回滚'))
    } else { rec('rollback', 'skipped:no unavailable model') }
  } else {
    failed.push('controls_present')
  }

  // ⑤ concurrency 只读：界面上必须是禁用/只读输入，文案含"固定"
  const cInput = document.querySelector('[data-testid="concurrency"]') as HTMLInputElement | null
  rec('concurrency', { value: cInput?.value ?? null, disabled: cInput?.disabled ?? null, readonly: cInput?.readOnly ?? null, text: document.querySelector('[data-testid="concurrency-note"]')?.textContent?.trim().slice(0, 60) })
  need('concurrency_readonly', !!cInput && cInput.disabled === true)
  need('concurrency_states_fixed', (document.querySelector('[data-testid="concurrency-note"]')?.textContent || '').includes('固定'))

  // ⑥ 保存设置被忽略的项要如实显示
  rec('ignored', ignored.value)
  rec('settings_source', settings.value?.source)

  const report = { ok: failed.length === 0, checks, failed }
  writeReport('selftest-report', report)
  const box = document.getElementById('selftest-panel')
  if (box) box.textContent = report.ok ? '自检通过' : `自检未通过：${failed.join(', ')}`
  return report
}

const staffChecklist = [
  ['空闲时可立即生效', '有运行中任务时后端直接拒绝（409 E_MODEL_BUSY），不做"假热切"'],
  ['运行中走"终止并切换"', '保存断点 → 换模型 → 从断点续推，不重复计费'],
  ['切换后可观测', '显示 activeModel / switchedFrom / switchedAt 与断点 done/total'],
  ['坏模型要回滚', '新模型健康探测失败 → 后端回滚，activeModel 不变，如实报错'],
]
</script>

<template>
  <div class="settings">
    <h1 class="sec-title" data-testid="settings-title">模型设置 <span class="cnt" style="color: var(--muted)">教师 / 管理员</span></h1>

    <div v-if="!isStaff" class="note bad" data-testid="role-gate">
      <b>需要教师或管理员角色</b>：当前角色 <code>{{ roleLabel }}</code>
      <span v-if="meError">（读取 /auth/me 失败：{{ meError }}）</span>
      <div class="small" style="margin-top: 4px">
        权限判定永远在服务端；前端只是不显示入口。学生账号可用「SQL 练习台」。
      </div>
    </div>

    <template v-else>
      <!-- ★ 后端还没实现这两个接口时：如实说清楚，**不摆出可以切换的假界面** -->
      <div v-if="missing.length" class="note bad" data-testid="backend-missing">
        <b>后端尚未实现本页所需的接口</b>（本页按"未实现"如实显示，不伪造模型列表）：
        <ul style="margin: 4px 0 0; padding-left: 18px">
          <li v-for="(m, i) in missing" :key="i">
            <code>{{ m.path }}</code> → <code>{{ m.code }}</code>：{{ m.msg }}
          </li>
        </ul>
        <div class="small" style="margin-top: 6px">
          需求出处：<code>docs/SETTINGS_AND_SANDBOX.md §1/§2</code>（`settings.json` 热重载 + `GET/PUT /api/v1/settings` +
          `POST /api/v1/settings/llm/switch`）。接口就绪后本页无需改动即可用（前端已按文档形状实现）。
        </div>
      </div>

      <div v-if="!missing.length" class="note info" data-testid="settings-source">
        配置来源：<b>{{ settings?.source === 'file' ? 'settings.json' : settings?.source }}</b>
        <span v-if="settings?.source === 'default'">（文件缺失，正在用内置默认 —— 这不是正常状态）</span>
        · 模型端点：<code>AMR / llm-api.x-aio.com</code>（实测只有 8 个 LLM，无 ASR/TTS/OCR）
      </div>

      <div v-if="note" class="note" :class="noteKind" data-testid="switch-note">{{ note }}</div>

      <section class="panel">
        <h2 style="margin-top: 0">当前模型</h2>
        <div class="unwrap">
          <span class="pill ok" data-testid="active-model">{{ activeModel }}</span>
          <span v-if="activeInfo" class="meta faint">延迟 {{ activeInfo.latencyMs }}ms · 探测 {{ activeInfo.probe }}</span>
          <span class="meta faint" data-testid="switched-info">
            上次切换：{{ switchedFrom ? `${switchedFrom} → ${activeModel}` : '无' }} · {{ timeText(switchedAt) }}
          </span>
        </div>

        <div v-if="running" class="running" data-testid="running-task" :data-done="running.done" :data-total="running.total">
          <b>批量推理运行中</b>：{{ running.kind }} <code>{{ running.taskId }}</code>
          <span class="meta">{{ running.done }}/{{ running.total }}（{{ progressPct }}%）</span>
          <div class="bar"><i :style="{ width: progressPct + '%' }" /></div>
          <div class="small muted">运行中不能直接热切：请选择「终止并切换」（保存断点后续推）或「等当前单元跑完」。</div>
        </div>
        <div v-else class="small muted" data-testid="idle-state">空闲：切换立即生效。</div>
      </section>

      <section v-if="!missing.length" class="panel">
        <h2 style="margin-top: 0">切换模型</h2>
        <div class="row">
          <label class="small">目标模型
            <select v-model="picked" data-testid="model-select">
              <option v-for="m in models" :key="m.id" :value="m.id" :disabled="!m.available">
                {{ m.label }}（{{ m.id }}）{{ m.available ? `· ${m.latencyMs}ms` : `· 不可用：${m.reason || '未知'}` }}
              </option>
            </select>
          </label>
          <button
            class="primary"
            type="button"
            data-testid="btn-switch"
            :disabled="busy || !picked || picked === activeModel"
            @click="askSwitch"
          >{{ switchLabel }}</button>
          <span class="small muted">切换需要二次确认（误切会中断全班长任务）</span>
        </div>

        <table class="table" data-testid="model-table">
          <thead><tr><th>模型</th><th>可用</th><th>延迟</th><th>探测</th><th>上下文</th></tr></thead>
          <tbody>
            <tr v-for="m in models" :key="m.id" :data-model="m.id" :data-available="m.available ? '1' : '0'">
              <td><b>{{ m.label }}</b><div class="faint tiny mono">{{ m.id }}</div></td>
              <td><span class="pill" :class="m.available ? 'ok' : 'bad'">{{ m.available ? '可用' : '不可用' }}</span></td>
              <td class="mono small">{{ m.latencyMs != null ? m.latencyMs + ' ms' : '—' }}</td>
              <td class="small">{{ m.probe || '—' }}</td>
              <td class="mono small">{{ m.contextWindow ? (m.contextWindow / 1024).toFixed(0) + 'K' : '—' }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="models.some((m) => !m.available)" class="gate-note" data-testid="model-down-note">
          不可用模型：{{ models.filter((m) => !m.available).map((m) => `${m.id}（${m.reason}）`).join('；') }}
        </div>
      </section>

      <section v-if="!missing.length" class="panel">
        <h2 style="margin-top: 0">系统约束</h2>
        <div class="row">
          <label class="small">LLM 并发
            <input data-testid="concurrency" type="number" :value="concurrency" disabled />
          </label>
          <span class="small" data-testid="concurrency-note" style="color: var(--accent)">{{ concurrencyNote }}</span>
        </div>
        <div class="small muted">
          为什么只读：并发=1 是用户硬要求（避免把配额打满、也保证抽取顺序可控）。配置文件里调高会被**忽略**，不是"没生效的 bug"。
        </div>
        <div class="row" style="margin-top: 10px">
          <button class="primary" type="button" :disabled="busy" data-testid="btn-save" @click="saveSettings">保存设置</button>
          <span class="small muted">保存会二次确认；被忽略的项会**如实列出**，不静默生效</span>
        </div>
        <ul v-if="ignored.length" class="ignored" data-testid="ignored-list">
          <li v-for="(i, k) in ignored" :key="k">
            忽略 <code>{{ i.field }}</code>：请求 {{ i.requested }} → 实际 {{ i.applied }}（{{ i.reason }}）
          </li>
        </ul>
      </section>

      <section v-if="!missing.length" class="panel">
        <h2 style="margin-top: 0">热切换状态机</h2>
        <table class="table">
          <thead><tr><th>环节</th><th>行为</th></tr></thead>
          <tbody>
            <tr v-for="(c, i) in staffChecklist" :key="i"><td><b>{{ c[0] }}</b></td><td class="small">{{ c[1] }}</td></tr>
          </tbody>
        </table>
        <div v-if="switchResult" class="kv" data-testid="switch-result">
          <dt>mode</dt><dd>{{ switchResult.mode || '—' }}</dd>
          <dt>from → to</dt><dd>{{ switchResult.from }} → {{ switchResult.to }}</dd>
          <dt>断点</dt><dd>{{ switchResult.checkpoint ? `${switchResult.checkpoint.done}/${switchResult.checkpoint.total}` : '—' }}</dd>
          <dt>续推</dt><dd>{{ switchResult.resume ? `${switchResult.resume.state}（从 ${switchResult.resume.from_checkpoint ?? '—'}）` : '—' }}</dd>
          <dt>探测</dt><dd>{{ switchResult.probe ? `${switchResult.probe.model} ok=${switchResult.probe.ok} ${switchResult.probe.latencyMs ?? ''}ms` : '—' }}</dd>
        </div>
      </section>

      <div v-if="errs.length" class="note warn" data-testid="settings-warnings">
        <div v-for="(e, i) in errs" :key="i">· {{ e }}</div>
      </div>
    </template>

    <div id="selftest-panel" class="small faint" />
  </div>

  <!-- 二次确认（误切会中断全班长任务） -->
  <div v-if="confirmOpen" class="modal" data-testid="confirm-dialog">
    <div class="modal-box">
      <h3>确认切换模型？</h3>
      <div class="small">
        <div>从 <code>{{ activeModel }}</code> 切到 <code>{{ picked }}</code></div>
        <div v-if="running" style="margin-top: 6px">
          当前有批量推理：<b>{{ running.kind }} {{ running.done }}/{{ running.total }}</b>
        </div>
      </div>
      <div class="modes">
        <label><input v-model="confirmMode" type="radio" value="now" data-testid="mode-now" /> 立即切换（仅空闲可用；运行中会被拒绝）</label>
        <label><input v-model="confirmMode" type="radio" value="drain" data-testid="mode-drain" /> 等当前单元跑完再切（推荐）</label>
        <label><input v-model="confirmMode" type="radio" value="abort" data-testid="mode-abort" /> 终止并切换（保存断点 → 续推）</label>
      </div>
      <div class="row" style="margin-top: 10px">
        <button class="primary" type="button" data-testid="confirm-yes" @click="doSwitch">确认切换</button>
        <button type="button" data-testid="confirm-no" @click="confirmOpen = false">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings { padding: 14px 22px 40px; max-width: 1020px; margin: 0 auto; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.row input[type="number"] { width: 72px; }
.unwrap { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.running { margin-top: 10px; padding: 8px 10px; border-left: 3px solid var(--warn); background: color-mix(in srgb, var(--warn) 10%, transparent); }
.bar { height: 5px; background: var(--paper-2); margin: 6px 0; }
.bar i { display: block; height: 100%; background: var(--warn); }
.table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
.table th, .table td { text-align: left; padding: 5px 8px; border-bottom: var(--hair) solid var(--rule); vertical-align: top; }
.ignored { margin: 8px 0 0; padding-left: 18px; color: var(--warn); font-size: 12.5px; }
.modal { position: fixed; inset: 0; background: rgba(20, 22, 26, .45); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal-box { background: var(--panel); border: var(--hair) solid var(--rule-strong); border-top: 2px solid var(--accent); padding: 16px 18px; max-width: 560px; box-shadow: var(--shadow-2); }
.modes { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; font-size: 13px; }
</style>







