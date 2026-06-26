#!/usr/bin/env node
// ─────────────────────────────────────────────
// bench.js — MineBench CLI entry point.
//
// Usage:
//   node bench.js --task stone_pickaxe --model gpt-4.1-mini
//   node bench.js --task gather_wood
//   node bench.js "Make a stone_pickaxe from scratch."   (ad-hoc goal, no scoring spec)
//   node bench.js --goal "Mine 3 oak_log" --model gpt-4.1
//   node bench.js --task gather_wood --model-a gpt-4.1 --model-b copilot/gpt-4o   (two bots, compare)
//
// Flow: load task -> resolve model -> runner.run -> scorer.score -> store.saveResult.
// Dual mode (--model-a + --model-b): spawn two bot windows (one per model) -> compare scorecards.
// OWNER: shared entry; thin glue over harness + scoring (Roles 1 & 2).
// ─────────────────────────────────────────────
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const { run } = require('./harness/runner')
const { resolveModel } = require('./agent/models')
const { score } = require('./scoring/scorer')
const { saveResult, resultFilesForTask, printComparison } = require('./scoring/store')
const { createLiveEmitter } = require('./dashboard/live-client')
const sm = require('./harness/server-manager')

const TASKS_DIR = path.join(__dirname, 'tasks')

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) args[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true
    else args._.push(a)
  }
  return args
}

