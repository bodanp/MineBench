require('dotenv').config()
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const { AzureOpenAI } = require('openai')
const { DefaultAzureCredential, getBearerTokenProvider } = require('@azure/identity')
const { TOOL_SCHEMAS, TOOL_IMPLS, getObservation } = require('./tools')

const BOT_NAME = process.env.BOT_NAME || 'MineBenchBot'
const DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT
const ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT
const API_KEY = process.env.AZURE_OPENAI_API_KEY    // may be undefined for entra
const USE_ENTRA = process.env.USE_ENTRA === 'true'
const GOAL = process.argv[2] || 'Walk around and explore.'
const MAX_STEPS = parseInt(process.env.MAX_STEPS || '60')

// Build the client based on auth mode
let client
if (USE_ENTRA) {
  console.log(`[${BOT_NAME}] Using Entra ID auth`)
  const credential = new DefaultAzureCredential()
  const azureADTokenProvider = getBearerTokenProvider(
    credential,
    'https://cognitiveservices.azure.com/.default'
  )
  client = new AzureOpenAI({
    endpoint: ENDPOINT,
    azureADTokenProvider,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
    deployment: DEPLOYMENT
  })
} else {
  console.log(`[${BOT_NAME}] Using API key auth`)
  client = new AzureOpenAI({
    endpoint: ENDPOINT,
    apiKey: API_KEY,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
    deployment: DEPLOYMENT
  })
}

const bot = mineflayer.createBot({
  host: process.env.MC_SERVER_HOST || 'localhost',
  port: parseInt(process.env.MC_SERVER_PORT || '25565'),
  username: BOT_NAME,
  auth: 'offline',
  version: '1.21.11'
})

bot.loadPlugin(pathfinder)

// Tag console output with bot name for readability
const log = (...args) => console.log(`[${BOT_NAME}]`, ...args)

bot.once('spawn', async () => {
  log('✅ Spawned at:', bot.entity.position)
  log('🎯 Goal:', GOAL)
  await new Promise(r => setTimeout(r, 1000))  // physics warm-up

  await runAgentLoop()
})

async function runAgentLoop() {
  const messages = [
    {
      role: 'system',
      content: `You are an AI agent playing Minecraft, controlled entirely through tool calls.

Your goal: ${GOAL}

Available tools:
- look_around(): scan nearby blocks and entities
- move_to(x, y, z): pathfind to a coordinate (handles most obstacles automatically)
- move_forward(seconds): walk forward while auto-jumping; use to hop a 1-block step or get unstuck
- mine_block(block_type): walk to and mine the nearest matching block (e.g. "oak_log", "stone")
- place_block(block_type, dx, dy, dz): place a block at an offset from you; use (0,0,0) to pillar up (climb by placing a block beneath yourself)
- craft(item, count): craft an item; some recipes require a crafting_table placed within ~8 blocks
- equip(item): hold an item (equip a pickaxe before mining stone/ore)
- turn(direction), jump(), chat(message)
- stop(): call ONLY when the goal is fully complete or you are truly stuck

Rules:
- Take ONE action at a time. After each action you receive the new world state (position, inventory, health).
- Use the "inventory" field in each observation to track progress and check prerequisites.
- Respect crafting dependencies: logs -> planks -> sticks; place a crafting_table to make a wooden_pickaxe; mine cobblestone with a pickaxe to make a stone_pickaxe.
- If a tool call returns an error, read it and try a different approach instead of repeating the same call.
- If you stop making progress or get jammed against a block (your position barely changes between steps), turn to face it and use move_forward to hop over it, or mine_block the blocking block — do not keep repeating the same move_to.
- Do not claim success early. Call stop() only when the goal item/condition is actually present in your inventory or state.`
    }
  ]

  for (let step = 0; step < MAX_STEPS; step++) {
    const obs = getObservation(bot)
    log(`\n--- Step ${step + 1} ---`)
    log('👀 Observation:', obs)

    messages.push({
      role: 'user',
      content: `Current state:\n${JSON.stringify(obs)}\nWhat do you do next?`
    })

    let response
    try {
      response = await client.chat.completions.create({
        messages,
        tools: TOOL_SCHEMAS,
        tool_choice: 'auto',
        model: process.env.AZURE_OPENAI_DEPLOYMENT
      })
    } catch (e) {
      log('❌ LLM call failed:', e.message)
      break
    }

    const msg = response.choices[0].message
    messages.push(msg)

    if (msg.content) log('💭 LLM thinks:', msg.content)

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      log('⚠️ No tool call. Ending.')
      break
    }

    for (const call of msg.tool_calls) {
      const name = call.function.name
      let args = {}
      try {
        args = JSON.parse(call.function.arguments || '{}')
      } catch {
        args = {}
      }
      log(`🛠️  Tool: ${name}(${JSON.stringify(args)})`)

      const impl = TOOL_IMPLS[name]
      let result
      if (!impl) {
        result = `Unknown tool: ${name}`
      } else {
        try {
          result = await impl(bot, args)
        } catch (e) {
          result = `Tool ${name} threw an error: ${e.message}`
        }
      }
      log(`   → ${result}`)

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result
      })

      if (result === '__STOP__') {
        log('🏁 Agent decided to stop.')
        return
      }
    }
  }

  log('🛑 Hit max steps.')
}

bot.on('error', err => console.error('❌', err))
bot.on('kicked', reason => console.error('❌ Kicked:', reason))