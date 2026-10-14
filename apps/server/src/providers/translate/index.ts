/**
 * Translate Provider —— 翻译
 *
 * 规格：[`docs/PROVIDERS.md`](../../../docs/PROVIDERS.md) §4
 *
 * ## ⚠️ 本项目**不是通用翻译**（这是关键，别做错）
 *
 * 来自 v1 实测的领域要求：
 *  1. **术语表必须注入** —— 不注入会把 `index` 译成"指标"、`view` 译成"看法"
 *  2. **标识符保留英文** —— `InnoDB`/`SELECT`/`sql_mode` 译了就**无法检索**
 *  3. **证据句不意译** —— 证据是**可核查的引用**，意译会失去可回溯性
 *  4. **实测领域特征**：414 个实体名中 **56% 译中文 / 44% 保留英文**（其中 71% 是标识符）
 *     → **这不是失败，是数据库领域的正确行为**
 *
 * 提示词全集：`../数据库课程智能体调研/product/PROMPTS.md` §5
 */

import type {
  HealthResult, Provider, ProviderConfigEntry, ProviderInfo,
  TranslateRequest, TranslateResult,
} from '../types.ts';
import { ProviderError } from '../types.ts';
import { OpenAiCompatibleLlm, redact, type OpenAiCompatibleOptions } from '../llm/openai_compatible.ts';

// ─────────────────────────────────────────────────────────────
// 领域规则：什么该保留英文
// ─────────────────────────────────────────────────────────────

/**
 * 判定一个条目是否**应该原样保留英文**。
 *
 * 规则（顺序即优先级）：
 *  1. 已含中文 → 保留（无需译）
 *  2. 在调用方给的 `keepAsIs` 白名单里 → 保留
 *  3. 含标识符符号 `_ ( ) [ ] . @ # $ %` → 保留
 *  4. 全大写（≥2 字符）→ 保留（`SELECT` / `DDL`）
 *  5. **CamelCase 产品名（无空格 且 ≥2 个大写字母）** → 保留
 *     （`InnoDB` / `MyISAM` / `MySQL` / `PostgreSQL`）
 *     ⚠️ 这条是**测试抓出来的漏网**：初版没有它，`InnoDB` 会被送去翻译，
 *        而它已被确认为**必须保留的专有名**（见 AGENTS.md 的 5 个真实多义词）
 *  6. 字母+数字标识（`crc32` / `sha256` / `md5` / `utf8`）→ 保留
 *  7. SQL 关键字开头 → 保留
 *
 * 反例（**应翻译**）：`clustered index`（有空格）、`Table`（仅 1 个大写）、
 * `data warehouse`、`transaction` —— 普通英文词/词组。
 */
