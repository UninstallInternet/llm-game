import type { Request, Response, NextFunction } from 'express'

/**
 * Optional API token middleware.
 * If API_TOKEN is set in the environment, all protected routes require
 * an `Authorization: Bearer <token>` header. If unset, this is a no-op.
 */
export function requireToken(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.API_TOKEN
  if (!expected) {
    next()
    return
  }

  const header = req.headers.authorization
  if (header === `Bearer ${expected}`) {
    next()
    return
  }

  res.status(401).json({ success: false, error: 'Unauthorized — set Authorization: Bearer <API_TOKEN>' })
}
