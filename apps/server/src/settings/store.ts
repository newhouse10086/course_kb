/**
 * 设置**热重载 store**（`docs/SETTINGS_AND_SANDBOX.md` §1「watch 热重载」）。
 *
 * 语义（每一条都有测试）：
 * 1. 改文件 → **不用重启**即生效（`fs.watch` + 防抖）
 * 2. 新内容**非法** → **保留旧配置继续服务** + 记 `lastReloadError`（**不崩、不静默回默认值**）
 * 3. 文件被删 → 回到默认配置并把 `source` 标成 `default`（如实）
 * 4. 每次成功变更 `revision++`，订阅者收到通知（`PUT` 与热重载**同一路径**，行为一致）
 *
 * ⚠️ 为什么非法时不崩：运维正在编辑的文件**必然**有"写到一半"的瞬间
 * （编辑器先截断再写入）。若那一刻就崩，等于"改配置 = 停机"。
 * 但**启动时**读到非法配置会抛错拒绝启动（那是明确的错误，不该带病运行）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadSettings, writeSettingsFile, type LoadResult, type SettingsSource } from './loader.ts';
import { defaultSettings, type Settings } from './types.ts';
import { SettingsError, type ValidateResult } from './validate.ts';

export interface SettingsStoreOptions {
  root: string;
  /** 覆盖文件位置（测试用） */
  file?: string;
  /** 是否启用文件监听；缺省用文件里的 `hotReload.watch`（true） */
  watch?: boolean;
  /**
   * 是否使用 `fs.watch`（默认 true）。
   * `false` = **只用兜底轮询**（WSL `/mnt/*`、网络盘、Docker 挂载卷上 inotify 不可靠时的部署开关）。
   */
  fsWatch?: boolean;
  /** 覆盖防抖（测试里调小到几十 ms）；缺省用文件里的 `hotReload.debounceMs` */
  debounceMs?: number;
  /**
   * `fs.watch` 之外**兜底轮询**的间隔（ms）。
   *
   * 为什么需要它：`fs.watch` 会**丢事件** ——
   * ① 监听句柄在 `fs.watch()` 返回后才由 OS 真正挂上，紧跟其后写文件可能整个丢掉；
   * ② 网络盘 / **WSL 的 `/mnt/d`** / Docker 挂载卷上 inotify 本就不可靠（本项目就跑在这种盘上）。
   * 丢事件的后果是"改了配置不生效且**不报错**"——正是本项目最忌讳的那种 bug。
   * 兜底轮询按 mtime 比对，代价可忽略（默认 ≥1s 一次 stat）。
   */
  pollMs?: number;
  /** 变更回调（成功应用后触发） */
  onChange?: (snapshot: SettingsView) => void;
  /** 热重载失败回调（**服务继续跑**，只是记录原因） */
  onError?: (err: Error) => void;
  /** 日志（默认走 console；测试可注入以便断言） */
  log?: (msg: string, level?: 'info' | 'warn') => void;
}

/** 对外快照（`GET /settings` 的数据源；脱敏由路由做）。 */
export interface SettingsView {
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
  /** 文件监听是否处于活动状态（`false` 时热重载**不生效**，如实上报） */
  watching: boolean;
}

export class SettingsStore {
  private readonly opts: SettingsStoreOptions;
  private current: LoadResult;
  private revision = 0;
  private lastReloadError: string | null = null;
  private lastReloadErrorAt: number | null = null;
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private watching = false;
  private readonly listeners = new Set<(v: SettingsView) => void>();

  constructor(opts: SettingsStoreOptions) {
    this.opts = opts;
    // 启动时**严格**：非法配置 → 抛 SettingsError（调用方拒绝启动）
    this.current = loadSettings({ root: opts.root, ...(opts.file ? { file: opts.file } : {}) });
    this.lastText = this.readTextOrNull();
  }

  // ── 读取 ────────────────────────────────────────────────────────────
  // ── 文件内容指纹（比 mtime 可靠：见 checkFileChanged 的注释）────────────
  /**
   * 上一次**已知**的文件文本；`null` = 文件不存在。
   *
   * ⚠️ 为什么不用 mtime 判断"变了没有"（实测踩到）：
   * 本机（Windows，D: 与 %TEMP% 都一样）**同一毫秒内的两次写会给出完全相同的 `mtimeMs`** ——
   * 实测 `write → stat → write → stat` 两次读数逐位相同。于是"改文件 → 比对 mtime → 认为没变
   * → 不重载"会变成**改了配置不生效且不报错**（正是本项目最忌讳的那类 bug）。
   * settings.json 只有几 KB，直接比文本最稳。
   */
  private lastText: string | null;