export function shouldKeepAsIs(text: string, keepAsIs: readonly string[] = []): boolean {
  const t = text.trim();
  if (!t) return true;
  // ① 已含中文
  if (/[\u4e00-\u9fff]/.test(t)) return true;
  // ② 白名单（大小写不敏感）
  const lower = t.toLowerCase();
  if (keepAsIs.some((k) => k.toLowerCase() === lower)) return true;
  // ③ 标识符符号（⚠️ `.` **不能**放进这个字符类 —— 见 ③b）
  if (/[_()\[\]@#$%]/.test(t)) return true;
  // ③b 限定名里的点：`db.table` / `information_schema.tables` 才算标识符。
  //
  // ★ 真 bug 修复（2026-10-15，由 wiki-architect 实测发现）：
  //   原写法 `if (/[_()[\].@#$%]/.test(t)) return true;` 把 **`.` 放进了字符类**，
  //   于是无法区分「限定名的点」与「句末句号」→
  //     shouldKeepAsIs('Clustered indexes sort rows by key.') → true（应 false）
  //     shouldKeepAsIs('InnoDB provides MVCC.')                → true（应 false）
  //   而**本项目的证据句几乎全部以 `.` 结尾** →
  //     evidence 整条被标 kept=true → 一条都不送译 → 翻译任务"成功但什么都没做"（**静默空转**）。
  //   修法（方案 A）：`.` 只在**两侧都是标识符字符**时才算标识符。
  //     `db.table` ✅  ·  `key.` ❌  ·  `Clustered indexes sort rows by key.` ❌
  if (/[A-Za-z0-9_)\]]\.[A-Za-z0-9_(]/.test(t)) return true;
  // ④ 全大写
  if (/^[A-Z][A-Z0-9_]{1,}$/.test(t)) return true;
  // ⑤ CamelCase 产品名：无空格 + ≥2 个大写字母（InnoDB / MyISAM / PostgreSQL）
  if (!/\s/.test(t) && (t.match(/[A-Z]/g) ?? []).length >= 2) return true;
  // ⑥ 字母+数字（crc32 / sha256 / md5 / utf8）
  if (/^[a-z]{2,}\d+$/i.test(t)) return true;
  // ⑦ SQL 关键字开头
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|SHOW|SET|GRANT|REVOKE|EXPLAIN|WITH|USE|BEGIN|COMMIT|ROLLBACK)\b/i.test(t)) {
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// 术语表渲染
// ─────────────────────────────────────────────────────────────

/**
 * 把术语表渲染成提示词片段。
 *
 * ⚠️ **必须注入**。v1 实测：不注入时 `index`→"指标"、`view`→"看法"，
 * 会导致**检索失效**（学生搜"索引"找不到）。
 */
export function renderGlossary(glossary: Record<string, string> | undefined): string {
  if (!glossary || !Object.keys(glossary).length) {
    return '（无术语表 —— 注意：若译文与领域习惯不符，请优先使用数据库领域通用译名）';
  }
  const lines = Object.entries(glossary).map(([en, zh]) => `  ${en} → ${zh}`);
  return ['必须严格遵守以下领域术语对照（不得另译）：', ...lines].join('\n');
}

// ─────────────────────────────────────────────────────────────
// 核心：逐条翻译（并发 = 1，由 LLM 队列保证）
// ─────────────────────────────────────────────────────────────

const TRANSLATE_SCHEMA = {
  name: 'translations',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'text'],
          properties: {
            id: { type: 'string' },
            text: { type: 'string' },
          },
        },
      },
    },
  } as Record<string, unknown>,
};

const SYSTEM_PROMPT = `你是数据库领域的专业译者，为《数据库与数据仓库》课程的中文 Wiki 服务。

## 你的读者
中国高校数据库课程的本科生与教师。他们要能**在中文页面里检索到知识点**。

## 硬规则
1. **严格使用给定的领域术语表**，不得另选译名。
2. **保留英文的情形**（这是**正确行为，不是偷懒**）：
   - 标识符：含 \`_\` / \`(\` / \`)\` / \`.\` / \`@\` / \`#\` / \`$\` / \`%\` 的名称（如 \`sql_mode\`、\`InnoDB\`）
   - SQL 语句与关键字：\`SELECT\`、\`CREATE TABLE\`
   - 产品名与版本：\`MySQL 8.0\`、\`InnoDB\`
   这些**译了就无法检索**，必须原样保留。
3. **证据句（kind=evidence）不意译**：
   它是可核查的引用。要在**保留原意**的前提下译，
   宁可句子略"硬"，也不要为了通顺改变技术含义。
4. **术语（kind=term）**译名要与术语表一致，并与中文教材习惯一致。
5. 不要加解释、不要加括号注英文（除非术语表里就是这么定的）。

## 输出
严格 JSON，形如 {"items":[{"id":"<原 id>","text":"<译文>"}]}。id 必须原样回传。`;

// ─────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────

export interface LlmTranslateOptions extends OpenAiCompatibleOptions {
  /** 默认术语表（调用时给的会覆盖合并） */
  glossary?: Record<string, string>;
  /** 默认保留英文白名单 */
  keepAsIs?: string[];
  /** 每批最大条目数（避免上下文过长，也便于断点续跑） */
  batchSize?: number;
}

