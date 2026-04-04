import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Co-Atrium API is running' 
  })
})

app.listen(PORT, () => {
  console.log(`🏗️  Co-Atrium API running on port ${PORT}`)
})

export default app