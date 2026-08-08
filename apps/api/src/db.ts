// 数据访问层：Repo 接口 + D1 实现 + 内存实现（测试用）
// 核心业务只依赖 Repo 接口，测试注入 MemoryRepo，生产注入 D1Repo。

export interface UserRow {
  id: number;
  username: string;
  passwordHash: string;
  pagesMain: string;
  pagesData: string;
  createdAt: string;
}

export interface FileRow {
  id: number;
  userId: number;
  parentId: number | null;
  name: string;
  type: 'file' | 'folder';
  createdAt: string;
  modifiedAt: string;
}

export interface VersionRow {
  id: number;
  fileId: number;
  size: number;
  createdAt: string;
  name: string | null;
  shotAt: string | null;
  deployUrl: string;
  deploymentId: string;
  isVideo: boolean;
  duration: number | null;
  resolution: string | null;
  chunkCount: number;
}

export interface ChunkRow {
  index: number;
  path: string;
  size: number;
}

export interface Repo {
  // users
  createUser(u: Omit<UserRow, 'id' | 'createdAt'>): Promise<UserRow>;
  findUserByUsername(username: string): Promise<UserRow | null>;
  findUserById(id: number): Promise<UserRow | null>;

  // files
  listChildren(userId: number, parentId: number | null): Promise<FileRow[]>;
  findChild(userId: number, parentId: number | null, name: string): Promise<FileRow | null>;
  createFolder(userId: number, parentId: number | null, name: string, ts: string): Promise<FileRow>;
  createFile(userId: number, parentId: number | null, name: string, ts: string): Promise<FileRow>;
  deleteNode(nodeId: number): Promise<void>;
  updateModified(nodeId: number, ts: string): Promise<void>;
  getNodeById(nodeId: number): Promise<FileRow | null>;
  moveNode(nodeId: number, newParentId: number | null, newName: string, ts: string): Promise<void>;

  // versions
  addVersion(v: Omit<VersionRow, 'id'>): Promise<VersionRow>;
  addChunks(versionId: number, chunks: ChunkRow[]): Promise<void>;
  listVersions(fileId: number): Promise<VersionRow[]>;
  getVersion(versionId: number): Promise<VersionRow | null>;
  deleteVersion(versionId: number): Promise<VersionRow | null>;
  renameVersion(versionId: number, name: string | null): Promise<void>;

  // search
  searchByName(userId: number, q: string): Promise<{ fileId: number; fileName: string; versionId: number; versionName: string | null; createdAt: string }[]>;

  // shares
  createShare(s: Omit<ShareRow, 'id' | 'createdAt'>): Promise<ShareRow>;
  findShareByToken(token: string): Promise<ShareRow | null>;
  deleteShare(userId: number, token: string): Promise<void>;
  listShares(userId: number): Promise<ShareRow[]>;

  // upload sessions（分片上传）
  createUploadSession(s: Omit<UploadSessionRow, 'id' | 'createdAt' | 'updatedAt'>): Promise<UploadSessionRow>;
  findUploadSession(userId: number, uploadId: string): Promise<UploadSessionRow | null>;
  updateUploadSessionStatus(userId: number, uploadId: string, status: UploadSessionRow['status']): Promise<void>;
}