export class LlmTranslateProvider implements Provider {
  readonly info: ProviderInfo;
  private readonly llm: OpenAiCompatibleLlm;
  private readonly glossary: Record<string, string>;
  private readonly keepAsIs: string[];
  private readonly batchSize: number;

  constructor(o: LlmTranslateOptions) {
    this.llm = new OpenAiCompatibleLlm(o);
    this.glossary = o.glossary ?? {};
    this.keepAsIs = o.keepAsIs ?? [];
    this.batchSize = o.batchSize ?? 20;
    this.info = {
      // ⚠️ 用一个独立的 id，避免与同名 LLM provider 冲突
      id: o.id ?? 'llm-mt',
      kind: 'translate',
      label: o.label ?? `LLM 翻译（术语表，${o.model}）`,
      vendor: o.vendor ?? 'LLM',
      runtime: 'cloud',
      configured: this.llm.info.configured,
      available: false,
      reason: this.llm.info.reason,
      capabilities: {
        glossary: true,              // ★ 本实现的核心优势
        keepAsIs: true,
        batch: true,
        languages: ['zh', 'en'],
        /** 支持按 kind 区分策略（证据句不意译） */
        kindAware: true,
      },
      pricing: undefined,
      limits: { concurrency: 1, maxCharsPerRequest: 20_000 },
    };
  }

  async healthCheck(signal?: AbortSignal): Promise<HealthResult> {
    const h = await this.llm.healthCheck(signal);
    return { ...h, probe: `LLM 翻译探测：${h.probe ?? ''}` };
  }

  /** 单条翻译（`/api/v1/cards/{id}` 之类的小请求用） */
  async translateOne(text: string, to = 'zh', kind: 'term' | 'evidence' | 'prose' = 'term') {
    const r = await this.translate({ items: [{ id: '0', text, kind }], to });
    return r.items[0]?.text ?? text;
  }

  async translate(req: TranslateRequest): Promise<TranslateResult> {
    if (!this.info.configured) {
      throw new ProviderError('E_NOT_CONFIGURED', `${this.info.id} 凭据未配置`, this.info.reason);
    }
    const glossary = { ...this.glossary, ...(req.glossary ?? {}) };
    const keep = [...this.keepAsIs, ...(req.keepAsIs ?? [])];

    // ① 先本地判定的"必须保留英文"，**不浪费 token 去问模型**
    const kept: TranslateResult['items'] = [];
    const need: TranslateRequest['items'] = [];
    for (const it of req.items) {
      if (shouldKeepAsIs(it.text, keep)) {
        kept.push({ id: it.id, text: it.text, keptAsIs: true });
      } else {
        need.push(it);
      }
    }

    // ② 剩下的分批送 LLM（并发由 LLM 队列保证 = 1）
    const translated: TranslateResult['items'] = [];
    for (let i = 0; i < need.length; i += this.batchSize) {
      const batch = need.slice(i, i + this.batchSize);
      const payload = batch.map((b) => ({ id: b.id, text: b.text, kind: b.kind ?? 'term' }));
      const user = [
        `## 领域术语表`,
        renderGlossary(glossary),
        ``,
        `## 目标语言`,
        req.to === 'zh' ? '简体中文' : req.to,
        ``,
        `## 待译条目（逐条译，id 原样回传）`,
        JSON.stringify(payload, null, 1),
      ].join('\n');

      const res = await this.llm.completeJson<{ items: { id: string; text: string }[] }>({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
        schema: TRANSLATE_SCHEMA,
        temperature: 0,
        maxTokens: 4096,
        signal: req.signal,
      });

      // ③ 校验：模型**必须**回传全部 id（漏了就是 bug，不能静默丢条目）
      const got = new Map((res.data.items ?? []).map((x) => [x.id, x.text]));
      const missing = batch.filter((b) => !got.has(b.id)).map((b) => b.id);
      if (missing.length) {
        throw new ProviderError(
          'E_LLM',
          `翻译返回缺 ${missing.length} 条（${missing.slice(0, 5).join(',')}…）`,
          '模型未按 schema 回传全部 id，可重试；**不能静默丢条目**',
        );
      }
      for (const b of batch) translated.push({ id: b.id, text: got.get(b.id)! });
    }

    // ④ 按原顺序合并（保持调用方给的顺序，便于逐条对齐）
    const byId = new Map([...kept, ...translated].map((x) => [x.id, x]));
    const items = req.items.map((it) => byId.get(it.id) ?? { id: it.id, text: it.text });

    return { items, usedProvider: this.info.id };
  }
}

