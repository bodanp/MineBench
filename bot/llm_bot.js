require('dotenv').config()
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const { AzureOpenAI } = require('openai')
const { DefaultAzureCredential, getBearerTokenProvider } = require('@azure/identity')
const { TOOL_SCHEMAS, TOOL_IMPLS, getObservation } = require('./tools')
const { MINECRAFT_KNOWLEDGE } = require('./knowledge')

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

${MINECRAFT_KNOWLEDGE}

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

Each observation is your senses — READ it before acting:
- "position" + "facing": where you are and which way you're looking.
- "surroundings": the blocks right next to you — "block_in_front", "can_step_up", "blocked" (a 2-tall wall), "standing_on", "above_head", "drop_ahead".
- "nearby": the nearest resources/hazards with coordinates ("at"), "dist" and "dir" — e.g. the closest tree, ore, your crafting_table, water/lava. Use these coordinates with move_to / mine_block instead of wandering blindly.
- "inventory": what you have — track progress and prerequisites here.

Rules:
- Take ONE action at a time, then read the new observation before choosing the next.
- If "nearby" already lists what you need, go to its coordinates. If it is NOT listed, explore first (move_to a point ~15 blocks away, then re-check "nearby") until it appears.
- Respect crafting dependencies: logs -> planks -> sticks; place a crafting_table to make a wooden_pickaxe; mine cobblestone with a pickaxe to make a stone_pickaxe.
- If a tool call returns an error, read it and try a different approach instead of repeating the same call.
- If "surroundings.blocked" is true (a 2-tall wall) or your position barely changes between steps, mine_block the block in front or move_to around it. If "surroundings.can_step_up" is true, use move_forward to hop it. Do not keep repeating the same failing move_to.
- Entities and players are NOT resources or destinations. Never navigate toward a player or your own past position — only travel to block coordinates (from "nearby") or to genuinely new, unexplored areas.
- Never call the same tool with the same arguments twice in a row. If an action did not change your position or inventory, it FAILED — switch strategy (mine the blocking block, or explore a different direction) rather than repeating it.
- Do not claim success early. Call stop() only when the goal item/condition is actually present in your inventory or state.`
    }
  ]

  // Per-run instrumentation — the seed of the MineBench scorecard.
  const metrics = { steps: 0, tool_calls: 0, tool_errors: 0, repeated_actions: 0, stuck_events: 0 }
  const posHistory = []
  let lastActionSig = null
  let stuckCooldown = 0
  let endReason = 'hit max steps'

  const isErrorResult = (r) => /^(Failed|Unknown|No |Could not|Nothing|Tool .* threw)/.test(String(r))

  const summarize = (reason) => {
    const inv = {}
    if (bot.entity) for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count
    log('\n📊 ── MineBench run summary ──')
    log(`   goal:            ${GOAL}`)
    log(`   end reason:      ${reason}`)
    log(`   steps:           ${metrics.steps}/${MAX_STEPS}`)
    log(`   tool calls:      ${metrics.tool_calls} (errors: ${metrics.tool_errors}, repeats: ${metrics.repeated_actions})`)
    log(`   stuck events:    ${metrics.stuck_events}`)
    log(`   final inventory: ${JSON.stringify(inv)}`)
  }

  for (let step = 0; step < MAX_STEPS; step++) {
    if (!bot.entity) {
      log('🔌 No longer connected to the server — ending run.')
      endReason = 'disconnected'
      break
    }
    metrics.steps = step + 1
    const obs = getObservation(bot)
    log(`\n--- Step ${step + 1} ---`)
    log('👀 Observation:', obs)

    // Oscillation/loop detection: if net displacement over the last 8 steps is tiny, the
    // agent is spinning its wheels — force a strategy change instead of looping forever.
    let stuckNudge = ''
    if (stuckCooldown > 0) stuckCooldown--
    posHistory.push(bot.entity.position.clone())
    if (posHistory.length > 8) posHistory.shift()
    if (posHistory.length === 8 && stuckCooldown === 0) {
      const net = posHistory[0].distanceTo(posHistory[posHistory.length - 1])
      if (net < 4) {
        metrics.stuck_events++
        stuckCooldown = 4
        stuckNudge = `\n\n⚠️ STUCK: over the last 8 steps you moved only ${net.toFixed(1)} blocks net — you are looping, not progressing. STOP repeating your last action. Do something DIFFERENT now: if "surroundings.block_in_front" is not air, mine_block it to clear the way; otherwise move_to a point at least 20 blocks away in a new direction, or look_around. Do NOT reuse a coordinate you already tried.`
        log('⚠️ Oscillation detected — nudging the agent to change strategy.')
      }
    }

    messages.push({
      role: 'user',
      content: `Current state:\n${JSON.stringify(obs)}${stuckNudge}\nWhat do you do next?`
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
      endReason = 'LLM call failed'
      break
    }

    const msg = response.choices[0].message
    messages.push(msg)

    if (msg.content) log('💭 LLM thinks:', msg.content)

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      log('⚠️ No tool call. Ending.')
      endReason = 'model sent no tool call'
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

      metrics.tool_calls++
      const sig = `${name}:${JSON.stringify(args)}`
      if (sig === lastActionSig) metrics.repeated_actions++
      lastActionSig = sig

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
      if (isErrorResult(result)) metrics.tool_errors++
      log(`   → ${result}`)

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result
      })

      if (result === '__STOP__') {
        log('🏁 Agent decided to stop.')
        summarize('agent called stop()')
        return
      }
    }
  }

  summarize(endReason)
}

bot.on('error', err => console.error('❌', err))
bot.on('kicked', (reason) => {
  const text = typeof reason === 'string'
    ? reason
    : (reason?.value?.translate?.value || reason?.translate || JSON.stringify(reason))
  console.error('❌ Kicked:', text)
  if (String(text).includes('invalid_player_movement') || String(text).includes('moved')) {
    console.error('   ↳ The server rejected the bot\'s movement (anti-cheat). In the SERVER folder edit spigot.yml ->')
    console.error('      settings.moved-too-quickly-multiplier: 100.0')
    console.error('      settings.moved-wrongly-threshold: 5.0')
    console.error('     then restart the server. This is expected for programmatic bots.')
  }
})