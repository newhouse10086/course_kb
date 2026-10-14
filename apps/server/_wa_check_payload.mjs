import { loadConfig } from './src/config.ts';
import { Db } from './src/store/db.ts';
import { Repo } from './src/store/repo.ts';
import { buildTree, bottomUpOrder, childPayloads } from './src/tasks/rollup.ts';

const cfg = loadConfig();
const db = Db.open(cfg.dbPath);
const repo = new Repo(db);
const docRow = repo.listDocuments({ limit: 1 }).documents[0];
const docId = docRow.id;
const units = repo.allUnitRows(docId);
const nodes = buildTree(units);
const cardCounts = repo.cardCountsByUnit(docId);
const meta = JSON.parse(repo.getDocumentRow(docId).meta_json ?? '{}');
const sources = { manualIntros: meta.manual_intros ?? {}, sections: meta.section_summaries ?? {}, rollup: meta.rollup ?? {} };
const order = bottomUpOrder(nodes);
const byDepth = new Map();
for (const n of order) {
  const l = byDepth.get(n.depth) ?? [];
  l.push(n);
  byDepth.set(n.depth, l);
}
console.log('layers:', [...byDepth.keys()].sort((a,b)=>b-a));
for (const d of [...byDepth.keys()].sort((a,b)=>b-a)) {
  const layer = byDepth.get(d);
  const planNodes = layer.map((n) => ({
    id: n.unit.id, title: n.unit.title, level: n.unit.level,
    self_intro: (n.unit.text ?? '').slice(0, 800),
    children: childPayloads(n, nodes, cardCounts, sources),
  }));
  const json = JSON.stringify({ nodes: planNodes });
  console.log(`depth=${d} nodes=${layer.length} payloadBytes=${json.length} (${(json.length/1024).toFixed(1)} KB)`);
}
db.close();