  private readTextOrNull(): string | null {
    try {
      return fs.existsSync(this.current.path) ? fs.readFileSync(this.current.path, 'utf8') : null;
    } catch {
      return null; // 正在被替换/无权限 → 当作"读不到"
    }
  }

  get(): Settings {
    return this.current.settings;
  }

  view(): SettingsView {
    return {
      settings: this.current.settings,
      source: this.current.source,
      path: this.current.path,
      revision: this.revision,
      mtimeMs: this.current.mtimeMs,
      loadedAt: this.current.loadedAt,
      warnings: [...this.current.warnings],
      ignored: this.current.ignored,
      lastReloadError: this.lastReloadError,
      lastReloadErrorAt: this.lastReloadErrorAt,
      watching: this.watching,
    };
  }

  // ── 订阅 ────────────────────────────────────────────────────────────
  subscribe(fn: (v: SettingsView) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const v = this.view();
    for (const fn of this.listeners) {
      try {
        fn(v);
      } catch (e) {
        this.log(`设置变更回调抛错（已忽略）：${(e as Error).message}`, 'warn');
      }
    }
    try {
      this.opts.onChange?.(v);
    } catch (e) {
      this.log(`onChange 抛错（已忽略）：${(e as Error).message}`, 'warn');
    }
  }

  // ── 应用新配置（PUT 与热重载共用）────────────────────────────────────
  /**
   * 应用一份**已校验**的配置（内存 + 落盘）。
   *
   * @param persist `true` = 同时写文件（`PUT` 路径）；`false` = 只改内存（热重载路径已由文件驱动）
   */
  apply(settings: Settings, opts: { persist: boolean; warnings?: string[]; ignored?: ValidateResult['ignored'] }): SettingsView {
    if (opts.persist) writeSettingsFile(this.current.path, settings);
    const stat = fs.existsSync(this.current.path) ? fs.statSync(this.current.path) : null;
    this.current = {
      settings,
      source: stat ? 'file' : this.current.source,
      path: this.current.path,
      schemaPath: this.current.schemaPath,
      mtimeMs: stat ? stat.mtimeMs : this.current.mtimeMs,
      loadedAt: Date.now(),
      warnings: opts.warnings ?? [],
      ignored: opts.ignored ?? [],
    };
    this.revision += 1;
    this.lastReloadError = null;
    this.lastReloadErrorAt = null;
    this.lastText = this.readTextOrNull(); // ★ 记住"我刚写的文本"，避免随后轮询把它当外部改动
    this.emit();
    return this.view();
  }

  /** 重新读盘（PUT 之后或手动刷新用）。非法 → 抛错且**不动**当前配置。 */
  reload(opts: { strict?: boolean } = {}): SettingsView {
    try {
      const text = this.readTextOrNull();
      // ★ 幂等（按**文本**比对，不按 mtime —— 见 lastText 的注释）：
      //    `fs.watch` 事件与兜底轮询可能对**同一次**改动各触发一次；
      //    内容没变 → 空操作（不 +revision、不通知订阅者），否则订阅者会收到重复通知、revision 跳号。
      if (text === this.lastText) return this.view();

      const next = loadSettings({ root: this.opts.root, ...(this.opts.file ? { file: this.opts.file } : {}) });
      this.current = next;
      this.lastText = text;
      this.revision += 1;
      this.lastReloadError = null;
      this.lastReloadErrorAt = null;
      this.emit();
      return this.view();
    } catch (e) {
      const err = e as Error;
      if (opts.strict) throw err;
      // 非严格（热重载）：保留旧配置 + 记录原因（**服务继续跑**）
      this.lastReloadError = err instanceof SettingsError ? err.issues.join('；') : err.message;
      this.lastReloadErrorAt = Date.now();
      this.log(`settings 热重载失败（保留旧配置继续服务）：${this.lastReloadError}`, 'warn');
      try {
        this.opts.onError?.(err);
      } catch {
        /* 回调抛错不影响主流程 */
      }
      return this.view();
    }
  }

