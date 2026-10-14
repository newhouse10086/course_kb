import { describe, expect, it, vi } from 'vitest'
import { postSse } from '../../src/api/sse'
import { bannerRows, normalizeCapabilities } from '../../src/api/capabilities'
import { ApiError } from '../../src/api/client'

/** 造一个流式 Response（按块吐出，模拟 CDP/真实后端的 chunked SSE） */
function sseResponse(chunks: string[], ok = true) {
  let i = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) { controller.close(); return }
      controller.enqueue(new TextEncoder().encode(chunks[i++]))
    },
  })
  return { ok, status: ok ? 200 : 500, body: stream } as unknown as Response
}

describe('postSse / POST + SSE 流式解析（沙箱答疑用）', () => {
  it('解析 event/data 帧，数据按单行 JSON 解析', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      'event: progress\ndata: {"stage":"组装上下文","detail":{"sql":"SELECT 1"}}\n\n',
      'event: text\ndata: {"delta":"先别急着"}\n\n',
      'event: text\ndata: {"delta":"要答案"}\n\n',
      'event: citation\ndata: {"citations":[{"card_id":"crd_0008","href":"#/wiki?doc=d&card=crd_0008"}]}\n\n',
      'event: done\ndata: {"ok":true,"cited":1}\n\n',
    ])))
    const events: Array<[string, any]> = []
    let closed = false
    await postSse('/api/v1/sandbox/ask', { sql: 'SELECT 1' }, {
      onEvent: (e, d) => events.push([e, d]),
      onClose: () => { closed = true },
    })
    expect(events.map((e) => e[0])).toEqual(['progress', 'text', 'text', 'citation', 'done'])
    expect(events[1][1].delta).toBe('先别急着')
    expect(events[3][1].citations[0].href).toContain('#/wiki')
    expect(closed).toBe(true)
    vi.unstubAllGlobals()
  })

  it('帧被切断在块边界也能拼回来（真实网络常见）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      'event: text\ndata: {"del',
      'ta":"一半"}\n\nevent: done\ndata: {"ok":true}\n\n',
    ])))
    const events: Array<[string, any]> = []
    await postSse('/x', {}, { onEvent: (e, d) => events.push([e, d]) })
    expect(events).toEqual([['text', { delta: '一半' }], ['done', { ok: true }]])
    vi.unstubAllGlobals()
  })

  it('忽略 keepalive 注释帧（`: keepalive`）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      ': keepalive\n\n',
      'event: done\ndata: {"ok":true}\n\n',
    ])))
    const events: string[] = []
    await postSse('/x', {}, { onEvent: (e) => events.push(e) })
    expect(events).toEqual(['done'])
    vi.unstubAllGlobals()
  })

  it('HTTP 错误走 onError，不静默当成功', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([], false)))
    const errs: string[] = []
    await postSse('/x', {}, { onEvent: () => { throw new Error('不该收到事件') }, onError: (m) => errs.push(m) })
    expect(errs[0]).toContain('HTTP 500')
    vi.unstubAllGlobals()
  })

  it('abort 不算错误（不打扰用户）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e }))
    const errs: string[] = []
    await postSse('/x', {}, { onEvent: () => { /* noop */ }, onError: (m) => errs.push(m) })
    expect(errs).toEqual([])
    vi.unstubAllGlobals()
  })
})

describe('ApiError / 机器可读的附加信息', () => {
  it('data 里能带运行中进度（409）与回滚后的 activeModel（502）', () => {
    const busy = new ApiError('E_MODEL_BUSY', '有批量推理在跑', 409, '', '', { running: { done: 137, total: 368 } })
    expect(busy.code).toBe('E_MODEL_BUSY')
    expect(busy.status).toBe(409)
    expect(busy.data.running.done).toBe(137)

    const probe = new ApiError('E_MODEL_PROBE', '探测失败', 502, '', '', { activeModel: 'glm-5.3', rolledBack: true })
    expect(probe.data.activeModel).toBe('glm-5.3')
    expect(probe.data.rolledBack).toBe(true)
  })
})

describe('capabilities / 沙箱引擎按可用性渲染', () => {
  it('sandbox.engines 里的不可用引擎带 reason（前端据此禁用 + 指文档）', () => {
    const m = normalizeCapabilities({
      sandbox: {
        available: true,
        engines: [
          { id: 'sqlite', label: 'SQLite', available: true, dialect: 'SQLite 3.x' },
          { id: 'mysql', label: 'MySQL 8.0', available: false, dialect: 'MySQL 8.0', reason: '未安装 Docker', doc: 'docs/LAB_DB_DEPLOY.md §2.1' },
        ],
        limits: { maxRows: 200, timeoutMs: 3000 },
      },
    })
    // 能力横幅不该因为 sandbox 段而多出"不可用"项（它不是 provider 链）
    expect(bannerRows(m).length).toBeGreaterThan(0)
    const engines = (m.raw as any).sandbox.engines
    expect(engines.filter((e: any) => !e.available).every((e: any) => !!e.reason && !!e.doc)).toBe(true)
  })
})