function loadTask(taskId) {
  const file = path.join(TASKS_DIR, `${taskId}.json`)
  if (!fs.existsSync(file)) {
    const available = fs.existsSync(TASKS_DIR)
      ? fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
      : []
    throw new Error(`Unknown task "${taskId}". Available: ${available.join(', ') || '(none)'}`)
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function adHocTask(goal) {
  return {
    id: 'adhoc',
    title: 'Ad-hoc goal',
    goal,
    max_steps: parseInt(process.env.MAX_STEPS || '60', 10),
    setup: {
      gamerules: { doDaylightCycle: false, doWeatherCycle: false, doMobSpawning: false, keepInventory: true },
      time: 'day', weather: 'clear', clear_inventory: false
    },
    success: {}   // no automatic success check for free-form goals
  }
}

// Interactive standby task: the bot joins, applies a sane minimal setup, and idles "awaiting"
// until a human delivers a goal via chat (see harness/runner waitForGoalViaChat). The goal is
// ad-hoc, so there is no automatic success spec — the outcome is human-judged.
function interactiveTask() {
  return {
    id: 'interactive',
    title: 'Interactive session',
    goal: '',
    max_steps: parseInt(process.env.MAX_STEPS || '60', 10),
    setup: {
      gamerules: { doDaylightCycle: false, doWeatherCycle: false, doMobSpawning: false, keepInventory: true },
      time: 'day', weather: 'clear', clear_inventory: false
    },
    success: {}
  }
}

// Rebuild the CLI args a child single-bot run needs (same task/goal, one model).
// Children always run with --no-server: the parent (dual orchestrator) already ensured the
// servers, so each child just connects to the port injected via MC_SERVER_PORT.
function childArgsFor(args, taskId, goal, modelName) {
  const a = ['bench.js']
  if (goal) a.push('--goal', goal)
  else a.push('--task', taskId)
  a.push('--model', modelName)
  a.push('--no-server')
  if (args.verbose === true) a.push('--verbose')
  return a
}

// Window-title prefix for the bot consoles we spawn — used both to title new windows and to
// find/close leftover ones from a previous dual run.
const BOT_WINDOW_PREFIX = 'MineBenchBot'

// Close any bot consoles left open by a previous dual run (matched by window title), so repeated
// runs don't pile up windows. Matches nothing on the first run (taskkill just returns non-zero).
function closePreviousBotWindows() {
  try {
    spawnSync('taskkill', ['/FI', `WINDOWTITLE eq ${BOT_WINDOW_PREFIX}*`, '/T', '/F'], { stdio: 'ignore' })
  } catch { /* taskkill unavailable or nothing to close — ignore */ }
}

// Open a new console window running one bot, with its username + server port injected via the
// environment. The window uses `cmd /k` so it stays open (logs remain scrollable) after the bot
// finishes.
function spawnBotWindow({ title, username, port, childArgs }) {
  const env = { ...process.env, MC_BOT_USERNAME: username }
  if (port) env.MC_SERVER_PORT = String(port)
  // cmd /c start "<title>" cmd /k node bench.js ...   (Node handles arg quoting)
  const child = spawn('cmd', ['/c', 'start', title, 'cmd', '/k', 'node', ...childArgs], {
    cwd: __dirname, env, windowsHide: false, stdio: 'ignore'
  })
  child.unref()
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// The scorecard stores the model adapter's display name, which for Copilot drops the
// `copilot/` prefix (see agent/models). Normalize the CLI arg the same way so we can pair
// each result file with the model that produced it.
function expectedModelName(cli) {
  return cli && cli.startsWith('copilot/') ? cli.slice('copilot/'.length) : cli
}

// Read a result file's scorecard, or null if it can't be parsed yet (still being written).
function readCard(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).scorecard } catch { return null }
}

// Wait until both sides of a dual run have written a result, then return [cardA, cardB].
// `sides` = [{ taskId, model }, { taskId, model }] — one per bot. Two cases:
//   • different task ids (e.g. a duel: kill_bot_b vs kill_bot_a) -> each side's file is uniquely
//     identified by its task-id prefix, so just take the newest file per task id.
//   • same task id (e.g. both run gather_wood) -> pair by model name, falling back to the two
//     newest files when the names can't be told apart.
// Times out so a crashed child can't hang us forever.
async function waitForResults({ sinceMs, sides, maxWaitMs }) {
  const deadline = Date.now() + maxWaitMs
  const sameTask = sides[0].taskId === sides[1].taskId
  while (Date.now() < deadline) {
    if (sameTask) {
      const files = resultFilesForTask(sides[0].taskId, sinceMs)   // newest first
      if (files.length >= 2) {
        const cards = files.map(readCard).filter(Boolean)
        const nameA = expectedModelName(sides[0].model), nameB = expectedModelName(sides[1].model)
        let cardA = cards.find(c => c.model === nameA)
        let cardB = nameA === nameB
          ? cards.filter(c => c.model === nameB)[1]   // both bots share a model -> second file
          : cards.find(c => c.model === nameB)
        if (!cardA || !cardB) { cardA = cards[1]; cardB = cards[0] }   // name match failed -> two newest
        if (cardA && cardB) return [cardA, cardB]
      }
    } else {
      // Asymmetric: one file per task id. Newest matching each side is unambiguous.
      const filesA = resultFilesForTask(sides[0].taskId, sinceMs)
      const filesB = resultFilesForTask(sides[1].taskId, sinceMs)
      if (filesA.length && filesB.length) {
        const cardA = readCard(filesA[0]), cardB = readCard(filesB[0])
        if (cardA && cardB) return [cardA, cardB]
      }
    }
    await sleep(2000)
  }
  return null
}

async function runDual(args, { taskA, taskB }, goal, modelA, modelB) {
  // Generous wait: ~step budget at a slow pace, plus spawn/setup buffer. Overridable via env.
  // Budget off the LONGER of the two sides so neither bot is cut short on an asymmetric run.
  const maxWaitMs = parseInt(process.env.DUAL_WAIT_MS || String(Math.max(taskA.max_steps || 60, taskB.max_steps || 60) * 15000 + 120000), 10)
  const world = args.world === 'same' ? 'same' : 'different'

  // One call resolves the whole server config: provisions/boots the right server(s), applies the
  // reset, and hands back the [{port, username}] targets for each bot. Same world = one server +
  // two distinct bots; different = two same-seed servers.
  let targets
  if (args.server !== false && args['no-server'] !== true) {
    targets = await sm.prepareForRun({ mode: 'h2h', world, reset: args.reset === true })
  } else {
    targets = [{ port: sm.SERVERS.A.port, username: sm.USERNAME_A }, { port: world === 'same' ? sm.SERVERS.A.port : sm.SERVERS.B.port, username: world === 'same' ? sm.USERNAME_B : sm.USERNAME }]
  }
  const sinceMs = Date.now()

  console.log(`\n▶ Dual run (${world} world):`)
  console.log(`   A: ${modelA}  on "${taskA.id}"  (port ${targets[0].port}, ${targets[0].username})`)
  console.log(`   B: ${modelB}  on "${taskB.id}"  (port ${targets[1].port}, ${targets[1].username})`)

  closePreviousBotWindows()   // tidy up windows from a previous dual run before opening new ones
  spawnBotWindow({ title: `${BOT_WINDOW_PREFIX}-A: ${modelA}`, username: targets[0].username, port: targets[0].port, childArgs: childArgsFor(args, taskA.id, goal, modelA) })
  spawnBotWindow({ title: `${BOT_WINDOW_PREFIX}-B: ${modelB}`, username: targets[1].username, port: targets[1].port, childArgs: childArgsFor(args, taskB.id, goal, modelB) })

  console.log('\nOpened two bot windows. Waiting for both to finish...')
  console.log('(Each window stays open so you can read its logs; close them when done.)')

  const cards = await waitForResults({
    sinceMs,
    sides: [{ taskId: taskA.id, model: modelA }, { taskId: taskB.id, model: modelB }],
    maxWaitMs
  })
  if (!cards) {
    console.error('\nTimed out waiting for both runs to finish. Check the two bot windows for errors.')
    process.exit(1)
  }
  printComparison(cards)
  process.exit(0)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const interactive = args.interactive === true
  const goal = args.goal && args.goal !== true ? args.goal : args._[0]
  const task = interactive
    ? interactiveTask()
    : (goal ? adHocTask(goal) : loadTask(args.task && args.task !== true ? args.task : 'gather_wood'))

  // Dual mode: --model-a X --model-b Y runs two bots (one per model) in their own windows.
  const modelA = args['model-a'] && args['model-a'] !== true ? args['model-a'] : null
  const modelB = args['model-b'] && args['model-b'] !== true ? args['model-b'] : null
  if (modelA && modelB) {
    // Optional per-bot tasks: --task-a / --task-b let the two bots run DIFFERENT tasks, e.g. a
    // duel where bot A is told to kill bot B and bot B is told to kill bot A simultaneously.
    // When omitted, both bots run the shared `task` (the symmetric same-task comparison).
    const taskAId = args['task-a'] && args['task-a'] !== true ? args['task-a'] : null
    const taskBId = args['task-b'] && args['task-b'] !== true ? args['task-b'] : null
    const taskA = taskAId ? loadTask(taskAId) : task
    const taskB = taskBId ? loadTask(taskBId) : task
    return runDual(args, { taskA, taskB }, goal, modelA, modelB)
  }

  let model
  try {
    model = resolveModel(args.model && args.model !== true ? args.model : undefined)
  } catch (e) {
    console.error('Model setup failed:', e.message)
    console.error('Check AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY / AZURE_OPENAI_DEPLOYMENT in .env')
    process.exit(1)
  }

  if (interactive) {
    console.log(`\n▶ Interactive standby with model "${model.name}" — bot will idle until a chat goal arrives (max ${task.max_steps} steps)\n`)
  } else {
    console.log(`\n▶ Running task "${task.id}" with model "${model.name}" (max ${task.max_steps} steps)\n`)
  }

  // Auto-launch server A (adopts it if already running, boots/provisions it if not), unless
  // --no-server. Servers are left warm after the run. Use --reset to wipe + regenerate the world.
  if (args.server !== false && args['no-server'] !== true) {
    try {
      const [target] = await sm.prepareForRun({ mode: 'single', reset: args.reset === true })
      process.env.MC_SERVER_PORT = String(target.port)
      process.env.MC_BOT_USERNAME = target.username
    } catch (e) {
      console.error('Server launch failed:', e.message)
      process.exit(1)
    }
  }

  // Live dashboard sink: streams run_start/step/run_end to dashboard/live-server.js if it's
  // running (no-op otherwise). Start it with `npm run dashboard:live` to watch live.
  const emit = createLiveEmitter()
  const trace = await run({ task, model, verbose: args.verbose === true, onEvent: emit, interactive })
  const card = score(trace, task)

  const fmt = (v) => (v == null ? 'n/a' : Number(v).toFixed(2))
  const cap = card.capabilities || {}
  const d = card.diagnostics || {}
  console.log('\n📊 ── Scorecard ──')
  console.log(`   task: ${card.task_id}   model: ${card.model}`)
  console.log(`   outcome: ${card.success ? 'success' : 'fail'}   progress: ${fmt(card.progress)} (${card.milestones.reached}/${card.milestones.total} milestones)`)
  console.log(`   overall score: ${fmt(card.score)}`)
  console.log('\n   Capability profile (general agentic skills; Minecraft is just the instrument):')
  console.log(`     completion   ${fmt(cap.completion)}   (how far down the dependency chain)`)
  console.log(`     planning     ${fmt(cap.planning)}   (prerequisites before dependents)`)
  console.log(`     tool_use     ${fmt(cap.tool_use)}   (valid actions / preconditions)`)
  console.log(`     adaptation   ${fmt(cap.adaptation)}   (recover after self-caused failure)`)
  console.log(`     robustness   ${fmt(cap.robustness)}   (recover after external disturbance)`)
  console.log(`     efficiency   ${fmt(cap.efficiency)}   (productive-action ratio)`)
  console.log('\n   Diagnostics (not scored): ' +
    `steps=${d.actions} loops=${d.unproductive_loops} agent_errors=${d.agent_errors} ` +
    `env_errors=${d.env_errors} disturbances=${d.disturbance_events} · time=${card.duration_s}s (informational)`)

  const file = saveResult(card, trace)
  console.log(`\nSaved result -> ${path.relative(__dirname, file)}`)
  // Await the final event so it flushes to the live server before we exit.
  await emit({ type: 'run_scored', scorecard: card })
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
