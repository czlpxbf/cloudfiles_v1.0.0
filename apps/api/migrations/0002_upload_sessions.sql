-- 分片上传会话（大文件网页端上传）
-- 进度不落库：以 KV 中已存在分片为准（断点续传查询 KV 即可）
CREATE TABLE IF NOT EXISTS upload_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upload_id   TEXT NOT NULL UNIQUE,        -- uuid（前端断点续传标识）
  filename    TEXT NOT NULL,               -- 原始文件名（部署后作为主文件名）
  remote_path TEXT NOT NULL,               -- 目标目录
  total_size  INTEGER NOT NULL,
  chunk_size  INTEGER NOT NULL,            -- 每片字节数
  total_chunks INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'uploading',  -- uploading | done | expired
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_upload_sessions_user ON upload_sessions(user_id);
