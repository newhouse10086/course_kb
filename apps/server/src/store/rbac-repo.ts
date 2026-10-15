/**
 * RBAC 数据访问层（`docs/RBAC.md` §3 / §5 / §6）。
 *
 * ## 为什么单独一个类（不塞进 Repo）
 * RBAC §6 的硬要求：**隔离必须在 SQL 层**。
 * 把 `notes` / `conversations` 放在这里，并让**每个方法的第一个参数都是 `userId`**，
 * 使"忘记加 `where user_id=?`"在**类型层面**就不可能发生（不传编译不过）。
 *
 * 本文件**不 import `src/auth/**`**（保持 store 层不依赖认证层）：
 * 角色在库里就是字符串，合法性由 auth 层用 `isRole()` 过滤。
 */

import { Db } from './db.ts';
import { newAuditId, newConversationId, newCourseId, newNoteId, newUserId } from './ids.ts';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  status: string; // active | disabled
  created_at: number;
  updated_at: number;
}

/** 对外安全的用户视图（**不含 password_hash**）。 */
export interface PublicUser {
  id: string;
  username: string;
  display_name: string;
  status: string;
  roles: string[];
  created_at: number;
  updated_at: number;
}

export interface CourseRow {
  id: string;
  name: string;
  term: string;
  owner_id: string | null;
  created_at: number;
}

export interface MemberRow {
  course_id: string;
  user_id: string;
  role: string;
  username?: string;
  display_name?: string;
}

export interface NoteRow {
  id: string;
  user_id: string;
  card_id: string | null;
  unit_id: string | null;
  doc_id: string | null;
  body: string;
  created_at: number;
}

export interface ConversationRow {
  id: string;
  user_id: string;
  doc_id: string | null;
  title: string;
  created_at: number;
}

export interface AuditRow {
  id: string;
  user_id: string | null;
  action: string;
  target: string;
  detail_json: string;
  at: number;
}

export class RbacRepo {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ═══════════════════════════════════════════════════════════════════
  // users / roles
  // ═══════════════════════════════════════════════════════════════════

  countUsers(): number {
    return Number(this.db.scalar<number>('SELECT COUNT(*) FROM users') ?? 0);
  }

  /** 建用户（roles 一起写）。用户名唯一（唯一索引冲突会抛，调用方转成 409）。 */
  createUser(input: {
    id?: string;
    username: string;
    displayName?: string;
    passwordHash: string;
    roles: string[];
    status?: string;
  }): string {
    const id = input.id ?? newUserId();
    const now = Date.now();
    return this.db.tx(() => {
      this.db.run(
        'INSERT INTO users(id,username,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
        id,
        input.username,
        input.displayName ?? '',
        input.passwordHash,
        input.status ?? 'active',
        now,
        now,
      );
      this.setRoles(id, input.roles);
      return id;
    });
  }

  getUserRow(id: string): UserRow | undefined {
    return this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  }

  getUserRowByName(username: string): UserRow | undefined {
    return this.db.get<UserRow>('SELECT * FROM users WHERE username = ?', username);
  }

  rolesOf(userId: string): string[] {
    return this.db
      .all<{ role: string }>('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role', userId)
      .map((r) => r.role);
  }

  /** 全量替换角色（事务内先删后插）。 */
  setRoles(userId: string, roles: string[]): void {
    this.db.tx(() => {
      this.db.run('DELETE FROM user_roles WHERE user_id = ?', userId);
      const stmt = this.db.stmt('INSERT OR IGNORE INTO user_roles(user_id, role) VALUES(?,?)');
      for (const r of [...new Set(roles)]) stmt.run(userId, r);
    });
  }

