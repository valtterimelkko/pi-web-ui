import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';

// Auth schemas
export const loginSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

// Session schemas
export const newSessionSchema = z.object({
  cwd: z.string().optional(),
  name: z.string().max(100).optional(),
});

export const switchSessionSchema = z.object({
  sessionPath: z.string().min(1, 'Session path is required'),
});

// Message schemas
export const promptSchema = z.object({
  sessionId: z.string().min(1, 'Session ID is required'),
  message: z.string().min(1, 'Message is required').max(100000, 'Message too long'),
  images: z.array(z.object({
    type: z.literal('image'),
    data: z.string(),
    mimeType: z.string(),
  })).optional(),
});

export const steerSchema = z.object({
  message: z.string().min(1).max(10000),
});

export const followUpSchema = z.object({
  message: z.string().min(1).max(10000),
});

// File schemas
export const browseSchema = z.object({
  path: z.string().min(1).max(1000),
});

export const readFileSchema = z.object({
  path: z.string().min(1).max(1000),
  offset: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

// Extension UI response schemas
export const extensionUiResponseSchema = z.object({
  id: z.string().min(1),
  method: z.enum(['select', 'confirm', 'input', 'editor']),
  value: z.unknown().optional(),
  confirmed: z.boolean().optional(),
  cancelled: z.boolean().optional(),
});

// Validation middleware factory
export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: 'Validation error',
        details: result.error.issues,
      });
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      res.status(400).json({
        error: 'Validation error',
        details: result.error.issues,
      });
      return;
    }
    req.query = result.data as Record<string, string>;
    next();
  };
}
