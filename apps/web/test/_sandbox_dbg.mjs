import { DATASETS, SandboxDb } from 'file:///D:/temp%E4%B8%B4%E6%97%B6%E8%84%9A%E6%9C%AC/26-10-13%20%E6%95%B0%E6%8D%AE%E5%BA%93%E6%95%B0%E6%8D%AE%E4%BB%93%E5%BA%93%E8%AF%BE%E7%A8%8B%E4%BC%98%E5%8C%96/course-kb/apps/web/test/sandbox-mock.mjs'
const db = new SandboxDb(DATASETS[0].schema, DATASETS[0].seed)
console.log(JSON.stringify(db.execute("SELECT sc.sno FROM sc JOIN student s ON sc.sno = '2021001'")))
console.log('debug:', JSON.stringify(db.lastDebug))
console.log(JSON.stringify(db.execute('SELECT sc.sno FROM sc JOIN student s ON sc.sno = s.sno')))
console.log('debug2:', JSON.stringify(db.lastDebug))
