// @cloudfiles/shared - Zod schemas（前后端共享的边界验证契约）

import { z } from 'zod';

// ---------- 用户 ----------
export const registerSchema = z.object({
  username: z.string().min(2).max(32).regex(/^[a-zA-Z0-9_-]+$/, '用户名仅允许字母/数字/_-'),
  password: z.string().min(8).max(128),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

// ---------- 文件系统 ----------
export const mkdirSchema = z.object({
  path: z.string().min(1).max(1024),
});
export type MkdirInput = z.infer<typeof mkdirSchema>;

export const removeSchema = z.object({
  path: z.string().min(1).max(1024),
});
export type RemoveInput = z.infer<typeof removeSchema>;

export const moveSchema = z.object({
  src: z.string().min(1).max(1024),
  dest: z.string().min(1).max(1024),
});
export type MoveInput = z.infer<typeof moveSchema>;

// ---------- 上传 ----------
export const uploadCompleteSchema = z.object({
  uploadId: z.string().min(1).max(64),
  filename: z.string().min(1).max(255),
  remotePath: z.string().min(1).max(1024), // 目标目录（/ 或以 / 开头）
  shotAt: z.string().datetime().optional().nullable(),
});
export type UploadCompleteInput = z.infer<typeof uploadCompleteSchema>;

// ---------- 版本 ----------
export const renameVersionSchema = z.object({
  filePath: z.string().min(1).max(1024),
  createdAt: z.string().min(1).max(64),
  name: z.string().max(128).optional().nullable(),
});
export type RenameVersionInput = z.infer<typeof renameVersionSchema>;

export const cleanVersionsSchema = z.object({
  filePath: z.string().min(1).max(1024).optional(),
  target: z.string().min(1).max(64).optional(),
});
export type CleanVersionsInput = z.infer<typeof cleanVersionsSchema>;

// ---------- 分享 ----------
export const shareCreateSchema = z.object({
  filePath: z.string().min(1).max(1024),
  versionId: z.number().int().positive().optional(),
  expiresInHours: z.number().int().min(1).max(720).optional(),
});
export type ShareCreateInput = z.infer<typeof shareCreateSchema>;

// ---------- 响应 DTO ----------
export const fileNodeSchema = z.object({
  id: z.number(),
  name: z.string(),
  type: z.enum(['file', 'folder']),
  createdAt: z.string(),
  modifiedAt: z.string(),
  versions: z
    .array(
      z.object({
        id: z.number(),
        size: z.number(),
        createdAt: z.string(),
        name: z.string().nullable(),
        shotAt: z.string().nullable(),
        isVideo: z.boolean(),
        duration: z.number().nullable(),
        resolution: z.string().nullable(),
      }),
    )
    .optional(),
});
export type FileNode = z.infer<typeof fileNodeSchema>;

export const userSchema = z.object({
  id: z.number(),
  username: z.string(),
});
export type User = z.infer<typeof userSchema>;

// ---------- 通用 ----------
export const DEFAULT_PAGES_MAIN = 'main';
export const DEFAULT_PAGES_DATA = 'data';
