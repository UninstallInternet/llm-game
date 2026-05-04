import { z } from 'zod'
import type { Request, Response, NextFunction } from 'express'

// ─── Request Schemas ───

export const playerActionSchema = z.object({
  action: z.string().trim().min(1, 'Action cannot be empty').max(500, 'Action too long (max 500 chars)'),
})

export const chatRequestSchema = z.object({
  npcId: z.string().trim().min(1, 'npcId is required').max(100),
  message: z.string().trim().min(1, 'Message cannot be empty').max(1000, 'Message too long (max 1000 chars)'),
})

export const endChatSchema = z.object({
  npcId: z.string().trim().min(1).max(100),
})

export const generateWorldSchema = z.object({
  settingDescription: z.string().trim().min(1, 'settingDescription is required').max(2000, 'Setting description too long (max 2000 chars)'),
  npcCount: z.coerce.number().int().min(1).max(30).default(10),
  locationCount: z.coerce.number().int().min(1).max(20).default(6),
})

export const moveRequestSchema = z.object({
  locationId: z.string().trim().min(1, 'locationId is required').max(100),
})

export const loadGameSchema = z.object({
  saveId: z.string().trim().min(1, 'saveId required').max(100),
})

// ─── Middleware Factory ───

export function validate<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      const firstError = result.error.errors[0]?.message ?? 'Invalid input'
      res.status(400).json({ success: false, error: firstError })
      return
    }
    req.body = result.data
    next()
  }
}
