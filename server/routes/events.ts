import { Router } from 'express'
import type { Response } from 'express'
import type { GameEvent } from '../../shared/types.js'

export const eventsRouter = Router()

const clients: Set<Response> = new Set()

eventsRouter.get('/', (req, res) => {
  // SSE can't send headers, so validate token via query param
  const expected = process.env.API_TOKEN
  if (expected) {
    const token = req.query.token as string | undefined
    if (token !== expected) {
      res.status(401).json({ success: false, error: 'Unauthorized — pass ?token=<API_TOKEN>' })
      return
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  clients.add(res)

  req.on('close', () => {
    clients.delete(res)
  })
})

export function broadcastEvent(event: GameEvent): void {
  const data = JSON.stringify(event)
  for (const client of clients) {
    client.write(`data: ${data}\n\n`)
  }
}
