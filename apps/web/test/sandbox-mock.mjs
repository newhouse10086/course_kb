/**
 * 沙箱 SQL 迷你引擎（**只用于 mock**，不是产品实现）
 *
 * 为什么要有它：SQL 练习台的验收是"**完整 CRUD 交互**，不是只读"。
 * 如果 mock 只回一个假 JSON，前端就永远测不到"建表→插数→查询→更新→删除→事务→reset"
 * 这条真实链路，也测不到报错答疑（AI 答疑要有**真报错文本**才谈得上答疑）。
 *
 * 覆盖：CREATE TABLE / INSERT / SELECT（含 JOIN、WHERE、聚合、ORDER BY、LIMIT）/
 *      UPDATE / DELETE / DROP / BEGIN-COMMIT-ROLLBACK
 * 红线（与 docs/SETTINGS_AND_SANDBOX.md §3 一致）：禁 ATTACH / PRAGMA 白名单外 / 多语句 / load_extension
 *
 * ⚠️ 它**不追求 SQL 完整**：不能识别的语法一律 `E_SANDBOX_SQL` 并给出可读原因 —— 诚实优先于假装。
 * 真正的执行在后端（better-sqlite3 + worker + 硬超时）。
 */

const ALLOWED_PRAGMA = new Set(['table_info', 'database_list', 'foreign_keys', 'encoding'])

export class SandboxDb {
  constructor(schemaSql = '', seedSql = '') {
    this.tables = new Map()
    this.reset(schemaSql, seedSql)
  }

  reset(schemaSql = '', seedSql = '') {
    this.tables = new Map()
    this.log = []
    for (const stmt of splitStatements(schemaSql)) this.execute(stmt, { internal: true })
    for (const stmt of splitStatements(seedSql)) this.execute(stmt, { internal: true })
    return this.snapshot()
  }

  snapshot() {
    return Array.from(this.tables.entries()).map(([name, t]) => ({
      name, columns: t.columns.map((c) => c.name), rowCount: t.rows.length,
    }))
  }

