import { DATASETS, SandboxDb } from 'file:///D:/temp%E4%B8%B4%E6%97%B6%E8%84%9A%E6%9C%AC/26-10-13%20%E6%95%B0%E6%8D%AE%E5%BA%93%E6%95%B0%E6%8D%AE%E4%BB%93%E5%BA%93%E8%AF%BE%E7%A8%8B%E4%BC%98%E5%8C%96/course-kb/apps/web/test/sandbox-mock.mjs'
const ds = DATASETS[0]
const db = new SandboxDb(ds.schema, ds.seed)
const trySql = (sql) => {
  try { console.log(sql, '→', JSON.stringify(db.execute(sql))) } catch (e) { console.log(sql, '→ THREW', e.code, e.message) }
}
trySql('SELECT sc.sno FROM sc')
trySql('SELECT sc.sno FROM sc JOIN student s ON sc.sno = s.sno')
trySql("SELECT sc.sno FROM sc JOIN student s ON sc.sno = '2021001'")
trySql("SELECT sc.sno FROM sc WHERE sc.sno = '2021001'")
trySql('SELECT COUNT(*) AS n FROM sc')
