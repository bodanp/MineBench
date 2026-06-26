// ─────────────────────────────────────────────
// RUNNER — the benchmark spine. Runs ONE agent against ONE task reproducibly and
// returns a Trace (the data the scorer consumes).
//
// OWNER: Harness / Runner (Role 1). Owns the Trace schema below.
//
// Public API:
//   run({ task, model, log? }) -> Promise<Trace>
//
// Trace shape:
//   {
//     task_id, model, started_at, ended_reason, duration_s, stuck_events, final_state,
//     steps: [ { i, observation, thought, action: {tool,args}|null, result, ok, pos:[x,y,z] } ]
//   }
//
// The loop: buildObservation -> (oscillation nudge) -> agent.act -> executeAction ->
//           record step -> checkSuccess. Success is detected by the HARNESS, not trusted
//           from the model's stop().
// ─────────────────────────────────────────────
require('dotenv').config()
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')

const { buildObservation, readInventory } = require('../agent/observation')
const { TOOL_SCHEMAS, executeAction } = require('../agent/skills')
const { createAgent } = require('../agent/brain')
const { applyTaskSetup } = require('./env')
const { checkSuccess } = require('../scoring/scorer')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// UNSTUCK ASSISTANCE DISABLED — the oscillation "stuck" nudge that told the agent to
// change strategy when it stopped making progress has been commented out.
// const STUCK_NUDGE = `\n\n⚠️ STUCK: over the last 8 steps you barely moved — you are looping, not progressing. STOP repeating your last action. Do something DIFFERENT now: if "surroundings.block_in_front" is not air, mine_block it to clear the way; otherwise move_to a point at least 20 blocks away in a new direction, or look_around. Do NOT reuse a coordinate you already tried.`

function createBot() {
  const bot = mineflayer.createBot({
    host: process.env.MC_SERVER_HOST || 'localhost',
    port: parseInt(process.env.MC_SERVER_PORT || '25565'),
    username: process.env.MC_BOT_USERNAME || process.env.BOT_NAME || 'MineBenchBot',
    auth: 'offline',
    version: '1.21.11'
  })
  bot.loadPlugin(pathfinder)
  return bot
}

function waitForSpawn(bot, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      bot.removeListener('spawn', onSpawn)
      bot.removeListener('error', onErr)
      bot.removeListener('kicked', onErr)
      bot.removeListener('end', onErr)
    }
    const onSpawn = () => { cleanup(); resolve() }
    const onErr = (e) => { cleanup(); reject(e instanceof Error ? e : new Error(JSON.stringify(e))) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('spawn timeout')) }, timeoutMs)
    bot.once('spawn', onSpawn)
    bot.once('error', onErr)
    bot.once('kicked', onErr)
    bot.once('end', onErr)
  })
}

