#!/usr/bin/env node
// ─────────────────────────────────────────────
// bench.js — MineBench CLI entry point.
//
// Usage:
//   node bench.js --task stone_pickaxe --model gpt-4.1-mini
//   node bench.js --task gather_wood
//   node bench.js "Make a stone_pickaxe from scratch."   (ad-hoc goal, no scoring spec)
//   node bench.js --goal "Mine 3 oak_log" --model gpt-4.1
//
// Flow: load task -> resolve model -> runner.run -> scorer.score -> store.saveResult.
// OWNER: shared entry; thin glue over harness + scoring (Roles 1 & 2).
// ─────────────────────────────────────────────
require('dotenv').config()
const fs = require('fs')
const path = require('path')

const { run } = require('./harness/runner')
const { resolveModel } = require('./agent/models')
const { score } = require('./scoring/scorer')
const { saveResult } = require('./scoring/store')
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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const goal = args.goal && args.goal !== true ? args.goal : args._[0]
  const task = goal ? adHocTask(goal) : loadTask(args.task && args.task !== true ? args.task : 'gather_wood')

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
