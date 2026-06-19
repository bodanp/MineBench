require('dotenv').config()
const mineflayer = require('mineflayer')

const bot = mineflayer.createBot({
  host: process.env.MC_SERVER_HOST || 'localhost',
  port: parseInt(process.env.MC_SERVER_PORT || '25565'),
  username: process.env.MC_BOT_USERNAME || 'MineBenchBot',
  auth: 'offline',
  version: '1.21.11'
})

bot.once('spawn', () => {
  console.log('✅ Spawned at:', bot.entity.position)
  bot.chat('MineBench bot online.')

  setTimeout(() => {
    console.log('Walking forward (will continue for 30s)...')
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)  // jump over obstacles
    
    setTimeout(() => {
      bot.setControlState('forward', false)
      bot.setControlState('jump', false)
      console.log('Stopped at:', bot.entity.position)
    }, 30000)
  }, 1000)
})

bot.on('chat', (username, message) => {
  if (username === bot.username) return
  console.log(`<${username}> ${message}`)
})

bot.on('error', (err) => console.error('❌ Error:', err))
bot.on('kicked', (reason) => console.error('❌ Kicked:', reason))
bot.on('end', () => console.log('🛑 Disconnected'))