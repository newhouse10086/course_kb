/**
 * 检索路由（契约 §5.4 + 坑 15 的对比证明）。
 *
 * | 方法 | 路径 |
 * |---|---|
 * | GET | `/api/v1/search?q=索引&doc_id=&limit=` |
 * | GET | `/api/v1/search/suggest?q=` |
 * | GET | `/api/v1/search/contrast?q=&doc_id=` ← **bigram 必要性证明**（v1 同款接口，附加非破坏） |
 */

import type { FastifyInstance } from 'fastify';

import type { AppDeps } from '../app-deps.ts';
import { contrast, search, suggest } from '../store/search.ts';
import { intParam, pageParams, sendError, strParam } from './util.ts';

export function registerSearchRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { repo, db } = deps;

  app.get('/api/v1/search', async (req, reply) => {
    try {
      const q = (req.query ?? {}) as Record<string, unknown>;
      const query = strParam(q.q) ?? '';
      const { offset, limit } = pageParams(q, 20);
      const out = search(db, repo, query, {
        ...(strParam(q.doc_id) ? { docId: strParam(q.doc_id) as string } : {}),
        limit,
        offset,
      });
      return reply.send({ ...out, offset, limit });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/v1/search/suggest', async (req, reply) => {
    try {
      const q = (req.query ?? {}) as Record<string, unknown>;
      const query = strParam(q.q) ?? '';
      const limit = intParam(q.limit, 10, { min: 1, max: 50 });
      return reply.send({ q: query, suggestions: suggest(db, query, { limit }) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * ★ 坑 15 的可复现对照：**同一批正文、同一个词**，bigram 与 unicode61 的命中数一起返回。
   * 只报"bigram 有结果"证明不了 tokenizer 的问题；两个数**必须一起看**。
   */
  app.get('/api/v1/search/contrast', async (req, reply) => {
    try {
      const q = (req.query ?? {}) as Record<string, unknown>;
      const query = strParam(q.q) ?? '';
      if (!query) return reply.send({ q: '', bigram_hits: 0, unicode61_hits: 0, texts_compared: 0, conclusion: '缺少查询词 q' });
      return reply.send(
        contrast(db, repo, query, { ...(strParam(q.doc_id) ? { docId: strParam(q.doc_id) as string } : {}) }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
