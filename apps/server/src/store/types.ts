/**
 * 契约类型（`docs/API_PROTOCOL.md` §2）—— 闭集枚举**逐字**来自契约，不许扩展。
 *
 * ⚠️ 用 union + `as const` 数组，**不用 `enum`**（AGENTS.md 坑 T2：Node strip-only TS 不支持 enum）。
 */

/** 契约 §2.2 `span.kind`。 */
export const SPAN_KINDS = ['page', 'slide', 'time', 'char'] as const;
export type SpanKind = (typeof SPAN_KINDS)[number];

export interface Span {
  kind: SpanKind;
  /** page/slide = 1-based 编号；time = 毫秒；char = 字符偏移。 */
  start: number;
  end: number;
}

/** 契约 §2.1 `kind` 枚举。 */
export const DOC_KINDS = ['pdf', 'pptx', 'docx', 'video', 'epub', 'web', 'text'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** 契约 §2.1 `status` 枚举。 */
export const DOC_STATUSES = ['uploading', 'parsing', 'extracting', 'ready', 'failed'] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

/** 契约 §2.6 `kind` 枚举。 */
export const TASK_KINDS = [
  'parse',
  'extract',
  'rollup',
  'translate',
  'asr',
  'slides',
  'mindmap',
  'index',
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** 契约 §2.6 `status` 枚举。 */
export const TASK_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 契约 §2.5 `rel` 枚举（**顺序即优先级**）。 */
export const XREF_RELS = ['typed', 'mention', 'also_in', 'same_unit'] as const;
export type XrefRel = (typeof XREF_RELS)[number];

/** SSE 事件名（契约 §6）。 */
export const SSE_EVENTS = ['progress', 'log', 'artifact', 'done', 'failed'] as const;
export type SseEventName = (typeof SSE_EVENTS)[number];

export function isSpanKind(v: string): v is SpanKind {
  return (SPAN_KINDS as readonly string[]).includes(v);
}

export function isDocKind(v: string): v is DocKind {
  return (DOC_KINDS as readonly string[]).includes(v);
}

/** 上传扩展名 → kind（契约 §4 已规划适配器）。 */
export const EXT_TO_KIND: Record<string, DocKind> = {
  '.pdf': 'pdf',
  '.pptx': 'pptx',
  '.ppt': 'pptx',
  '.docx': 'docx',
  '.doc': 'docx',
  '.epub': 'epub',
  '.html': 'web',
  '.htm': 'web',
  '.md': 'text',
  '.markdown': 'text',
  '.txt': 'text',
  '.mp4': 'video',
  '.mkv': 'video',
  '.mov': 'video',
  '.webm': 'video',
  '.avi': 'video',
  '.mp3': 'video',
  '.m4a': 'video',
  '.wav': 'video',
};

/** MIME 表（`/documents/{id}/file` 的 Content-Type；Range 请求也依赖它）。 */
export const KIND_TO_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  epub: 'application/epub+zip',
  web: 'text/html; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  video: 'video/mp4',
};

export function kindFromFilename(filename: string): DocKind | null {
  const idx = filename.lastIndexOf('.');
  if (idx < 0) return null;
  return EXT_TO_KIND[filename.slice(idx).toLowerCase()] ?? null;
}