  // ── 文件监听 ────────────────────────────────────────────────────────
  /**
   * 开始监听文件（幂等：重复调用不会挂多个 watcher）。
   *
   * @returns 是否真的挂上了监听（`false` = 环境不支持，**如实上报**，不假装热重载可用）
   */
  startWatching(): boolean {
    if (this.watcher || this.pollTimer) return true;
    const wantWatch = this.opts.watch ?? this.current.settings.hotReload.watch;
    if (!wantWatch) {
      this.log('settings 热重载被配置关闭（hotReload.watch=false）', 'warn');
      return false;
    }
    const dir = path.dirname(this.current.path);
    const base = path.basename(this.current.path);
    if (!fs.existsSync(dir)) {
      this.log(`settings 目录不存在，无法挂监听：${dir}`, 'warn');
      return false;
    }

    // ★ 兜底轮询：`fs.watch` 会**丢事件** ——
    //   ① 监听句柄在 `fs.watch()` 返回后才由 OS 真正挂上，紧跟其后写文件可能整个丢掉；
    //   ② 网络盘 / **WSL 的 `/mnt/d`** / Docker 挂载卷上 inotify 本就不可靠。
    //   丢事件的后果是"改了配置不生效**且不报错**" —— 本项目最忌讳的那种 bug。
    //   这里**先**起轮询，保证即使 fs.watch 完全不出事件，热重载依然成立。
    const pollMs = this.opts.pollMs ?? Math.max(1000, this.debounceMs() * 4);
    this.pollTimer = setInterval(() => this.checkFileChanged(), pollMs);
    this.pollTimer.unref?.();
    this.watching = true;

    if (this.opts.fsWatch === false) {
      this.log(`settings 热重载已启用（**仅轮询** ${pollMs}ms；fsWatch=false）`);
      return true;
    }

    try {
      // ⚠️ 监听**目录**而不是文件：很多编辑器是"写临时文件 + rename"，
      //    直接 watch 文件会在第一次 rename 后失去目标（经典坑，热重载从此静默失效）。
      this.watcher = fs.watch(dir, (_event, filename) => {
        if (filename && String(filename) !== base) return;
        this.scheduleReload();
      });
      this.watcher.on('error', (e) => this.log(`settings watcher 错误：${e.message}`, 'warn'));
      // ★ **必须 unref**：`fs.FSWatcher` 是活动句柄，会**让事件循环一直活着**。
      //    后果实测过：每个测试都 build 一次 app（于是挂一个 watcher）→ 测试全跑完了
      //    进程却**不退出**，`npm test` 挂死十几分钟。配置监听是后台附属品，
      //    该由 HTTP listener/其它业务句柄决定进程寿命。`close()` 里仍会正常释放。
      this.watcher.unref?.();
      this.log(`settings 热重载已启用：${this.current.path}（防抖 ${this.debounceMs()}ms，兜底轮询 ${pollMs}ms）`);
      return true;
    } catch (e) {
      // 挂不上 fs.watch **不等于**热重载不可用 —— 轮询还在，如实降级但仍然是热的
      this.log(
        `无法挂 fs.watch（${(e as Error).message}）→ **降级为轮询**（${pollMs}ms），热重载仍可用`,
        'warn',
      );
      return true;
    }
  }

  private debounceMs(): number {
    return this.opts.debounceMs ?? this.current.settings.hotReload.debounceMs;
  }

  private scheduleReload(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      // 内容没变就不动（编辑器一次保存会触发多个事件）；
      // ⚠️ 用**文本**比对而不是 mtime：同毫秒两次写的 mtime 会完全相同（实测），
      //    用 mtime 会把"真的改了"误判成"没变"。
      if (this.readTextOrNull() === this.lastText) return;
      this.reload();
    }, this.debounceMs());
    // 定时器不该拖住进程退出
    this.timer.unref?.();
  }

  /**
   * 兜底轮询：与 `lastText` 逐字节比对（**不依赖 mtime**）。
   *
   * 覆盖 `fs.watch` 丢事件的场合：WSL `/mnt/*`、网络盘、Docker 挂载卷，
   * 以及"watch 句柄还没挂上就写文件"的竞态。settings.json 只有几 KB，一轮一次 read 足够便宜。
   */
  private checkFileChanged(): void {
    if (this.readTextOrNull() !== this.lastText) this.reload();
  }

  /** 停止监听并清理定时器（测试与关服必须调，否则句柄泄漏）。 */
  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.watching = false;
    this.listeners.clear();
  }

  private log(msg: string, level: 'info' | 'warn' = 'info'): void {
    if (this.opts.log) this.opts.log(msg, level);
    else if (level === 'warn') console.warn(`[settings] ${msg}`);
    else console.log(`[settings] ${msg}`);
  }
}

/**
 * 便捷工厂：加载 + 挂热重载（`docs/SETTINGS_AND_SANDBOX.md` §1 的 `watchSettings()`）。
 *
 * @throws SettingsError 启动时配置非法（**拒绝启动**，由调用方决定怎么报）
 */
export function watchSettings(opts: SettingsStoreOptions): SettingsStore {
  const store = new SettingsStore(opts);
  store.startWatching();
  return store;
}

/** 文件不存在时"内置默认"也可单独取用（`source='default'` 的场景）。 */
export { defaultSettings };