export interface ShareRow {
  id: number;
  userId: number;
  fileId: number;
  token: string;
  versionId: number | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface UploadSessionRow {
  id: number;
  userId: number;
  uploadId: string;
  filename: string;
  remotePath: string;
  totalSize: number;
  chunkSize: number;
  totalChunks: number;
  status: 'uploading' | 'done' | 'expired';
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// D1 实现
// ============================================================

export class D1Repo implements Repo {
  constructor(private db: D1Database) {}

  async createUser(u: Omit<UserRow, 'id' | 'createdAt'>): Promise<UserRow> {
    const res = await this.db
      .prepare('INSERT INTO users (username, password_hash, pages_main, pages_data) VALUES (?,?,?,?) RETURNING *')
      .bind(u.username, u.passwordHash, u.pagesMain, u.pagesData)
      .first<Record<string, unknown>>();
    if (!res) throw new Error('创建用户失败');
    return mapUser(res);
  }

  async findUserByUsername(username: string): Promise<UserRow | null> {
    const row = await this.db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<Record<string, unknown>>();
    return row ? mapUser(row) : null;
  }

  async findUserById(id: number): Promise<UserRow | null> {
    const row = await this.db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<Record<string, unknown>>();
    return row ? mapUser(row) : null;
  }

  async listChildren(userId: number, parentId: number | null): Promise<FileRow[]> {
    const rows = await this.db
      .prepare('SELECT * FROM files WHERE user_id = ? AND parent_id IS ? ORDER BY type DESC, name ASC')
      .bind(userId, parentId)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map(mapFile);
  }

  async findChild(userId: number, parentId: number | null, name: string): Promise<FileRow | null> {
    const row = await this.db
      .prepare('SELECT * FROM files WHERE user_id = ? AND parent_id IS ? AND name = ?')
      .bind(userId, parentId, name)
      .first<Record<string, unknown>>();
    return row ? mapFile(row) : null;
  }

  async createFolder(userId: number, parentId: number | null, name: string, ts: string): Promise<FileRow> {
    return this.insertNode(userId, parentId, name, 'folder', ts);
  }

  async createFile(userId: number, parentId: number | null, name: string, ts: string): Promise<FileRow> {
    return this.insertNode(userId, parentId, name, 'file', ts);
  }

  private async insertNode(userId: number, parentId: number | null, name: string, type: 'file' | 'folder', ts: string): Promise<FileRow> {
    const res = await this.db
      .prepare('INSERT INTO files (user_id, parent_id, name, type, created_at, modified_at) VALUES (?,?,?,?,?,?) RETURNING *')
      .bind(userId, parentId, name, type, ts, ts)
      .first<Record<string, unknown>>();
    if (!res) throw new Error('创建节点失败');
    return mapFile(res);
  }

  async deleteNode(nodeId: number): Promise<void> {
    await this.db.prepare('DELETE FROM files WHERE id = ?').bind(nodeId).run();
  }

  async updateModified(nodeId: number, ts: string): Promise<void> {
    await this.db.prepare('UPDATE files SET modified_at = ? WHERE id = ?').bind(ts, nodeId).run();
  }

  async getNodeById(nodeId: number): Promise<FileRow | null> {
    const row = await this.db.prepare('SELECT * FROM files WHERE id = ?').bind(nodeId).first<Record<string, unknown>>();
    return row ? mapFile(row) : null;
  }

  async moveNode(nodeId: number, newParentId: number | null, newName: string, ts: string): Promise<void> {
    await this.db.prepare('UPDATE files SET parent_id = ?, name = ?, modified_at = ? WHERE id = ?').bind(newParentId, newName, ts, nodeId).run();
  }

  async addVersion(v: Omit<VersionRow, 'id'>): Promise<VersionRow> {
    const res = await this.db
      .prepare(
        'INSERT INTO versions (file_id, size, created_at, name, shot_at, deploy_url, deployment_id, is_video, duration, resolution, chunk_count) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING *',
      )
      .bind(v.fileId, v.size, v.createdAt, v.name, v.shotAt, v.deployUrl, v.deploymentId, v.isVideo ? 1 : 0, v.duration, v.resolution, v.chunkCount)
      .first<Record<string, unknown>>();
    if (!res) throw new Error('创建版本失败');
    return mapVersion(res);
  }

  async addChunks(versionId: number, chunks: ChunkRow[]): Promise<void> {
    if (chunks.length === 0) return;
    const stmt = this.db.prepare('INSERT INTO chunks (version_id, chunk_index, path, size) VALUES (?,?,?,?)');
    await this.db.batch(chunks.map((c) => stmt.bind(versionId, c.index, c.path, c.size)));
  }

  async listVersions(fileId: number): Promise<VersionRow[]> {
    const rows = await this.db
      .prepare('SELECT * FROM versions WHERE file_id = ? ORDER BY created_at DESC')
      .bind(fileId)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map(mapVersion);
  }

  async getVersion(versionId: number): Promise<VersionRow | null> {
    const row = await this.db.prepare('SELECT * FROM versions WHERE id = ?').bind(versionId).first<Record<string, unknown>>();
    return row ? mapVersion(row) : null;
  }

  async deleteVersion(versionId: number): Promise<VersionRow | null> {
    const v = await this.getVersion(versionId);
    if (!v) return null;
    await this.db.prepare('DELETE FROM versions WHERE id = ?').bind(versionId).run();
    return v;
  }

  async renameVersion(versionId: number, name: string | null): Promise<void> {
    await this.db.prepare('UPDATE versions SET name = ? WHERE id = ?').bind(name, versionId).run();
  }

  async searchByName(userId: number, q: string): Promise<{ fileId: number; fileName: string; versionId: number; versionName: string | null; createdAt: string }[]> {
    const like = `%${q}%`;
    const rows = await this.db
      .prepare(
        `SELECT f.id AS fileId, f.name AS fileName, v.id AS versionId, v.name AS versionName, v.created_at AS createdAt
         FROM versions v JOIN files f ON f.id = v.file_id
         WHERE f.user_id = ? AND (f.name LIKE ? OR v.name LIKE ?) LIMIT 50`,
      )
      .bind(userId, like, like)
      .all<{ fileId: number; fileName: string; versionId: number; versionName: string | null; createdAt: string }>();
    return rows.results ?? [];
  }

  async createShare(s: Omit<ShareRow, 'id' | 'createdAt'>): Promise<ShareRow> {
    const res = await this.db
      .prepare('INSERT INTO shares (user_id, file_id, token, version_id, expires_at) VALUES (?,?,?,?,?) RETURNING *')
      .bind(s.userId, s.fileId, s.token, s.versionId, s.expiresAt)
      .first<Record<string, unknown>>();
    if (!res) throw new Error('创建分享失败');
    return mapShare(res);
  }

  async findShareByToken(token: string): Promise<ShareRow | null> {
    const row = await this.db.prepare('SELECT * FROM shares WHERE token = ?').bind(token).first<Record<string, unknown>>();
    return row ? mapShare(row) : null;
  }

  async deleteShare(userId: number, token: string): Promise<void> {
    await this.db.prepare('DELETE FROM shares WHERE user_id = ? AND token = ?').bind(userId, token).run();
  }

  async listShares(userId: number): Promise<ShareRow[]> {
    const rows = await this.db.prepare('SELECT * FROM shares WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all<Record<string, unknown>>();
    return (rows.results ?? []).map(mapShare);
  }

  async createUploadSession(s: Omit<UploadSessionRow, 'id' | 'createdAt' | 'updatedAt'>): Promise<UploadSessionRow> {
    const res = await this.db
      .prepare(
        'INSERT INTO upload_sessions (user_id, upload_id, filename, remote_path, total_size, chunk_size, total_chunks, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *',
      )
      .bind(s.userId, s.uploadId, s.filename, s.remotePath, s.totalSize, s.chunkSize, s.totalChunks, s.status, new Date().toISOString(), new Date().toISOString())
      .first<Record<string, unknown>>();
    if (!res) throw new Error('创建上传会话失败');
    return mapUploadSession(res);
  }

  async findUploadSession(userId: number, uploadId: string): Promise<UploadSessionRow | null> {
    const row = await this.db
      .prepare('SELECT * FROM upload_sessions WHERE user_id = ? AND upload_id = ?')
      .bind(userId, uploadId)
      .first<Record<string, unknown>>();
    return row ? mapUploadSession(row) : null;
  }

  async updateUploadSessionStatus(userId: number, uploadId: string, status: UploadSessionRow['status']): Promise<void> {
    await this.db
      .prepare("UPDATE upload_sessions SET status = ?, updated_at = ? WHERE user_id = ? AND upload_id = ?")
      .bind(status, new Date().toISOString(), userId, uploadId)
      .run();
  }
}

// ============================================================
// 内存实现（测试/本地开发，语义与 D1 对齐）
// ============================================================

export class MemoryRepo implements Repo {
  users = new Map<number, UserRow>();
  files = new Map<number, FileRow>();
  versions = new Map<number, VersionRow>();
  chunks = new Map<number, ChunkRow[]>();
  private uid = 0;

  async createUser(u: Omit<UserRow, 'id' | 'createdAt'>): Promise<UserRow> {
    if ([...this.users.values()].some((x) => x.username === u.username)) throw new Error('用户名已存在');
    const row: UserRow = { ...u, id: ++this.uid, createdAt: new Date().toISOString() };
    this.users.set(row.id, row);
    return row;
  }
  async findUserByUsername(username: string): Promise<UserRow | null> {
    return [...this.users.values()].find((x) => x.username === username) ?? null;
  }
  async findUserById(id: number): Promise<UserRow | null> {
    return this.users.get(id) ?? null;
  }

  private fileId = 0;
  async listChildren(userId: number, parentId: number | null): Promise<FileRow[]> {
    return [...this.files.values()]
      .filter((f) => f.userId === userId && f.parentId === parentId)
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
  }
  async findChild(userId: number, parentId: number | null, name: string): Promise<FileRow | null> {
    return [...this.files.values()].find((f) => f.userId === userId && f.parentId === parentId && f.name === name) ?? null;
  }
  private insertNode(userId: number, parentId: number | null, name: string, type: 'file' | 'folder', ts: string): FileRow {
    if ([...this.files.values()].some((f) => f.userId === userId && f.parentId === parentId && f.name === name)) {
      throw new Error(`同名节点已存在: ${name}`);
    }
    const row: FileRow = { id: ++this.fileId, userId, parentId, name, type, createdAt: ts, modifiedAt: ts };
    this.files.set(row.id, row);
    return row;
  }
  async createFolder(userId: number, parentId: number | null, name: string, ts: string): Promise<FileRow> {
    return this.insertNode(userId, parentId, name, 'folder', ts);
  }
  async createFile(userId: number, parentId: number | null, name: string, ts: string): Promise<FileRow> {
    return this.insertNode(userId, parentId, name, 'file', ts);
  }
  async deleteNode(nodeId: number): Promise<void> {
    const node = this.files.get(nodeId);
    if (!node) return;
    // 级联删除子节点（文件夹）
    const children = [...this.files.values()].filter((f) => f.parentId === nodeId);
    for (const c of children) await this.deleteNode(c.id);
    // 删除版本与分块
    const vers = [...this.versions.values()].filter((v) => v.fileId === nodeId);
    for (const v of vers) {
      this.chunks.delete(v.id);
      this.versions.delete(v.id);
    }
    this.files.delete(nodeId);
  }
  async updateModified(nodeId: number, ts: string): Promise<void> {
    const n = this.files.get(nodeId);
    if (n) n.modifiedAt = ts;
  }
  async getNodeById(nodeId: number): Promise<FileRow | null> {
    return this.files.get(nodeId) ?? null;
  }

  async moveNode(nodeId: number, newParentId: number | null, newName: string, ts: string): Promise<void> {
    const n = this.files.get(nodeId);
    if (n) {
      n.parentId = newParentId;
      n.name = newName;
      n.modifiedAt = ts;
    }
  }

  private versionId = 0;
  async addVersion(v: Omit<VersionRow, 'id'>): Promise<VersionRow> {
    const row: VersionRow = { ...v, id: ++this.versionId };
    this.versions.set(row.id, row);
    return row;
  }
  async addChunks(versionId: number, chunks: ChunkRow[]): Promise<void> {
    this.chunks.set(versionId, chunks);
  }
  async listVersions(fileId: number): Promise<VersionRow[]> {
    return [...this.versions.values()].filter((v) => v.fileId === fileId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getVersion(versionId: number): Promise<VersionRow | null> {
    return this.versions.get(versionId) ?? null;
  }
  async deleteVersion(versionId: number): Promise<VersionRow | null> {
    const v = this.versions.get(versionId);
    if (!v) return null;
    this.versions.delete(versionId);
    this.chunks.delete(versionId);
    return v;
  }
  async renameVersion(versionId: number, name: string | null): Promise<void> {
    const v = this.versions.get(versionId);
    if (v) v.name = name;
  }
  async searchByName(userId: number, q: string): Promise<{ fileId: number; fileName: string; versionId: number; versionName: string | null; createdAt: string }[]> {
    const out: { fileId: number; fileName: string; versionId: number; versionName: string | null; createdAt: string }[] = [];
    for (const v of this.versions.values()) {
      const f = this.files.get(v.fileId);
      if (!f || f.userId !== userId) continue;
      if (f.name.includes(q) || (v.name ?? '').includes(q)) {
        out.push({ fileId: f.id, fileName: f.name, versionId: v.id, versionName: v.name, createdAt: v.createdAt });
      }
    }
    return out.slice(0, 50);
  }

  private shareId = 0;
  shares = new Map<number, ShareRow>();
  async createShare(s: Omit<ShareRow, 'id' | 'createdAt'>): Promise<ShareRow> {
    const row: ShareRow = { ...s, id: ++this.shareId, createdAt: new Date().toISOString() };
    this.shares.set(row.id, row);
    return row;
  }
  async findShareByToken(token: string): Promise<ShareRow | null> {
    return [...this.shares.values()].find((s) => s.token === token) ?? null;
  }
  async deleteShare(userId: number, token: string): Promise<void> {
    const s = [...this.shares.values()].find((x) => x.token === token && x.userId === userId);
    if (s) this.shares.delete(s.id);
  }
  async listShares(userId: number): Promise<ShareRow[]> {
    return [...this.shares.values()].filter((s) => s.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private uploadSessionId = 0;
  uploadSessions = new Map<number, UploadSessionRow>();
  async createUploadSession(s: Omit<UploadSessionRow, 'id' | 'createdAt' | 'updatedAt'>): Promise<UploadSessionRow> {
    const now = new Date().toISOString();
    const row: UploadSessionRow = { ...s, id: ++this.uploadSessionId, createdAt: now, updatedAt: now };
    this.uploadSessions.set(row.id, row);
    return row;
  }
  async findUploadSession(userId: number, uploadId: string): Promise<UploadSessionRow | null> {
    return [...this.uploadSessions.values()].find((s) => s.userId === userId && s.uploadId === uploadId) ?? null;
  }
  async updateUploadSessionStatus(userId: number, uploadId: string, status: UploadSessionRow['status']): Promise<void> {
    const s = [...this.uploadSessions.values()].find((x) => x.userId === userId && x.uploadId === uploadId);
    if (s) {
      s.status = status;
      s.updatedAt = new Date().toISOString();
    }
  }
}

function mapShare(r: Record<string, unknown>): ShareRow {
  return {
    id: r.id as number, userId: r.user_id as number, fileId: r.file_id as number, token: r.token as string,
    versionId: (r.version_id as number | null) ?? null, expiresAt: (r.expires_at as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function mapUploadSession(r: Record<string, unknown>): UploadSessionRow {
  return {
    id: r.id as number, userId: r.user_id as number, uploadId: r.upload_id as string,
    filename: r.filename as string, remotePath: r.remote_path as string,
    totalSize: r.total_size as number, chunkSize: r.chunk_size as number,
    totalChunks: r.total_chunks as number, status: r.status as UploadSessionRow['status'],
    createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  };
}

// ============================================================
// 行映射工具
// ============================================================

function mapUser(r: Record<string, unknown>): UserRow {
  return { id: r.id as number, username: r.username as string, passwordHash: r.password_hash as string, pagesMain: r.pages_main as string, pagesData: r.pages_data as string, createdAt: r.created_at as string };
}

function mapFile(r: Record<string, unknown>): FileRow {
  return { id: r.id as number, userId: r.user_id as number, parentId: (r.parent_id as number | null) ?? null, name: r.name as string, type: r.type as 'file' | 'folder', createdAt: r.created_at as string, modifiedAt: r.modified_at as string };
}

function mapVersion(r: Record<string, unknown>): VersionRow {
  return {
    id: r.id as number, fileId: r.file_id as number, size: r.size as number, createdAt: r.created_at as string,
    name: (r.name as string | null) ?? null, shotAt: (r.shot_at as string | null) ?? null,
    deployUrl: r.deploy_url as string, deploymentId: r.deployment_id as string,
    isVideo: (r.is_video as number) === 1, duration: (r.duration as number | null) ?? null,
    resolution: (r.resolution as string | null) ?? null, chunkCount: r.chunk_count as number,
  };
}
