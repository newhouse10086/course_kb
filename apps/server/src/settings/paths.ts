/**
 * 设置文件的**路径**与几个门槛常量（纯路径逻辑，便于单测）。
 */

import path from 'node:path';

/** `settings.json` 相对仓库根（与 `providers.yaml` 并列）。 */
export const SETTINGS_REL_PATH = 'config/settings.json';
export const SETTINGS_SCHEMA_REL_PATH = 'config/settings.schema.json';

/**
 * `maxTokens` 低于此值给 warning。
 *
 * 依据：该端点是**推理模型**，推理 token 计入输出预算 —— 实测 8 字回复用 54 个
 * reasoning token；`max_tokens=20` 时预算被推理吃光 → `content` 为空（看起来像"模型没答"）。
 * 见 `docs/SETTINGS_AND_SANDBOX.md` §0。
 */
export const MIN_SANE_MAX_TOKENS = 2048;

/** 解析设置文件绝对路径。`root` = 仓库根（`ServerConfig.root`）。 */
export function resolveSettingsPath(root: string, override?: string): string {
  return override ? path.resolve(override) : path.join(root, SETTINGS_REL_PATH);
}

/** 解析 schema 路径（仅用于错误提示里的"去哪看允许的字段"）。 */
export function resolveSchemaPath(root: string): string {
  return path.join(root, SETTINGS_SCHEMA_REL_PATH);
}
