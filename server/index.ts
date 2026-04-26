import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { gameRoutes } from './routes/game.js'
import { chatRoutes } from './routes/chat.js'
import { worldRoutes } from './routes/world.js'
import { actionRoutes } from './routes/action.js'
import { eventsRouter, broadcastEvent } from './routes/events.js'
import { startSimulation, stopSimulation } from './simulation/engine.js'

const app = express()
const PORT = parseInt(process.env.PORT || '3001', 10)

app.use(cors())
app.use(express.json())

app.use('/api/game', gameRoutes)
app.use('/api/chat', chatRoutes)
app.use('/api/world', worldRoutes)
app.use('/api/action', actionRoutes)
app.use('/api/events', eventsRouter)

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})

export { broadcastEvent }
