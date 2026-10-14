/**
 * 封闭枚举加载（契约 C3 / §9：**不许发明枚举**）。
 *
 * 权威来源是 `schema/edge_types.json` 与 `schema/knowledge_card.json`（契约 §9 的"数据契约"）。
 * 本模块**运行期加载**，缺失时返回空数组 + 警告，**绝不内置一份"写死的枚举"兜底** ——
 * 因为写死会掩盖"文件丢了"，让实现与契约悄悄漂移。
 */

import fs from 'node:fs';
import path from 'node:path';

export interface SchemaEnums {
  edgeTypes: string[];
  entityTypes: string[];
  layers: string[];
  cardKinds: string[];
  usageModes: string[];
  operationalRoles: string[];
  lifecycles: string[];
  /** 实际读到的文件（诊断用）；缺哪个就是缺哪个 */
  sources: Record<string, string | null>;
  warnings: string[];
}

function readJson(file: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function findSchemaDir(root: string): string | null {
  for (const candidate of [path.join(root, 'contracts', 'schema'), path.join(root, 'schema')]) {
    if (fs.existsSync(path.join(candidate, 'edge_types.json'))) return candidate;
  }
  return null;
}

function enumValues(node: unknown, key: string): string[] {
  if (!node || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  const field = obj[key];
  if (!field || typeof field !== 'object') return [];
  const values = (field as Record<string, unknown>).values;
  return Array.isArray(values) ? values.map(String) : [];
}

let cache: { dir: string | null; value: SchemaEnums } | null = null;

/** 加载封闭枚举（按 schema 目录缓存）。 */
export function loadSchemaEnums(root: string): SchemaEnums {
  const dir = findSchemaDir(root);
  if (cache && cache.dir === dir) return cache.value;

  const warnings: string[] = [];
  const sources: Record<string, string | null> = { edge_types: null, knowledge_card: null };
  let edgeTypes: string[] = [];
  let entityTypes: string[] = [];
  let layers: string[] = [];
  let cardKinds: string[] = [];
  let usageModes: string[] = [];
  let operationalRoles: string[] = [];
  let lifecycles: string[] = [];

  if (!dir) {
    warnings.push(`未找到 schema 目录（试过 <root>/contracts/schema 与 <root>/schema）→ 抽取功能不可用（不内置兜底枚举）`);
  } else {
    const edgeFile = path.join(dir, 'edge_types.json');
    const cardFile = path.join(dir, 'knowledge_card.json');

    const edgeDoc = readJson(edgeFile);
    if (edgeDoc) {
      sources.edge_types = edgeFile;
      const e = edgeDoc as Record<string, unknown>;
      edgeTypes = Object.keys((e.edge_types as Record<string, unknown>) ?? {});
      entityTypes = Object.keys((e.entity_types as Record<string, unknown>) ?? {});
      layers = Object.keys((e.layers as Record<string, unknown>) ?? {});
    } else {
      warnings.push(`读不到 ${edgeFile} → 边/实体枚举为空，抽取会禁用`);
    }

    const cardDoc = readJson(cardFile);
    if (cardDoc) {
      sources.knowledge_card = cardFile;
      const fields = (cardDoc as Record<string, unknown>).card_fields as Record<string, unknown> | undefined;
      cardKinds = enumValues(fields, 'kind');
      usageModes = enumValues(fields, 'usage_mode');
      operationalRoles = enumValues(fields, 'operational_role');
      lifecycles = enumValues(fields, 'lifecycle');
    } else {
      warnings.push(`读不到 ${cardFile} → 卡片 kind 枚举为空，抽取会禁用`);
    }
  }

  const value: SchemaEnums = {
    edgeTypes,
    entityTypes,
    layers,
    cardKinds,
    usageModes,
    operationalRoles,
    lifecycles,
    sources,
    warnings,
  };
  cache = { dir, value };
  return value;
}

/** 枚举是否齐备（抽取的前提）。 */
export function enumsComplete(e: SchemaEnums): boolean {
  return (
    e.edgeTypes.length > 0 &&
    e.entityTypes.length > 0 &&
    e.cardKinds.length > 0 &&
    e.usageModes.length > 0 &&
    e.operationalRoles.length > 0 &&
    e.lifecycles.length > 0
  );
}

/** `/capabilities` 的 `schema` 段（契约 §5.1 的诚实上报）。 */
export function schemaSummary(e: SchemaEnums): Record<string, unknown> {
  return {
    edge_types: e.edgeTypes.length,
    card_kinds: e.cardKinds.length,
    entity_types: e.entityTypes.length,
    layers: e.layers.length,
    complete: enumsComplete(e),
    sources: e.sources,
    warnings: e.warnings,
  };
}

export function clearSchemaEnumCache(): void {
  cache = null;
}