  /** 对外安全视图（**永不含 password_hash**）。 */
  toPublicUser(row: UserRow): PublicUser {
    return {
      id: row.id,
      username: row.username,
      display_name: row.display_name,
      status: row.status,
      roles: this.rolesOf(row.id),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  getPublicUser(id: string): PublicUser | undefined {
    const row = this.getUserRow(id);
    return row ? this.toPublicUser(row) : undefined;
  }

  listUsers(opts: { offset?: number; limit?: number; q?: string } = {}): { total: number; users: PublicUser[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.q) {
      where.push('(username LIKE ? OR display_name LIKE ?)');
      params.push(`%${opts.q}%`, `%${opts.q}%`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(this.db.scalar<number>(`SELECT COUNT(*) FROM users ${clause}`, ...params) ?? 0);
    const rows = this.db.all<UserRow>(
      `SELECT * FROM users ${clause} ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`,
      ...params,
      Math.max(1, Math.trunc(opts.limit ?? 50)),
      Math.max(0, Math.trunc(opts.offset ?? 0)),
    );
    return { total, users: rows.map((r) => this.toPublicUser(r)) };
  }

  setUserStatus(id: string, status: 'active' | 'disabled'): boolean {
    const res = this.db.run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', status, Date.now(), id);
    return res.changes > 0;
  }

  setPassword(id: string, passwordHash: string): boolean {
    const res = this.db.run(
      'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
      passwordHash,
      Date.now(),
      id,
    );
    return res.changes > 0;
  }

  // ═══════════════════════════════════════════════════════════════════
  // sessions（库存哈希，不存明文 token）
  // ═══════════════════════════════════════════════════════════════════

  createSession(input: { tokenHash: string; userId: string; expiresAt: number; userAgent?: string }): void {
    this.db.run(
      'INSERT INTO sessions(id,user_id,expires_at,created_at,user_agent) VALUES(?,?,?,?,?)',
      input.tokenHash,
      input.userId,
      input.expiresAt,
      Date.now(),
      (input.userAgent ?? '').slice(0, 300),
    );
  }

  /** 按**哈希**查会话（主键查询；不做明文比较 → 无时序侧信道）。 */
  findSession(tokenHash: string): { id: string; user_id: string; expires_at: number } | undefined {
    return this.db.get<{ id: string; user_id: string; expires_at: number }>(
      'SELECT id, user_id, expires_at FROM sessions WHERE id = ?',
      tokenHash,
    );
  }

  deleteSession(tokenHash: string): boolean {
    return this.db.run('DELETE FROM sessions WHERE id = ?', tokenHash).changes > 0;
  }

  deleteUserSessions(userId: string): number {
    return this.db.run('DELETE FROM sessions WHERE user_id = ?', userId).changes;
  }

  purgeExpiredSessions(now = Date.now()): number {
    return this.db.run('DELETE FROM sessions WHERE expires_at <= ?', now).changes;
  }

  countSessions(): number {
    return Number(this.db.scalar<number>('SELECT COUNT(*) FROM sessions') ?? 0);
  }

  // ═══════════════════════════════════════════════════════════════════
  // courses / members
  // ═══════════════════════════════════════════════════════════════════

  createCourse(input: { id?: string; name: string; term?: string; ownerId: string | null }): string {
    const id = input.id ?? newCourseId();
    this.db.run(
      'INSERT INTO courses(id,name,term,owner_id,created_at) VALUES(?,?,?,?,?)',
      id,
      input.name,
      input.term ?? '',
      input.ownerId,
      Date.now(),
    );
    // 任课教师自动成为 teacher 成员（少一步手工操作，也避免"建了课却没人能管"）
    if (input.ownerId) this.addMember(id, input.ownerId, 'teacher');
    return id;
  }

  getCourse(id: string): CourseRow | undefined {
    return this.db.get<CourseRow>('SELECT * FROM courses WHERE id = ?', id);
  }

  /** 课程列表（scope 由调用方按 RBAC §4 决定；这里只做数据查询，**不判权限**）。 */
  listCoursesFor(userId: string | null, opts: { isAdmin?: boolean; offset?: number; limit?: number } = {}): {
    total: number;
    courses: CourseRow[];
  } {
    const limit = Math.max(1, Math.trunc(opts.limit ?? 50));
    const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
    if (opts.isAdmin || !userId) {
      const total = Number(this.db.scalar<number>('SELECT COUNT(*) FROM courses') ?? 0);
      return {
        total,
        courses: this.db.all<CourseRow>('SELECT * FROM courses ORDER BY created_at DESC LIMIT ? OFFSET ?', limit, offset),
      };
    }
    const total = Number(
      this.db.scalar<number>(
        `SELECT COUNT(DISTINCT c.id) FROM courses c
         LEFT JOIN course_members m ON m.course_id = c.id
         WHERE c.owner_id = ? OR m.user_id = ?`,
        userId,
        userId,
      ) ?? 0,
    );
    const courses = this.db.all<CourseRow>(
      `SELECT DISTINCT c.* FROM courses c
       LEFT JOIN course_members m ON m.course_id = c.id
       WHERE c.owner_id = ? OR m.user_id = ?
       ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
      userId,
      userId,
      limit,
      offset,
    );
    return { total, courses };
  }

  addMember(courseId: string, userId: string, role: 'teacher' | 'student'): void {
    this.db.run(
      'INSERT INTO course_members(course_id,user_id,role) VALUES(?,?,?) ON CONFLICT(course_id,user_id) DO UPDATE SET role=excluded.role',
      courseId,
      userId,
      role,
    );
  }

  removeMember(courseId: string, userId: string): boolean {
    return this.db.run('DELETE FROM course_members WHERE course_id = ? AND user_id = ?', courseId, userId).changes > 0;
  }

  membersOf(courseId: string): MemberRow[] {
    return this.db.all<MemberRow>(
      `SELECT m.course_id, m.user_id, m.role, u.username, u.display_name
       FROM course_members m JOIN users u ON u.id = m.user_id
       WHERE m.course_id = ? ORDER BY m.role, u.username`,
      courseId,
    );
  }

  memberRole(courseId: string, userId: string): string | null {
    const row = this.db.get<{ role: string }>(
      'SELECT role FROM course_members WHERE course_id = ? AND user_id = ?',
      courseId,
      userId,
    );
    return row?.role ?? null;
  }

  /** 某用户加入的课程（按身份分组）—— `AuthUser.teacherCourseIds/studentCourseIds` 的来源。 */
  coursesOf(userId: string): { teacher: string[]; student: string[] } {
    const rows = this.db.all<{ course_id: string; role: string }>(
      'SELECT course_id, role FROM course_members WHERE user_id = ?',
      userId,
    );
    return {
      teacher: rows.filter((r) => r.role === 'teacher').map((r) => r.course_id),
      student: rows.filter((r) => r.role === 'student').map((r) => r.course_id),
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // notes（★ 每个方法第一个参数都是 userId → 忘记隔离就编译不过）
  // ═══════════════════════════════════════════════════════════════════

  createNote(
    userId: string,
    input: { body: string; cardId?: string | null; unitId?: string | null; docId?: string | null },
  ): string {
    const id = newNoteId();
    this.db.run(
      'INSERT INTO notes(id,user_id,card_id,unit_id,doc_id,body,created_at) VALUES(?,?,?,?,?,?,?)',
      id,
      userId,
      input.cardId ?? null,
      input.unitId ?? null,
      input.docId ?? null,
      input.body,
      Date.now(),
    );
    return id;
  }

  /** 只返回**该用户**的笔记（`WHERE user_id = ?` 在 SQL 里，不靠调用方）。 */
  listNotes(userId: string, opts: { offset?: number; limit?: number; docId?: string; cardId?: string } = {}): {
    total: number;
    notes: NoteRow[];
  } {
    const where = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (opts.docId) {
      where.push('doc_id = ?');
      params.push(opts.docId);
    }
    if (opts.cardId) {
      where.push('card_id = ?');
      params.push(opts.cardId);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = Number(this.db.scalar<number>(`SELECT COUNT(*) FROM notes ${clause}`, ...params) ?? 0);
    const notes = this.db.all<NoteRow>(
      `SELECT * FROM notes ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ...params,
      Math.max(1, Math.trunc(opts.limit ?? 100)),
      Math.max(0, Math.trunc(opts.offset ?? 0)),
    );
    return { total, notes };
  }

  /** 取笔记：**必须带 userId**；别人的笔记返回 undefined（路由转 404，不泄露存在性）。 */
  getNote(userId: string, id: string): NoteRow | undefined {
    return this.db.get<NoteRow>('SELECT * FROM notes WHERE user_id = ? AND id = ?', userId, id);
  }

  deleteNote(userId: string, id: string): boolean {
    return this.db.run('DELETE FROM notes WHERE user_id = ? AND id = ?', userId, id).changes > 0;
  }

  updateNote(userId: string, id: string, body: string): boolean {
    return this.db.run('UPDATE notes SET body = ? WHERE user_id = ? AND id = ?', body, userId, id).changes > 0;
  }

  /** 跨用户统计（仅供测试/审计断言"隔离真的生效"，不对外暴露）。 */
  countNotesAllUsers(): number {
    return Number(this.db.scalar<number>('SELECT COUNT(*) FROM notes') ?? 0);
  }

  // ═══════════════════════════════════════════════════════════════════
  // conversations（同样强制 userId）
  // ═══════════════════════════════════════════════════════════════════

  createConversation(userId: string, input: { docId?: string | null; title?: string } = {}): string {
    const id = newConversationId();
    this.db.run(
      'INSERT INTO conversations(id,user_id,doc_id,title,created_at) VALUES(?,?,?,?,?)',
      id,
      userId,
      input.docId ?? null,
      input.title ?? '',
      Date.now(),
    );
    return id;
  }

  /**
   * ★ **读取单个会话的归属（不按 userId 过滤）** —— IDOR 修复用。
   *
   * ⚠️ 与下方 `getConversation(userId, id)` **语义不同**：那个是"按 user 取自己的"，
   * 本方法是"取归属行本身"，因为调用方（`checkSessionOwner`）需要区分
   * "不存在"与"属于别人"，才能对外给出**逐字相同**的拒绝理由（不泄漏存在性）。
   * **路由不许**直接拿它当可见性判断用。
   */
  getConversationUnscoped(id: string): ConversationRow | undefined {
    return this.db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', id);
  }

  /**
   * ★ **认领一个会话**（首次连接时建立归属；`id` 由客户端提供，故用 `INSERT OR IGNORE` + 复核）。
   *
   * 为什么不用 `createConversation`（它自己生成 id）：聊天会话 id 是前端生成并已在
   * pi 转录里用过的 key，必须**沿用同一个 id** 才能让历史接得上。
   * `INSERT OR IGNORE`：并发首连时只有一个能插入；插入后再复核归属（见 `checkSessionOwner`）。
   */
  claimConversation(input: { id: string; userId: string; docId?: string | null; title?: string }): void {
    this.db.run(
      'INSERT OR IGNORE INTO conversations(id,user_id,doc_id,title,created_at) VALUES(?,?,?,?,?)',
      input.id,
      input.userId,
      input.docId ?? null,
      input.title ?? '',
      Date.now(),
    );
  }

  listConversations(userId: string, opts: { limit?: number; offset?: number } = {}): {
    total: number;
    conversations: ConversationRow[];
  } {
    const total = Number(
      this.db.scalar<number>('SELECT COUNT(*) FROM conversations WHERE user_id = ?', userId) ?? 0,
    );
    const conversations = this.db.all<ConversationRow>(
      'SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      userId,
      Math.max(1, Math.trunc(opts.limit ?? 50)),
      Math.max(0, Math.trunc(opts.offset ?? 0)),
    );
    return { total, conversations };
  }

  getConversation(userId: string, id: string): ConversationRow | undefined {
    return this.db.get<ConversationRow>('SELECT * FROM conversations WHERE user_id = ? AND id = ?', userId, id);
  }

  deleteConversation(userId: string, id: string): boolean {
    return this.db.run('DELETE FROM conversations WHERE user_id = ? AND id = ?', userId, id).changes > 0;
  }

  countConversationsAllUsers(): number {
    return Number(this.db.scalar<number>('SELECT COUNT(*) FROM conversations') ?? 0);
  }

  // ═══════════════════════════════════════════════════════════════════
  // audit_log（教学场景必须留痕）
  // ═══════════════════════════════════════════════════════════════════

  audit(input: { userId: string | null; action: string; target?: string; detail?: Record<string, unknown> }): string {
    const id = newAuditId();
    this.db.run(
      'INSERT INTO audit_log(id,user_id,action,target,detail_json,at) VALUES(?,?,?,?,?,?)',
      id,
      input.userId,
      input.action,
      input.target ?? '',
      JSON.stringify(input.detail ?? {}),
      Date.now(),
    );
    return id;
  }

  listAudit(opts: { limit?: number; offset?: number; userId?: string; action?: string } = {}): {
    total: number;
    entries: (AuditRow & { username?: string })[];
  } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.userId) {
      where.push('a.user_id = ?');
      params.push(opts.userId);
    }
    if (opts.action) {
      where.push('a.action = ?');
      params.push(opts.action);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(this.db.scalar<number>(`SELECT COUNT(*) FROM audit_log a ${clause}`, ...params) ?? 0);
    const entries = this.db.all<AuditRow & { username?: string }>(
      `SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${clause}
       ORDER BY a.at DESC, a.id DESC LIMIT ? OFFSET ?`,
      ...params,
      Math.max(1, Math.trunc(opts.limit ?? 100)),
      Math.max(0, Math.trunc(opts.offset ?? 0)),
    );
    return { total, entries };
  }
}
