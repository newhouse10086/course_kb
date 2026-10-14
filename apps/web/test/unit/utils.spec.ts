import { describe, expect, it } from 'vitest'
import { allNodeIds, extractTime, parseMindmap } from '../../src/utils/markmap'
import { computeWindow, scrollTopForIndex } from '../../src/utils/vscroll'
import { bannerRows, gateText, normalizeCapabilities } from '../../src/api/capabilities'

describe('markmap / parseMindmap', () => {
  // 真实 markmap 常见形态：`-` 不缩进，直接跟在 `##` 下面
  const md = [
    '# 索引与执行计划',
    '## 一、索引基础 (00:02:30)',
    '- 选择性与基数',
    '- 最左前缀',
    '## 二、B+ 树结构 (00:07:30)',
    '- 叶节点与页分裂',
  ].join('\n')

  it('层级正确：# → ## → 零缩进条目挂在**当前章节**下（不是挂在根上）', () => {
    const t = parseMindmap(md)
    expect(t.count).toBeGreaterThanOrEqual(6)
    expect(t.root.children.length).toBe(1)                 // 只有一个 # 根
    const h1 = t.root.children[0]!
    expect(h1.text).toContain('索引与执行计划')
    expect(h1.children.length).toBe(2)                     // 两个 ## 章节
    expect(h1.children[0]!.children.length).toBe(2)        // 条目挂在章节下
    expect(h1.children[0]!.children[0]!.text).toContain('选择性')
    expect(t.maxDepth).toBeGreaterThanOrEqual(3)
  })

  it('从标题里抽出时间锚点（用于跳视频）', () => {
    const t = parseMindmap(md)
    expect(t.root.children[0]!.children[0]!.at).toBe(150_000)
    expect(t.root.children[0]!.children[1]!.at).toBe(450_000)
  })

  it('extractTime 只认括号里的 mm:ss / hh:mm:ss，以及 @Nms / @Ns', () => {
    expect(extractTime('(01:02:03)')).toBe(3_723_000)
    expect(extractTime('(12:34)')).toBe(754_000)
    expect(extractTime('[00:07:30]')).toBe(450_000)
    expect(extractTime('@ 754000 ms')).toBe(754_000)
    expect(extractTime('@12 s')).toBe(12_000)
    expect(extractTime('没有时间')).toBeNull()
    expect(extractTime('(99:99)')).toBeNull()
  })

  it('空输入不炸', () => {
    expect(parseMindmap('').count).toBe(0)
    expect(parseMindmap(null).root.children).toEqual([])
    expect(allNodeIds(parseMindmap(null))).toEqual([])
  })

  it('allNodeIds 返回全部节点 id 且唯一', () => {
    const ids = allNodeIds(parseMindmap(md))
    expect(ids.length).toBe(parseMindmap(md).count)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('带缩进的子弹头仍按缩进嵌套（两种写法都支持）', () => {
    const t = parseMindmap(['# 根', '## 章', '  - 子项', '    - 孙项'].join('\n'))
    const ch = t.root.children[0]!.children[0]!
    expect(ch.children[0]!.text).toContain('子项')
    expect(ch.children[0]!.children[0]!.text).toContain('孙项')
  })
})

describe('vscroll / 虚拟滚动窗口（3000 条字幕只渲染几十行）', () => {
  it('只渲染视口内的行 + overscan', () => {
    const w = computeWindow(3000, 42, 0, 420, 6)
    expect(w.first).toBe(0)
    expect(w.last).toBeLessThan(60)                        // 420/42=10 行 + overscan
    expect(w.offsetY).toBe(0)
    expect(w.count).toBe(w.last - w.first + 1)
  })

  it('滚动到中间时窗口跟着走，且不越界', () => {
    const mid = computeWindow(3000, 42, 42_000, 420, 4)
    expect(mid.first).toBe(996)                            // 1000 - overscan
    expect(mid.offsetY).toBe(mid.first * 42)
    const tail = computeWindow(3000, 42, 42 * 3000, 420, 4)
    expect(tail.last).toBe(2999)
    expect(tail.first).toBeGreaterThan(2980)
  })

  it('占位总高 = total × rowHeight（滚动条才稳定）', () => {
    const w = computeWindow(3000, 42, 12_345, 400)
    expect(w.totalHeight).toBe(126_000)                    // e2e 断言的 spacer 高度
  })

  it('空列表返回空窗口', () => {
    const w = computeWindow(0, 42, 0, 400)
    expect(w.first).toBe(0)
    expect(w.count).toBe(0)
    expect(w.totalHeight).toBe(0)
  })

  it('scrollTopForIndex：行首对齐（可选居中）', () => {
    expect(scrollTopForIndex(10, 42, 420)).toBe(420)
    expect(scrollTopForIndex(0, 42, 420)).toBe(0)
    const centered = scrollTopForIndex(100, 42, 420, true)
    expect(centered).toBe(4200 - (420 - 42) / 2)
  })
})

describe('capabilities / 按能力渲染（契约 §7：providers 逐 kind）', () => {
  const v2 = {
    providers: {
      llm: [{ id: 'amr', label: 'AMR LLM', runtime: 'cloud', configured: true, available: true }],
      asr: [
        { id: 'local', label: '本地 faster-whisper', runtime: 'local', configured: true, available: true },
        { id: 'aliyun', label: '阿里云 ASR', runtime: 'cloud', configured: false, available: false, reason: '缺少 ALIYUN_AK' },
      ],
      ocr: [{ id: 'baidu', label: '百度 OCR', configured: false, available: false, reason: '缺少 BAIDU_OCR_KEY' }],
    },
    pi: { available: true, version: '1.2.0' },
    ffmpeg: { available: true, version: 'N-124868' },
    adapters: ['pdf', 'text'],
  }

  it('读 providers 段：每个 kind 独立判断（ASR 可用 ≠ OCR 可用）', () => {
    const m = normalizeCapabilities(v2)
    expect(m.isAvailable('llm')).toBe(true)
    expect(m.isAvailable('asr')).toBe(true)                 // 多 provider 有一个可用即可用
    expect(m.isAvailable('ocr')).toBe(false)
    expect(m.isAvailable('tts')).toBe(false)                // 后端没报 → 不能假设可用（坑 10）
    expect(m.isAvailable('pi')).toBe(true)
    expect(m.isAvailable('ffmpeg')).toBe(true)
    expect(m.primary('asr')!.id).toBe('local')              // local-first
  })

  it('不可用时必须能拿到**可读原因**（原文来自后端）', () => {
    const m = normalizeCapabilities(v2)
    expect(m.reasonFor('ocr')).toContain('BAIDU_OCR_KEY')
    expect(m.reasonFor('asr')).toBe('')                     // 可用 → 没原因
    expect(m.reasonFor('tts')).toContain('未上报')           // 未上报也要给人话
  })

  it('兼容 v1 扁平段（asr/llm/pi/ffmpeg 直接是对象）', () => {
    const m = normalizeCapabilities({ asr: { available: false, reason: '未安装', configured: true }, llm: { available: true }, pi: { available: false, reason: 'SDK 缺失' } })
    expect(m.isAvailable('asr')).toBe(false)
    expect(m.reasonFor('asr')).toBe('未安装')
    expect(m.isAvailable('llm')).toBe(true)
    expect(m.isAvailable('pi')).toBe(false)
    expect(m.reasonFor('pi')).toBe('SDK 缺失')
  })

  it('兼容顶层写数组的实现（等价于一条 provider 链，reason 不能丢）', () => {
    const m = normalizeCapabilities({ llm: [{ id: 'amr', available: false, reason: '403 需要订阅' }] })
    expect(m.isAvailable('llm')).toBe(false)
    expect(m.reasonFor('llm')).toContain('403')
  })

  it('bannerRows 每个 kind 一行；不可用项必须带原因', () => {
    const rows = bannerRows(normalizeCapabilities(v2))
    const down = rows.filter((r) => !r.available).map((r) => r.kind).sort()
    expect(down).toEqual(['ocr', 'translate', 'tts'])   // 后端没报 translate → 一律按不可用（不假设）
    for (const r of rows.filter((x) => !x.available)) expect(r.reason.length).toBeGreaterThan(0)
    expect(rows.find((r) => r.kind === 'asr')!.used).toContain('faster-whisper')
  })

  it('gateText 给出"…不可用：原因"的整句（禁用入口的可见文案）', () => {
    const m = normalizeCapabilities(v2)
    const t = gateText(m, 'ocr', '识别幻灯片文字')
    expect(t).toContain('识别幻灯片文字')
    expect(t).toContain('BAIDU_OCR_KEY')
  })

  it('空/脏输入不炸：缺的 kind 一律按"不可用 + 有原因"处理', () => {
    const m = normalizeCapabilities(null)
    expect(m.isAvailable('llm')).toBe(false)
    expect(bannerRows(m).every((r) => r.reason.length > 0)).toBe(true)
    expect(m.reasonFor('llm')).toBeTruthy()
  })

  it('pi 的两层能力：SDK 可用但模型不可用 → 仍要给出模型原因（T-AGENT 约定）', () => {
    const m = normalizeCapabilities({
      providers: { llm: [{ id: 'amr', available: false, reason: '403 需要订阅' }] },
      pi: { available: true, version: '1.2.0', degraded: true, model: { configured: true, available: false, reason: '403 需要订阅', resetAt: '2026-10-15T00:00:00Z' } },
    })
    expect(m.isAvailable('pi')).toBe(true)                  // SDK 层可用（页面可进）
    expect(m.isAvailable('llm')).toBe(false)                // 模型层不可用（输入框禁用 + 显示原因）
    expect(m.reasonFor('llm')).toContain('403')
  })
})
