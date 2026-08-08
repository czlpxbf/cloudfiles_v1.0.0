-- Cloudfiles D1 初始化迁移（MASTER_PLAN §3.1）
-- 文件树邻接表 + 版本 + 分块 + 影视元数据 + 分享

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- PBKDF2: hash|salt|iterations
  pages_main    TEXT NOT NULL,          -- {prefix}-{username}-main
  pages_data    TEXT NOT NULL,          -- {prefix}-{username}-data
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES files(id) ON DELETE CASCADE,  -- NULL = 根
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('file','folder')),
  created_at  TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  UNIQUE (user_id, parent_id, name)
);
CREATE INDEX idx_files_parent ON files(user_id, parent_id);

CREATE TABLE versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  size        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  name        TEXT,                     -- 版本别名（rv）
  shot_at     TEXT,                     -- 拍摄时间/媒体创建时间
  deploy_url  TEXT NOT NULL,            -- https://<hash>.<project>.pages.dev
  deployment_id TEXT NOT NULL,          -- Pages deployment id（cv 真删用）
  is_video    INTEGER NOT NULL DEFAULT 0,
  duration    REAL,
  resolution  TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_versions_file ON versions(file_id, created_at DESC);
CREATE INDEX idx_versions_shot ON versions(shot_at);
CREATE INDEX idx_versions_name ON versions(name);

CREATE TABLE chunks (
  version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  path       TEXT NOT NULL,             -- 部署内相对路径 chunk_0.bin / seg_0001.ts
  size       INTEGER NOT NULL,
  PRIMARY KEY (version_id, chunk_index)
);

CREATE TABLE metas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version_id  INTEGER REFERENCES versions(id) ON DELETE SET NULL,
  title       TEXT,
  original_title TEXT,
  year        INTEGER,
  rating      REAL,
  genres      TEXT,                     -- JSON 数组字符串
  poster_url  TEXT,
  directors   TEXT,
  actors      TEXT,
  plot        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, file_id)
);

CREATE TABLE shares (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  version_id  INTEGER,
  expires_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