// ─────────────────────────────────────────────────────────────
// 工厂
// ─────────────────────────────────────────────────────────────

/** 内置的数据库领域术语表（可被配置覆盖/合并） */
export const DEFAULT_DB_GLOSSARY: Record<string, string> = {
  'index': '索引',
  'clustered index': '聚簇索引',
  'secondary index': '二级索引',
  'view': '视图',
  'table': '表',
  'column': '列',
  'row': '行',
  'transaction': '事务',
  'isolation level': '隔离级别',
  'lock': '锁',
  'deadlock': '死锁',
  'trigger': '触发器',
  'stored procedure': '存储过程',
  'partition': '分区',
  'replication': '复制',
  'sharding': '分片',
  'query plan': '查询计划',
  'optimizer': '优化器',
  'data warehouse': '数据仓库',
  'OLAP': '联机分析处理',
  'OLTP': '联机事务处理',
  'star schema': '星型模型',
  'snowflake schema': '雪花模型',
  'fact table': '事实表',
  'dimension table': '维表',
  'ETL': '抽取转换加载',
};

export function createTranslateProvider(
  entry: ProviderConfigEntry,
  deps: { glossary?: Record<string, string> } = {},
): Provider | null {
  const o = entry.options as Record<string, unknown>;
  switch (entry.type) {
    case 'openai_compatible':
    case 'llm': {
      const baseUrl = String(o.base_url ?? o.baseUrl ?? '');
      const model = String(o.model ?? '');
      if (!baseUrl || !model) return null;
      const p = new LlmTranslateProvider({
        id: entry.id,
        label: String(o.label ?? `LLM 翻译（${model}）`),
        vendor: String(o.vendor ?? 'LLM'),
        baseUrl,
        apiKey: String(o.api_key ?? o.apiKey ?? ''),
        model,
        glossary: { ...DEFAULT_DB_GLOSSARY, ...(deps.glossary ?? {}), ...asRecord(o.glossary) },
        keepAsIs: asStringArray(o.keep_as_is),
        batchSize: typeof o.batch_size === 'number' ? o.batch_size : undefined,
      });
      if (entry.missingEnv?.length) {
        p.info.configured = false;
        p.info.reason = `缺少环境变量 ${entry.missingEnv.join(' / ')}（在 course-kb/.env 配置）`;
      }
      return p;
    }
    case 'deepl': {
      // ⚠️ DeepL **不支持术语表注入的同等能力**（glossary 有限），
      // 且中文技术术语一致性弱于带术语表的 LLM → 定位为**第二跳**
      const key = String(o.api_key ?? '');
      const p = new LlmTranslateProvider({
        // 复用壳，但 healthCheck 会因凭据/实现差异如实失败
        id: entry.id,
        label: String(o.label ?? 'DeepL'),
        vendor: 'DeepL',
        baseUrl: String(o.base_url ?? 'https://api-free.deepl.com/v2'),
        apiKey: key,
        model: 'deepl',
        glossary: DEFAULT_DB_GLOSSARY,
      });
      p.info.capabilities = { glossary: false, keepAsIs: true, batch: false, kindAware: false };
      if (entry.missingEnv?.length) {
        p.info.configured = false;
        p.info.reason = `缺少环境变量 ${entry.missingEnv.join(' / ')}（在 course-kb/.env 配置）`;
      }
      return p;
    }
    default:
      return null;
  }
}

function asRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = String(val);
  return out;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

export { redact };
