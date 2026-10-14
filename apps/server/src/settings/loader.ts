/**
 * `settings.json` 的**读取**（文件 → 规范化 Settings + 元信息）。
 *
 * 分工见 `docs/SETTINGS_AND_SANDBOX.md` §1：
 * - 文件**缺失** → 用内置默认 + **如实报 `source:"default"`**（不假装读到了文件）
 * - 文件**非法** → 抛 `SettingsError`（**启动时拒绝启动**；热重载时由 store 兜成"保留旧值 + 记原因"）
 *
 * ⚠️ 本文件**不做 watch**（那是 `store.ts`）；它只负责"读一次、校验、给快照"。
 */

import fs from 'node:fs';

import { resolveSchemaPath, resolveSettingsPath } from './paths.ts';
import { defaultSettings, type Settings } from './types.ts';
import { SettingsError, validateSettings, type ValidateResult } from './validate.ts';

/** 设置来源：**必须是这两个之一**（`default` = 文件不存在）。 */
export type SettingsSource = 'file' | 'default';

/** 一次加载的结果。`settings` 永远是**已校验 + 已钳制**的完整配置。 */
export interface LoadResult {
  settings: Settings;
  source: SettingsSource;
  /** 期望/实际的文件路径（`source='default'` 时也给出，便于排查"文件放错地方了"） */
  path: string;
  /** 文件 mtime（ms）；不存在为 0 */
  mtimeMs: number;
  loadedAt: number;
  warnings: string[];
  /** 被忽略的配置（如 concurrency 被钳制）—— 结构化回显 */
  ignored: ValidateResult['ignored'];
  /** schema 位置提示（错误信息里用） */
  schemaPath: string;
}

export interface LoadOptions {
  /** 仓库根（`ServerConfig.root`） */
  root: string;
  /** 覆盖文件位置（测试/多环境用）；缺省 `<root>/config/settings.json` */
  file?: string;
}

/**
 * 读一次设置。
 *
 * @throws SettingsError 文件存在但**非法**（类型错/未知键/凭据）—— 让调用方**拒绝启动**
 */
export function loadSettings(opts: LoadOptions): LoadResult {
  const file = resolveSettingsPath(opts.root, opts.file);
  const schemaPath = resolveSchemaPath(opts.root);
  const base = { path: file, schemaPath, loadedAt: Date.now() };

  if (!fs.existsSync(file)) {
    // 文件缺失：用默认值，但**如实标注来源**（不是"读到了空配置"）
    const { settings, warnings, ignored } = validateSettings(defaultSettings(), { path: file });
    return {
      ...base,
      settings,
      source: 'default',
      mtimeMs: 0,
      warnings: [
        `settings 文件不存在（${file}）→ 使用内置默认配置；` +
          '要改运行期配置请创建该文件（可照 config/settings.schema.json）',
        ...warnings,
      ],
      ignored,
    };
  }

  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new SettingsError([`读取失败：${(e as Error).message}`], file);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (e) {
    throw new SettingsError(
      [`JSON 解析失败：${(e as Error).message}（提示：settings.json 允许 // 注释吗？不允许 —— 那是 JSONC）`],
      file,
    );
  }

  const { settings, warnings, ignored } = validateSettings(raw, { path: file });
  return {
    ...base,
    settings,
    source: 'file',
    mtimeMs: fs.statSync(file).mtimeMs,
    warnings,
    ignored,
  };
}

/** 把设置**原子**写回文件（临时文件 + rename：中断不会留半截 JSON）。 */
export function writeSettingsFile(file: string, settings: Settings): void {
  const payload: Record<string, unknown> = { $schema: './settings.schema.json', ...settings };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file); // 同目录 rename 是原子的（Windows 上覆盖已存在文件也 OK）
}

/** 快照供 `/api/v1/settings` 用（**脱敏在路由层做**，这里只给数据）。 */
export interface SettingsSnapshot {
  settings: Settings;
  source: SettingsSource;
  path: string;
  revision: number;
  mtimeMs: number;
  loadedAt: number;
  warnings: string[];
  ignored: ValidateResult['ignored'];
  lastReloadError: string | null;
  lastReloadErrorAt: number | null;
}
