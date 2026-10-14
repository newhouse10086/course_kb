import { loadConfig } from './src/config.ts';
import { Db } from './src/store/db.ts';
import { Repo } from './src/store/repo.ts';
import { buildTree, internalNodes } from './src/tasks/rollup.ts';

const cfg = loadConfig();
const db = Db.open(cfg.dbPath);
const repo = new Repo(db);
const docRow = repo.listDocuments({ limit: 1 }).documents[0];
const nodes = buildTree(repo.allUnitRows(docRow.id));
const kids = internalNodes(nodes).map((n) => n.children.length);
kids.sort((a, b) => b - a);
console.log('internal nodes:', kids.length);
console.log('max children:', kids[0], '| top10:', kids.slice(0, 10).join(','));
console.log('children>20:', kids.filter((k) => k > 20).length, '| >60:', kids.filter((k) => k > 60).length);
db.close();