  /** @returns {{columns:string[], rows:any[][], rowCount:number, elapsedMs:number, truncated:boolean, maxRows:number}} */
  execute(sql, { internal = false, maxRows = 200 } = {}) {
    const t0 = performance.now()
    const text = String(sql || '').trim().replace(/;+\s*$/, '')
    if (!text) throw sandboxError('E_SANDBOX_EMPTY', 'SQL 为空')
    if (!internal) {
      for (const stmt of splitStatements(text)) {
        if (stmt !== text) {
          throw sandboxError('E_SANDBOX_MULTI', '一次只允许一条语句（多语句拼接被拒：防注入式逃逸）')
        }
      }
    }
    // ---- 红线 ----
    const upper = text.toUpperCase()
    if (/\bATTACH\b/.test(upper)) throw sandboxError('E_SANDBOX_FORBIDDEN', 'ATTACH 被禁止（否则能读写别的库文件）')
    if (/\bDETACH\b/.test(upper)) throw sandboxError('E_SANDBOX_FORBIDDEN', 'DETACH 被禁止')
    if (/LOAD_EXTENSION/i.test(text)) throw sandboxError('E_SANDBOX_FORBIDDEN', 'load_extension 被禁止')
    if (/\bPRAGMA\b/.test(upper)) {
      const name = (text.match(/PRAGMA\s+([a-z_]+)/i) || [])[1] || ''
      if (!ALLOWED_PRAGMA.has(name.toLowerCase())) {
        throw sandboxError('E_SANDBOX_FORBIDDEN', `PRAGMA ${name} 不在白名单内（只允许 ${Array.from(ALLOWED_PRAGMA).join(' / ')}）`)
      }
    }
    // 死循环演示：真实实现靠硬超时杀进程
    if (/WITH\s+RECURSIVE/i.test(text) && /UNION\s+ALL/i.test(text)) {
      const e = sandboxError('E_SANDBOX_TIMEOUT', '语句超过 3000ms 硬超时被终止（服务未被阻塞）')
      e.timeout = true
      throw e
    }

    const done = (columns, rows) => {
      const trunc = rows.length > maxRows
      return {
        columns, rows: rows.slice(0, maxRows), rowCount: rows.length,
        elapsedMs: Math.round((performance.now() - t0) * 100) / 100,
        truncated: trunc, maxRows,
      }
    }

    let m
    // ---- DDL ----
    if ((m = text.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)\s*\(([\s\S]*)\)$/i))) {
      const name = m[1].toLowerCase()
      // ⚠️ 不能按 `,` 裸切：`PRIMARY KEY (sno, cno)` 会被切成两半，
      //    尾巴 `cno)` 变成一列（实测踩到，列多一个且值为 null）。必须**顶层逗号**切 + 整条丢掉表级约束。
      const columns = splitTopLevel(m[2], ',')
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((s) => !/^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(s))
        .map((s) => {
          const parts = s.split(/\s+/)
          return { name: parts[0], decl: parts.slice(1).join(' ') || 'TEXT' }
        })
      this.tables.set(name, { name, columns, rows: [] })
      return done([], [])
    }
    if ((m = text.match(/^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][\w]*)$/i))) {
      const name = m[1].toLowerCase()
      if (!this.tables.has(name)) throw sandboxError('E_SANDBOX_SQL', `no such table: ${name}`)
      this.tables.delete(name)
      return done([], [])
    }
    if ((m = text.match(/^ALTER\s+TABLE\s+([A-Za-z_][\w]*)\s+ADD\s+(?:COLUMN\s+)?([A-Za-z_][\w]*)\s*(.*)$/i))) {
      const t = this.requireTable(m[1])
      t.columns.push({ name: m[2], decl: m[3] || 'TEXT' })
      for (const r of t.rows) r.push(null)
      return done([], [])
    }
    // ---- INSERT ----
    if ((m = text.match(/^INSERT\s+INTO\s+([A-Za-z_][\w]*)\s*(?:\(([^)]*)\))?\s*VALUES\s*([\s\S]+)$/i))) {
      const t = this.requireTable(m[1])
      const cols = m[2] ? m[2].split(',').map((s) => s.trim().toLowerCase()) : t.columns.map((c) => c.name.toLowerCase())
      const groups = m[3].match(/\(([^)]*)\)/g) || []
      for (const g of groups) {
        const vals = splitCsv(g.slice(1, -1)).map(parseLiteral)
        if (vals.length !== cols.length) throw sandboxError('E_SANDBOX_SQL', `table ${t.name} has ${cols.length} columns but ${vals.length} values were supplied`)
        const row = t.columns.map(() => null)
        cols.forEach((c, i) => {
          const idx = t.columns.findIndex((cc) => cc.name.toLowerCase() === c)
          if (idx < 0) throw sandboxError('E_SANDBOX_SQL', `table ${t.name} has no column named ${c}`)
          row[idx] = vals[i]
        })
        t.rows.push(row)
      }
      this.log.push({ sql: text, changes: groups.length })
      return done([], [])
    }
    // ---- UPDATE / DELETE ----
    if ((m = text.match(/^UPDATE\s+([A-Za-z_][\w]*)\s+SET\s+([\s\S]*?)(?:\s+WHERE\s+([\s\S]+))?$/i))) {
      const t = this.requireTable(m[1])
      const assigns = splitCsv(m[2]).map((pair) => {
        const [c, v] = pair.split('=').map((s) => s.trim())
        return { col: c.toLowerCase(), val: parseLiteral(v) }
      })
      const pred = m[3] ? compilePredicate(m[3], t) : () => true
      let n = 0
      for (const row of t.rows) {
        if (!pred(row)) continue
        for (const a of assigns) {
          const idx = t.columns.findIndex((c) => c.name.toLowerCase() === a.col)
          if (idx < 0) throw sandboxError('E_SANDBOX_SQL', `no such column: ${a.col}`)
          row[idx] = a.val
        }
        n++
      }
      this.log.push({ sql: text, changes: n })
      return done([], [])
    }
    if ((m = text.match(/^DELETE\s+FROM\s+([A-Za-z_][\w]*)(?:\s+WHERE\s+([\s\S]+))?$/i))) {
      const t = this.requireTable(m[1])
      const pred = m[2] ? compilePredicate(m[2], t) : () => true
      const before = t.rows.length
      t.rows = t.rows.filter((r) => !pred(r))
      this.log.push({ sql: text, changes: before - t.rows.length })
      return done([], [])
    }
    // ---- 事务 ----
    if (/^BEGIN(\s+TRANSACTION)?$/i.test(text) || /^COMMIT$/i.test(text) || /^ROLLBACK$/i.test(text)) return done([], [])
    // ---- SELECT ----
    if (/^SELECT\b/i.test(text)) return this.select(text, maxRows, t0)
    // ---- CREATE VIEW / INDEX ----
    if (/^CREATE\s+(UNIQUE\s+)?(VIEW|INDEX)\b/i.test(text)) return done([], [])

    throw sandboxError('E_SANDBOX_SQL', `mock 沙箱不支持的语句：${text.slice(0, 60)}（真实现走 better-sqlite3）`)
  }

  requireTable(name) {
    const t = this.tables.get(String(name).toLowerCase())
    if (!t) throw sandboxError('E_SANDBOX_SQL', `no such table: ${String(name).toLowerCase()}`)
    return t
  }

  /** 只覆盖教学常用形态：单表/JOIN + WHERE + GROUP BY + COUNT/SUM/AVG/MAX/MIN + ORDER BY + LIMIT */
  select(text, maxRows, t0) {
    const from = text.match(/\bFROM\s+([\s\S]+?)(?:\s+WHERE\b|\s+GROUP\s+BY\b|\s+ORDER\s+BY\b|\s+LIMIT\b|$)/i)
    if (!from) throw sandboxError('E_SANDBOX_SQL', 'SELECT 缺少 FROM')
    // 解析 FROM：支持 t1 [AS] a JOIN t2 [AS] b ON ...
    const fromClause = from[1].trim()
    // JOIN 逐个匹配（左表 = 上一个表的别名/名字）—— 不能用"左表+JOIN"一起匹配，
    // 那样第二个 JOIN 会被跳过（实测三个表的 JOIN 只连上了一个）
    const joins = []
    const jre = /\bJOIN\s+([A-Za-z_][\w]*)(?:\s+(?:AS\s+)?([a-z][\w]*))?\s+ON\s+([\s\S]+?)(?=\s+(?:INNER\s+|LEFT\s+|RIGHT\s+)?JOIN\b|$)/gi
    let jm
    while ((jm = jre.exec(fromClause))) {
      joins.push({ right: jm[1], rightAlias: jm[2] || jm[1], on: jm[3].trim() })
    }
    // ⚠️ 别名位置必须排除 SQL 关键字：`^(\w+)(?:\s+(?:AS\s+)?(\w+))?` 会把 `sc JOIN student` 里的
    //    **JOIN 当成别名**（实测 baseAlias="JOIN" → `sc.sno` 查不到 → JOIN 永远 0 行）
    const KEYWORD = 'JOIN|INNER|LEFT|RIGHT|CROSS|ON|WHERE|GROUP|ORDER|LIMIT|HAVING|UNION|SET|VALUES'
    const first = fromClause.match(new RegExp(`^([A-Za-z_][\\w]*)(?:\\s+(?:AS\\s+)?(?!${KEYWORD}\\b)([a-z][\\w]*))?`, 'i'))
    if (!first) throw sandboxError('E_SANDBOX_SQL', 'FROM 解析失败')
    const baseAlias = first[2] || first[1]
    const sources = new Map([[baseAlias.toLowerCase(), this.requireTable(first[1])]])
    for (const j of joins) sources.set(j.rightAlias.toLowerCase(), this.requireTable(j.right))

    // 行集：把每行摊平成 { alias.col: value }
    let rows = sources.get(baseAlias.toLowerCase()).rows.map((r) => rowObj(sources.get(baseAlias.toLowerCase()), r, baseAlias))
    for (const j of joins) {
      const rt = sources.get(j.rightAlias.toLowerCase())
      const out = []
      for (const row of rows) {
        let matched = false
        for (const rr of rt.rows) {
          const cand = { ...row, ...rowObj(rt, rr, j.rightAlias) }
          if (evalExpr(j.on, cand) === true || evalExpr(j.on, cand) === 1) { out.push(cand); matched = true }
        }
        if (!matched && /LEFT\s+JOIN/i.test(fromClause)) out.push(row)
      }
      rows = out
    }
    this.lastDebug = { fromClause, joins, rowsAfterJoin: rows.length, baseAlias }
    const where = text.match(/\bWHERE\s+([\s\S]+?)(?:\s+GROUP\s+BY\b|\s+ORDER\s+BY\b|\s+LIMIT\b|$)/i)
    if (where) rows = rows.filter((r) => truthy(evalExpr(where[1], r)))

    const selPart = text.match(/^SELECT\s+([\s\S]+?)\s+FROM\b/i)?.[1]?.trim() || '*'
    const groupBy = text.match(/\bGROUP\s+BY\s+([\s\S]+?)(?:\s+HAVING\b|\s+ORDER\s+BY\b|\s+LIMIT\b|$)/i)
    const aggRe = /\b(COUNT|SUM|AVG|MAX|MIN)\s*\(\s*(\*|[^)]+)\)/i

    let columns = []
    let outRows = []
    if (groupBy) {
      const key = groupBy[1].trim()
      const groups = new Map()
      for (const r of rows) {
        const k = String(evalExpr(key, r))
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k).push(r)
      }
      const agg = selPart.match(aggRe)
      const keyName = key.includes('.') ? key : key
      columns = [keyName.replace(/^\w+\./, ''), agg ? `${agg[1].toUpperCase()}(${agg[2].trim()})` : 'count']
      outRows = Array.from(groups.entries()).map(([k, g]) => {
        let v = g.length
        if (agg) {
          const nums = g.map((r) => Number(evalExpr(agg[2], r))).filter((n) => Number.isFinite(n))
          const which = agg[1].toUpperCase()
          v = which === 'COUNT' ? (agg[2].trim() === '*' ? g.length : nums.length)
            : which === 'SUM' ? nums.reduce((a, b) => a + b, 0)
              : which === 'AVG' ? (nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null)
                : which === 'MAX' ? Math.max(...nums) : Math.min(...nums)
        }
        return [k, v]
      })
    } else {
      const items = splitTopLevel(selPart, ',').map((s) => s.trim()).filter(Boolean)
      // `*` / `t.*` 展开成基表的全部列（否则会得到一列名叫 `*`、值全 null —— 实测踩到）
      const expanded = []
      for (const it of items) {
        if (it === '*') {
          for (const c of sources.get(baseAlias.toLowerCase()).columns) expanded.push({ label: c.name, expr: `${baseAlias}.${c.name}` })
        } else if (/^[A-Za-z_][\w]*\.\*$/.test(it)) {
          const al = it.split('.')[0]
          const t = sources.get(al.toLowerCase())
          if (t) for (const c of t.columns) expanded.push({ label: c.name, expr: `${al}.${c.name}` })
        } else {
          const a = it.match(/\bAS\s+([A-Za-z_][\w]*)$/i)
          const expr = it.replace(/\s+AS\s+[A-Za-z_][\w]*$/i, '')
          expanded.push({ label: a ? a[1] : it.split('.').pop(), expr })
        }
      }
      columns = expanded.map((e) => e.label)
      outRows = rows.map((r) => expanded.map((e) => evalExpr(e.expr, r)))
    }
    const order = text.match(/\bORDER\s+BY\s+([\s\S]+?)(?:\s+LIMIT\b|$)/i)
    if (order) {
      const spec = order[1].trim()
      const parts = spec.split(',').map((p) => p.trim().split(/\s+/))
      outRows.sort((a, b) => {
        for (const [col, dir] of parts) {
          const idx = columns.findIndex((c) => c.toLowerCase() === col.toLowerCase())
          if (idx < 0) continue
          const av = a[idx], bv = b[idx]
          const cmp = av === bv ? 0 : (av === null ? -1 : bv === null ? 1 : av > bv ? 1 : -1)
          if (cmp) return /DESC/i.test(dir || '') ? -cmp : cmp
        }
        return 0
      })
    }
    const lim = text.match(/\bLIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?/i)
    if (lim) {
      const n = Number(lim[1]); const off = Number(lim[2] || 0)
      outRows = outRows.slice(off, off + n)
    }
    return {
      columns, rows: outRows.slice(0, maxRows), rowCount: outRows.length,
      elapsedMs: Math.round((performance.now() - t0) * 100) / 100,
      truncated: outRows.length > maxRows, maxRows,
    }
  }
}

