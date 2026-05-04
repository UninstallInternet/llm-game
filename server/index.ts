import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { gameRoutes } from './routes/game.js'
import { chatRoutes } from './routes/chat.js'
import { worldRoutes } from './routes/world.js'
import { actionRoutes } from './routes/action.js'
import { eventsRouter, broadcastEvent } from './routes/events.js'
import { requireToken } from './middleware/auth.js'

const app = express()
const PORT = parseInt(process.env.PORT || '3001', 10)

// ─── CORS — restricted to localhost by default ───
const allowedOrigins = process.env.CORS_ORIGIN === '*'
  ? '*'
  : (process.env.CORS_ORIGIN ?? 'http://localhost:5173,http://localhost:3000,http://localhost').split(',').map(o => o.trim())

app.use(cors(
  allowedOrigins === '*'
    ? {}
    : { origin: allowedOrigins, methods: ['GET', 'POST'] }
))

app.use(express.json({ limit: '100kb' }))
app.use('/portraits', express.static(path.join(process.cwd(), 'public', 'portraits')))

// ─── Auth — optional, enabled when API_TOKEN is set ───
app.use('/api/game', requireToken, gameRoutes)
app.use('/api/chat', requireToken, chatRoutes)
app.use('/api/world', requireToken, worldRoutes)
app.use('/api/action', requireToken, actionRoutes)
app.use('/api/events', eventsRouter) // SSE excluded — EventSource can't send headers

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})

export { broadcastEvent }
