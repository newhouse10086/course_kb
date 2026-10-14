// 临时自检：mock 沙箱 SQL 引擎（跑完即删）
import { DATASETS, SandboxDb } from 'file:///D:/temp%E4%B8%B4%E6%97%B6%E8%84%9A%E6%9C%AC/26-10-13%20%E6%95%B0%E6%8D%AE%E5%BA%93%E6%95%B0%E6%8D%AE%E4%BB%93%E5%BA%93%E8%AF%BE%E7%A8%8B%E4%BC%98%E5%8C%96/course-kb/apps/web/test/sandbox-mock.mjs'

const ds = DATASETS[0]
const db = new SandboxDb(ds.schema, ds.seed)
const show = (label, fn) => {
  try {
    const r = fn()
    console.log(label, JSON.stringify(r))
  } catch (e) {
    console.log(label, 'THREW', e.code, e.message)
  }
}
console.log('tables:', JSON.stringify(db.snapshot()))
show('select: ', () => db.execute('SELECT sno, sname, sdept FROM student WHERE sage >= 20 ORDER BY sno LIMIT 3'))
show('join: ', () => db.execute('SELECT s.sname, c.cname, sc.grade FROM sc JOIN student s ON sc.sno = s.sno JOIN course c ON sc.cno = c.cno WHERE sc.grade > 80'))
show('agg: ', () => db.execute('SELECT sdept, COUNT(*) AS n FROM student GROUP BY sdept'))
show('insert: ', () => db.execute("INSERT INTO student (sno,sname,ssex,sage,sdept) VALUES ('2021006','测试','男',20,'计算机系')"))
show('update: ', () => db.execute("UPDATE student SET sage = 21 WHERE sno = '2021006'"))
show('delete: ', () => db.execute("DELETE FROM student WHERE sno = '2021006'"))
show('like: ', () => db.execute("SELECT sname FROM student WHERE sname LIKE '%张%'"))
show('attach: ', () => db.execute("ATTACH DATABASE 'x.db' AS x"))
show('pragma: ', () => db.execute('PRAGMA writable_schema = ON'))
show('multi: ', () => db.execute('SELECT 1; DROP TABLE student'))
show('badtable:', () => db.execute('SELECT * FROM nosuch'))
show('timeout: ', () => db.execute('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT * FROM c'))
show('truncate:', () => db.execute('SELECT * FROM student', { maxRows: 2 }))
console.log('rows now:', db.tables.get('student').rows.length)
console.log('reset:', JSON.stringify(db.reset(ds.schema, ds.seed)), 'rows:', db.tables.get('student').rows.length)
