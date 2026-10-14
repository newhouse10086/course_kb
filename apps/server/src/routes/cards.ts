/** 卡片与交叉引用路由（契约 §5.3）。 */

import type { FastifyInstance } from 'fastify';

import type { AppDeps } from '../app-deps.ts';
import { notFound } from '../store/errors.ts';
import { sendError } from './util.ts';

export function registerCardRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { repo } = deps;

  /** 单卡片：含 `unit` / `source` / `xrefs` / `backlinks`（契约 §5.3）。 */
  app.get('/api/v1/cards/:id', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const card = repo.getCardRow(id);
      if (!card) throw notFound('卡片', id);
      const unit = repo.getUnitRow(card.unit_id);
      const doc = repo.getDocumentRow(card.doc_id);

      const span = { kind: card.span_kind, start: card.span_start, end: card.span_end };
      const page = card.span_kind === 'page' ? card.span_start : 0;
      const source = {
        kind: doc?.kind ?? '',
        file: doc ? `${card.doc_id}/${doc.source_path.split('/').pop() ?? 'original'}` : '',
        page,
        url: `/api/v1/documents/${card.doc_id}/file${page ? `#page=${page}` : ''}`,
      };

      return reply.send({
        card: repo.getCard(id),
        unit: unit ? { id: unit.id, title: unit.title } : null,
        source,
        xrefs: repo.cardXrefs(id),
        backlinks: repo.cardBacklinks(id),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/v1/cards/:id/xrefs', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      if (!repo.getCardRow(id)) throw notFound('卡片', id);
      return reply.send({ card_id: id, xrefs: repo.cardXrefs(id) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** 入链 —— wiki 的精髓（契约 §5.3）。 */
  app.get('/api/v1/cards/:id/backlinks', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      if (!repo.getCardRow(id)) throw notFound('卡片', id);
      return reply.send({ card_id: id, backlinks: repo.cardBacklinks(id) });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