async function run({ task, model, log = console.log, verbose = false, onEvent }) {
  const startedMs = Date.now()
  // Optional live event sink (used by the live dashboard). No-op when not provided, so the
  // runner never depends on the dashboard being present.
  const emit = typeof onEvent === 'function' ? onEvent : () => {}
  const trace = {
    task_id: task.id,
    model: model.name,
    started_at: new Date().toISOString(),
    ended_reason: null,
    duration_s: null,
    // stuck_events: 0,   // UNSTUCK ASSISTANCE DISABLED — no longer tracked
    final_state: { inventory: {} },
    steps: []
  }

  const bot = createBot()

  // Harness-owned kill tracking: record the username of any PLAYER that actually dies (the
  // server's entityDead packet), so a "killed_player" task can be scored from real world state
  // rather than the model's claim. A Set de-dupes repeated death packets.
  const killedPlayers = new Set()
  // Mob kills, counted per type (e.g. { zombie: 3 }). With doMobSpawning off and a fixed set
  // summoned by the task, an entityDead for a mob is a kill the bot is responsible for.
  const killedEntities = {}
  bot.on('entityDead', (e) => {
    if (!e) return
    if (e.type === 'player' && e.username && e.username !== bot.username) {
      killedPlayers.add(e.username)
    } else if (e.type === 'mob' && e.name && bot._mbAttacked && bot._mbAttacked.has(e.id)) {
      // Only count a mob the bot actually swung at — never one that died on its own (burning in
      // daylight, drowning, fall damage), so the kill is genuinely attributable to the agent.
      killedEntities[e.name] = (killedEntities[e.name] || 0) + 1
    }
  })

  // If THIS bot dies, end the task IMMEDIATELY — don't play on. Mineflayer auto-respawns the bot
  // on death, so without this a killed bot would silently come back and keep acting. Checking
  // `botDied` only between steps isn't enough: a long in-flight action (attack_entity / move_to
  // can run up to ~30s) would let the respawned bot keep fighting before the loop notices. So we
  // also disconnect right here in the handler, which aborts any in-flight action and prevents the
  // respawn from ever taking another step.
  let botDied = false
  bot.on('death', () => {
    if (botDied) return
    botDied = true
    log('Bot died — disconnecting immediately.')
    try { bot.quit() } catch (_) {}
  })

  // Surface the common anti-cheat movement kick with the fix.
  bot.on('kicked', (reason) => {
    const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
    if (text.includes('invalid_player_movement') || text.includes('moved')) {
      log('Server rejected bot movement (anti-cheat). In the server\'s spigot.yml set:')
      log('  moved-too-quickly-multiplier: 100.0   moved-wrongly-threshold: 5.0   then restart.')
    }
  })

  try {
    await waitForSpawn(bot)
    log(`Spawned. Applying setup for task "${task.id}"...`)
    await sleep(1000)                 // physics warm-up
    await applyTaskSetup(bot, task, log)
    await sleep(500)

    const agent = createAgent({ model, goal: task.goal, toolSchemas: TOOL_SCHEMAS })
    agent.start()

    const maxSteps = task.max_steps || 60
    emit({ type: 'run_start', task_id: task.id, title: task.title || task.id, model: model.name, goal: task.goal, max_steps: maxSteps, started_at: trace.started_at })
    // UNSTUCK ASSISTANCE DISABLED — position history / cooldown for oscillation detection.
    // const posHistory = []
    // let stuckCooldown = 0
    let endReason = 'max_steps'

    for (let step = 0; step < maxSteps; step++) {
      if (botDied) { endReason = 'died'; break }
      if (!bot.entity) { endReason = 'disconnected'; break }

      const obs = buildObservation(bot)

      // UNSTUCK ASSISTANCE DISABLED — oscillation detection that injected STUCK_NUDGE
      // when the bot barely moved over the last 8 steps. The agent now receives no nudge.
      let nudge = ''
      // if (stuckCooldown > 0) stuckCooldown--
      // posHistory.push(bot.entity.position.clone())
      // if (posHistory.length > 8) posHistory.shift()
      // if (posHistory.length === 8 && stuckCooldown === 0) {
      //   const net = posHistory[0].distanceTo(posHistory[posHistory.length - 1])
      //   if (net < 4) { trace.stuck_events++; stuckCooldown = 4; nudge = STUCK_NUDGE; log('Oscillation detected — nudging agent.') }
      // }

      let decision
      try {
        decision = await agent.act(obs, nudge)
      } catch (e) {
        log('LLM call failed:', e.message)
        endReason = 'llm_error'
        break
      }

      const pos = [+bot.entity.position.x.toFixed(1), +bot.entity.position.y.toFixed(1), +bot.entity.position.z.toFixed(1)]

      if (decision.done) {
        trace.steps.push({ i: step + 1, observation: obs, thought: decision.thought, action: null, result: decision.reason || 'no action', ok: false, pos })
        emit({ type: 'step', i: step + 1, max_steps: maxSteps, thought: decision.thought, action: null, result: decision.reason || 'no action', ok: false, pos, inventory: readInventory(bot) })
        if (verbose && decision.thought) log(`   thought: ${decision.thought}`)
        endReason = decision.reason === 'no_tool_call' ? 'no_tool_call' : 'agent_stop'
        break
      }

      const { result, ok, done } = await executeAction(bot, { tool: decision.tool, args: decision.args })
      agent.recordResult(decision.toolCallId, result)
      trace.steps.push({
        i: step + 1, observation: obs, thought: decision.thought,
        action: { tool: decision.tool, args: decision.args }, result, ok, pos
      })
      if (verbose && decision.thought) log(`   thought: ${decision.thought}`)
      log(`step ${step + 1}: ${decision.tool}(${JSON.stringify(decision.args)}) -> ${result}`)
      emit({ type: 'step', i: step + 1, max_steps: maxSteps, thought: decision.thought, action: { tool: decision.tool, args: decision.args }, result, ok, pos, inventory: readInventory(bot) })

      // Harness-owned success detection (don't trust the model's stop()).
      if (checkSuccess({ inventory: readInventory(bot), killed_players: [...killedPlayers], killed_entities: killedEntities }, task)) { endReason = 'success'; break }
      if (botDied) { endReason = 'died'; break }
      if (done) { endReason = 'agent_stop'; break }
    }

    // The bot "survived" only if the run went the full distance without dying/disconnecting —
    // bailing early via stop() (agent_stop) does not count as surviving the night.
    const survived = endReason === 'max_steps'
    trace.final_state = { inventory: readInventory(bot), killed_players: [...killedPlayers], killed_entities: killedEntities, survived }
    // Survival (and a kill landed on the very last step) can only be confirmed after the loop, so
    // give checkSuccess one final say before we freeze ended_reason.
    if (endReason !== 'success' && checkSuccess(trace.final_state, task)) endReason = 'success'
    trace.ended_reason = endReason
    emit({ type: 'run_end', ended_reason: endReason, duration_s: +((Date.now() - startedMs) / 1000).toFixed(1), final_inventory: trace.final_state.inventory })
  } catch (e) {
    // A death that aborts an in-flight action (we call bot.quit() the instant the bot dies) can
    // surface here as a thrown error — attribute it to the death, not a generic 'error'.
    if (botDied) {
      trace.ended_reason = 'died'
    } else {
      log('Run error:', e.message)
      trace.ended_reason = trace.ended_reason || 'error'
    }
  } finally {
    trace.duration_s = +((Date.now() - startedMs) / 1000).toFixed(1)
    try { bot.quit() } catch (_) {}
  }

  return trace
}

module.exports = { run, createBot }