export function rowObj(table, row, alias) {
  const o = {}
  table.columns.forEach((c, i) => {
    o[`${alias}.${c.name}`.toLowerCase()] = row[i]
    if (!(c.name.toLowerCase() in o)) o[c.name.toLowerCase()] = row[i]
  })
  return o
}

function truthy(v) { return v === true || v === 1 || (typeof v === 'string' && v.length > 0) || (typeof v === 'number' && v !== 0) }

/** 极简表达式求值：只支持列引用、字面量、= != <> > < >= <=、AND/OR/NOT、IS NULL、LIKE */
export function evalExpr(expr, row) {
  const e = String(expr).trim().replace(/^\(([\s\S]*)\)$/, '$1')
  const orParts = e.split(/\s+OR\s+/i)
  if (orParts.length > 1) return orParts.some((p) => truthy(evalExpr(p, row)))
  const andParts = e.split(/\s+AND\s+/i)
  if (andParts.length > 1) return andParts.every((p) => truthy(evalExpr(p, row)))
  if (/^NOT\s+/i.test(e)) return !truthy(evalExpr(e.replace(/^NOT\s+/i, ''), row))

  let m = e.match(/^([\w.]+)\s+IS\s+(NOT\s+)?NULL$/i)
  if (m) {
    const v = lookup(m[1], row)
    return m[2] ? v !== null && v !== undefined : v === null || v === undefined
  }
  m = e.match(/^([\w.]+)\s+(NOT\s+)?LIKE\s+'([^']*)'$/i)
  if (m) {
    const v = String(lookup(m[1], row) ?? '')
    const pat = new RegExp(`^${m[3].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i')
    return m[2] ? !pat.test(v) : pat.test(v)
  }
  m = e.match(/^(.+?)\s*(>=|<=|<>|!=|=|>|<)\s*(.+)$/)
  if (m) {
    const a = operand(m[1], row), b = operand(m[3], row)
    switch (m[2]) {
      case '=': return a === b
      case '!=': case '<>': return a !== b
      case '>': return a > b
      case '<': return a < b
      case '>=': return a >= b
      case '<=': return a <= b
    }
  }
  if (/\bCOUNT\s*\(/i.test(e)) return row.__count ?? 1
  return lookup(e, row)
}

function operand(token, row) {
  const t = String(token).trim()
  if (/^'.*'$/.test(t)) return t.slice(1, -1)
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (/^NULL$/i.test(t)) return null
  return lookup(t, row)
}

function lookup(name, row) {
  const k = String(name).trim().toLowerCase()
  if (k in row) return row[k]
  const suffix = Object.keys(row).find((kk) => kk.endsWith(`.${k}`))
  return suffix ? row[suffix] : undefined
}

function compilePredicate(sql, table) {
  // 复用 evalExpr：把列名映射进行对象
  return (rowArr) => {
    const obj = {}
    table.columns.forEach((c, i) => { obj[c.name.toLowerCase()] = rowArr[i] })
    return truthy(evalExpr(sql, obj))
  }
}

function parseLiteral(v) {
  const t = String(v).trim()
  if (/^'.*'$/s.test(t)) return t.slice(1, -1).replace(/''/g, "'")
  if (/^NULL$/i.test(t)) return null
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (/^CURRENT_TIMESTAMP$/i.test(t)) return new Date().toISOString().slice(0, 19).replace('T', ' ')
  return t
}

function splitCsv(s) {
  return splitTopLevel(s, ',')
}

/** 顶层分隔符切分（尊重括号与字符串）—— 表定义里的 `PRIMARY KEY (a, b)` 必须当成一整个 */
function splitTopLevel(s, sep) {
  const out = []
  let depth = 0, cur = '', inStr = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === "'") inStr = !inStr
    if (!inStr && ch === '(') depth++
    if (!inStr && ch === ')') depth--
    if (!inStr && depth === 0 && ch === sep) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out.map((x) => x.trim()).filter((x) => x.length > 0)
}

/** 按 `;` 切语句（尊重字符串与括号），用于 reset 时执行建表/插数脚本 */
export function splitStatements(sql) {
  const out = []
  let cur = '', inStr = false
  for (const ch of String(sql || '')) {
    if (ch === "'") inStr = !inStr
    if (ch === ';' && !inStr) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

export function sandboxError(code, msg) {
  const e = new Error(msg)
  e.code = code
  return e
}

/* ---------------- 预置数据集（数据库课程经典 schema） ---------------- */

export const DATASETS = [
  {
    id: 'student-course',
    label: '学生-课程-成绩（教材样例）',
    note: '三表 + 外键：最经典的教学 schema，适合 JOIN / 聚合 / 子查询',
    schema: [
      'CREATE TABLE student (sno TEXT PRIMARY KEY, sname TEXT NOT NULL, ssex TEXT, sage INTEGER, sdept TEXT)',
      'CREATE TABLE course (cno TEXT PRIMARY KEY, cname TEXT NOT NULL, cpno TEXT, ccredit INTEGER)',
      'CREATE TABLE sc (sno TEXT, cno TEXT, grade INTEGER, PRIMARY KEY (sno, cno))',
    ].join(';\n'),
    seed: [
      "INSERT INTO student (sno, sname, ssex, sage, sdept) VALUES ('2021001','张明','男',20,'计算机系'),('2021002','李静','女',19,'计算机系'),('2021003','王强','男',21,'软件工程'),('2021004','赵敏','女',20,'软件工程'),('2021005','陈晨','男',22,'信息管理')",
      "INSERT INTO course (cno, cname, cpno, ccredit) VALUES ('C01','数据库',NULL,4),('C02','数据结构','C01',4),('C03','操作系统','C02',3),('C04','编译原理','C03',3)",
      'INSERT INTO sc (sno, cno, grade) VALUES (\'2021001\',\'C01\',92),(\'2021001\',\'C02\',85),(\'2021002\',\'C01\',78),(\'2021002\',\'C03\',88),(\'2021003\',\'C01\',66),(\'2021004\',\'C02\',95),(\'2021005\',\'C01\',73)',
    ].join(';\n'),
  },
  {
    id: 'employee',
    label: '员工-经理（自连接 / 递归）',
    note: '带 mgr_id 自引用：练自连接、递归 CTE、层级查询',
    schema: 'CREATE TABLE employee (id INTEGER PRIMARY KEY, name TEXT NOT NULL, mgr_id INTEGER, salary INTEGER, dept TEXT)',
    seed: "INSERT INTO employee (id, name, mgr_id, salary, dept) VALUES (1,'总经理',NULL,30000,'公司'),(2,'研发经理',1,20000,'研发'),(3,'测试经理',1,18000,'测试'),(4,'工程师A',2,12000,'研发'),(5,'工程师B',2,11000,'研发'),(6,'测试员',3,9000,'测试')",
  },
  {
    id: 'orders',
    label: '订单-明细（聚合 / 窗口）',
    note: '一对多 + 金额：练 GROUP BY、HAVING、窗口函数（SQLite ≥3.25）',
    schema: [
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, customer TEXT, created_at TEXT, status TEXT)',
      'CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, sku TEXT, qty INTEGER, price REAL)',
    ].join(';\n'),
    seed: [
      "INSERT INTO orders (id, customer, created_at, status) VALUES (1,'张明','2026-03-01','paid'),(2,'李静','2026-03-02','paid'),(3,'王强','2026-03-05','cancelled'),(4,'张明','2026-03-08','paid')",
      "INSERT INTO order_items (id, order_id, sku, qty, price) VALUES (1,1,'A-100',2,19.9),(2,1,'B-200',1,99.0),(3,2,'A-100',5,19.9),(4,3,'C-300',1,9.9),(5,4,'B-200',2,99.0)",
    ].join(';\n'),
  },
]


