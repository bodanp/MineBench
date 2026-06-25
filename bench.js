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
    max_steps: parseInt(process.env.MAX_STEPS || '60'),
    setup: {
      gamerules: { doDaylightCycle: false, doWeatherCycle: false, doMobSpawning: false, keepInventory: true },
      time: 'day', weather: 'clear', clear_inventory: false
    },
    success: {}   // no automatic success check for free-form goals
  }
}

// Rebuild the CLI args a child single-bot run needs (same task/goal, one model).
function childArgsFor(args, taskId, goal, modelName) {
  const a = ['bench.js']
  if (goal) a.push('--goal', goal)
  else a.push('--task', taskId)
  a.push('--model', modelName)
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

// Open a new console window running one bot, with its username injected via the environment.
// The window uses `cmd /k` so it stays open (logs remain scrollable) after the bot finishes.
function spawnBotWindow({ title, username, childArgs }) {
  const env = { ...process.env, MC_BOT_USERNAME: username }
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
  const usernameA = process.env.MC_BOT_USERNAME_A || 'MineBenchBotA'
  const usernameB = process.env.MC_BOT_USERNAME_B || 'MineBenchBotB'
  // Generous wait: ~step budget at a slow pace, plus spawn/setup buffer. Overridable via env.
  const budgetSteps = Math.max(taskA.max_steps || 60, taskB.max_steps || 60)
  const maxWaitMs = parseInt(process.env.DUAL_WAIT_MS || String(budgetSteps * 15000 + 120000))
  const sinceMs = Date.now()

  const asymmetric = taskA.id !== taskB.id
  console.log(`\n▶ Dual run${asymmetric ? ' (duel)' : ` on task "${taskA.id}"`}:`)
  console.log(`   A: ${modelA}  (username ${usernameA}, task ${taskA.id})`)
  console.log(`   B: ${modelB}  (username ${usernameB}, task ${taskB.id})`)

  closePreviousBotWindows()   // tidy up windows from a previous dual run before opening new ones
  spawnBotWindow({ title: `${BOT_WINDOW_PREFIX}-A: ${modelA}`, username: usernameA, childArgs: childArgsFor(args, taskA.id, goal, modelA) })
  spawnBotWindow({ title: `${BOT_WINDOW_PREFIX}-B: ${modelB}`, username: usernameB, childArgs: childArgsFor(args, taskB.id, goal, modelB) })

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
  const goal = args.goal && args.goal !== true ? args.goal : args._[0]
  const task = goal ? adHocTask(goal) : loadTask(args.task && args.task !== true ? args.task : 'gather_wood')

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

  console.log(`\n▶ Running task "${task.id}" with model "${model.name}" (max ${task.max_steps} steps)\n`)
  // Live dashboard sink: streams run_start/step/run_end to dashboard/live-server.js if it's
  // running (no-op otherwise). Start it with `npm run dashboard:live` to watch live.
  const emit = createLiveEmitter()
  const trace = await run({ task, model, verbose: args.verbose === true, onEvent: emit })
  const card = score(trace, task)

  console.log('\n📊 ── Scorecard ──')
  for (const [k, v] of Object.entries(card)) console.log(`   ${k}: ${v}`)

  const file = saveResult(card, trace)
  console.log(`\nSaved result -> ${path.relative(__dirname, file)}`)
  // Await the final event so it flushes to the live server before we exit.
  await emit({ type: 'run_scored', scorecard: card })
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
