import { describe, expect, it } from 'vitest'
import { buildNameIndex, fmtBytes, fmtMs, fmtSpan, isIdentifier, linkify, nameKey } from '../../src/utils/text'

const card = (id: string, name: string, kind = 'concept') => ({ id, name, kind } as any)

describe('text / 元数据格式化（页码/时间码是视觉主角，格式必须稳定）', () => {
  it('fmtMs：mm:ss，超过一小时才带小时段', () => {
    expect(fmtMs(0)).toBe('00:00')
    expect(fmtMs(7_500)).toBe('00:07')
    expect(fmtMs(754_000)).toBe('12:34')
    expect(fmtMs(3_661_000)).toBe('01:01:01')
    expect(fmtMs(null)).toBe('00:00')                  // 0 值兜底：不出现 NaN
    expect(fmtMs(undefined)).toBe('00:00')
  })

  it('fmtSpan：按 kind 给单位（p1040 / p1040–1042 / 时间）', () => {
    expect(fmtSpan({ kind: 'page', start: 1040, end: 1040 })).toBe('p1040')
    expect(fmtSpan({ kind: 'page', start: 1040, end: 1042 })).toBe('p1040–1042')
    expect(fmtSpan({ kind: 'time', start: 12_000, end: 13_000 })).toContain('00:12')
    expect(fmtSpan({ kind: 'slide', start: 7, end: 7 })).toContain('7')
    expect(fmtSpan(null)).toBe('')                     // 无 span → 空串（调用方自己给兜底文案）
  })

  it('fmtBytes', () => {
    expect(fmtBytes(1024)).toBe('1.0 KB')
    expect(fmtBytes(0)).toBe('—')
  })
})

describe('text / 标识符与噪声（坑 6：mention 假阳性）', () => {
  it('isIdentifier：含中文/括号/点等"非纯英文"特征 → 走子串精确匹配', () => {
    expect(isIdentifier('创建数据库(CREATE DATABASE)')).toBe(true)
    expect(isIdentifier('mysql.ini')).toBe(true)
    expect(isIdentifier('索引')).toBe(true)
    expect(isIdentifier('CREATE DATABASE')).toBe(false)   // 纯英文 → 需要走噪声过滤 + 词边界
  })

  it('nameKey：trim + 小写 + 空白折叠（不做其它改写，保证与后端 name_key 同口径）', () => {
    expect(nameKey('  USE  ')).toBe('use')
    expect(nameKey('Show   Tables')).toBe('show tables')
    expect(nameKey(null)).toBe('')
  })
})

describe('text / linkify（正文内链）', () => {
  const cards = [card('c1', 'CREATE DATABASE'), card('c2', 'USE'), card('c3', 'InnoDB'), card('c4', 'SHOW DATABASES')]
  const index = buildNameIndex(cards)

  it('把卡片名换成可跳转内链', () => {
    const html = linkify('You can CREATE DATABASE my_db; then check InnoDB.', { index })
    expect(html).toContain('class="inner"')
    expect(html).toContain('#card-c1')
    expect(html).toContain('InnoDB')
  })

  it('通用词（USE）不建内链 —— 坑 6 的假阳性过滤', () => {
    const html = linkify('USE my_db;', { index })
    expect(html).not.toContain('#card-c2')
  })

  it('自身名字不自我链接 —— 坑 7', () => {
    const html = linkify('InnoDB storage engine', { index, selfId: 'c3', selfName: 'InnoDB' })
    expect(html).not.toContain('#card-c3')
  })

  it('转义 HTML（模型输出不可信）', () => {
    const html = linkify('<script>alert(1)</script> & "q"', { index })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
  })

  it('最长优先：SHOW DATABASES 不会被拆成 SHOW + DATABASES', () => {
    const html = linkify('run SHOW DATABASES now', { index })
    expect(html).toContain('#card-c4')
    expect(html.match(/class="inner"/g)!.length).toBe(1)
  })

  it('没有 index 时只做转义，不报错', () => {
    expect(linkify('plain text')).toBe('plain text')
    expect(linkify(undefined)).toBe('')
  })

  it('buildNameIndex：同名卡片归到一起（多义词要能全列出来）', () => {
    const idx = buildNameIndex([card('c1', 'Index'), card('c5', 'Index'), card('c6', '索引')])
    expect(idx.byKey.get('index')).toBe('c1')            // 首个作为默认跳转目标
    expect(idx.list.length).toBe(3)
    expect(idx.display.get('index')).toBe('Index')
  })
})
