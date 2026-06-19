const { spawn } = require('child_process')
const path = require('path')

const GOAL = process.argv[2] || 'Mine 3 oak_log then craft 4 oak_planks.'

const bots = [
  {
    BOT_NAME: 'GPT41MiniBot',
    AZURE_OPENAI_DEPLOYMENT: 'gpt-4.1-mini',
    AZURE_OPENAI_ENDPOINT: process.env.GPT41_MINI_ENDPOINT,
    AZURE_OPENAI_API_KEY: process.env.GPT41_MINI_API_KEY
  },
  {
    BOT_NAME: 'GPT41NanoBot',
    AZURE_OPENAI_DEPLOYMENT: 'gpt-4.1-nano',
    AZURE_OPENAI_ENDPOINT: process.env.GPT41_NANO_ENDPOINT,
    AZURE_OPENAI_API_KEY: process.env.GPT41_NANO_API_KEY
  }
]

for (const cfg of bots) {
  const child = spawn('node', [path.join(__dirname, 'llm_bot.js'), GOAL], {
    env: { ...process.env, ...cfg },
    stdio: 'inherit'
  })
  child.on('exit', code => console.log(`[${cfg.BOT_NAME}] exited with code ${code}`))
}