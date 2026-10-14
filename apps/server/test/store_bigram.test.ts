/**
 * bigram 检索预处理（坑 15）—— **对照证明**。
 *
 * 断言的是**具体字符串/具体数字**，不是"非空"（AGENTS.md §7 质量门）。
 * 期望值逐字来自 v1 已验证的 `worker/tests/test_pipeline.py::test_to_bigram_exact_strings`。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { matchExpr, queryTerms, selftestBigram, toBigram } from '../src/store/bigram.ts';
import { contrastUnicode61, Db } from '../src/store/db.ts';

test('toBigram 精确字符串（与 v1 已验证算法逐字一致）', () => {
  assert.equal(toBigram('索引优化'), '索引 引优 优化');
  assert.equal(toBigram('B+tree index'), 'b+tree index');
  assert.equal(
    toBigram('聚簇索引将数据按主键顺序存放'),
    '聚簇 簇索 索引 引将 将数 数据 据按 按主 主键 键顺 顺序 序存 存放',
  );
  assert.equal(toBigram(''), '');
  // 单字保留，否则单字查询永不命中
  assert.equal(toBigram('库'), '库');
  // "与" 是单字 → 保留；"事务" → bigram
  assert.equal(toBigram('sql_mode 与 事务'), 'sql_mode 与 事务');
});

test('toBigram 去重但保序（重复 bigram 会让 bm25 偏斜）', () => {
  // 连续中文段按 2 字窗口滑动 → 跨"词"边界也会出 bigram（这是 bigram 的定义，不是 bug）
  assert.equal(toBigram('索引索引'), '索引 引索');
  assert.equal(toBigram('索引 引优'), '索引 引优', '已出现过的词项不重复出');
});

test('toBigram 大小写归一：英文转小写，中文不变', () => {
  assert.equal(toBigram('InnoDB Clustered INDEX'), 'innodb clustered index');
});

test('queryTerms / matchExpr 精确值', () => {
  assert.deepEqual(queryTerms('索引'), ['索引']);
  assert.deepEqual(queryTerms('索引优化'), ['索引', '引优', '优化']);
  assert.deepEqual(queryTerms('sql_mode'), ['sql_mode']);
  assert.deepEqual(queryTerms('   '), []);
  assert.equal(matchExpr('事务'), '"事务"');
  assert.equal(matchExpr('索引优化'), '"索引" AND "引优" AND "优化"');
  assert.equal(matchExpr(''), '');
  // FTS5 语法字符必须被引号保护，否则 MATCH 直接语法错
  assert.equal(matchExpr('B+tree'), '"b+tree"');
  assert.equal(matchExpr('a OR b'), '"a" AND "or" AND "b"');
});

test('selftestBigram 上报可被 /capabilities 引用', () => {
  const out = selftestBigram();
  assert.equal(out['索引优化'], '索引 引优 优化');
  assert.equal(out['B+tree index'], 'b+tree index');
  assert.deepEqual(out.terms_事务, ['事务']);
});

test('★ 坑 15 对照：同一批中文正文，bigram > 0 而 unicode61 == 0', () => {
  const text = '聚簇索引将数据按主键顺序存放';
  const db = Db.open(':memory:');
  try {
    // 真实场景：中文连续书写、无空格（若写成 "索引 " 有空格，unicode61 反而能命中 —— 那不算真实场景）
    db.ftsUpsert([
      {
        id: 'card:crd_1',
        doc_id: 'doc_1',
        ref_id: 'crd_1',
        kind: 'card',
        title: '聚簇索引',
        body_bi: toBigram(text),
      },
      {
        id: 'unit:unt_1',
        doc_id: 'doc_1',
        ref_id: 'unt_1',
        kind: 'unit',
        title: '索引',
        body_bi: toBigram(`${text}，二级索引需要回表。`),
      },
    ]);

    const expr = matchExpr('索引');
    assert.equal(expr, '"索引"');
    const bigramHits = db.ftsCount(expr);
    const unicode61Hits = contrastUnicode61('索引', [text, `${text}，二级索引需要回表。`]);

    // 两个数一起断言 —— 只报"bigram 有结果"证明不了 tokenizer 的问题
    assert.equal(bigramHits, 2, `bigram 应命中 2 条，实际 ${bigramHits}`);
    assert.equal(unicode61Hits, 0, `unicode61 对中文应 0 命中，实际 ${unicode61Hits}`);
    assert.ok(bigramHits > unicode61Hits, 'bigram 必须严格优于 unicode61');

    // 单字查询的**真实语义**（实测，别过度承诺）：
    // 单字只在源文本里"独立成段"时才被保留为词项（如 "与"），
    // 所以 '库' 查不到 '数据库'（后者切成 '数据 据库'）—— 这是 bigram 的固有边界，如实记录。
    assert.equal(toBigram('数据库'), '数据 据库');
    assert.equal(db.ftsCount(matchExpr('库')), 0, '单字查不到连续中文里的字，别假装能查到');
    assert.equal(toBigram('sql_mode 与 事务'), 'sql_mode 与 事务');
    assert.equal(db.ftsCount(matchExpr('与')), 0, '该文本里没有独立的 与');
    // 不存在的词 → 真的 0（不是"没实现"）
    assert.equal(db.ftsCount(matchExpr('根本不存在的词组')), 0);
  } finally {
    db.close();
  }
});

test('FTS5 external-content 同步：更新后旧词条必须消失（否则留脏索引）', () => {
  const db = Db.open(':memory:');
  try {
    const row = (body: string) => ({
      id: 'card:crd_1',
      doc_id: 'doc_1',
      ref_id: 'crd_1',
      kind: 'card',
      title: 't',
      body_bi: toBigram(body),
    });
    db.ftsUpsert([row('聚簇索引')]);
    assert.equal(db.ftsCount(matchExpr('索引')), 1);
    // 改写正文：原错误写法（只 UPDATE + INSERT 新行）会让「索引」仍命中
    db.ftsUpsert([row('事务隔离')]);
    assert.equal(db.ftsCount(matchExpr('索引')), 0, '旧 bigram 词条必须被 delete 指令清掉');
    assert.equal(db.ftsCount(matchExpr('事务')), 1);
    assert.deepEqual(db.ftsCounts(), { search_docs: 1, search_fts: 1 });

    // 删除整文档
    db.ftsDeleteDoc('doc_1');
    assert.deepEqual(db.ftsCounts(), { search_docs: 0, search_fts: 0 });
  } finally {
    db.close();
  }
});
