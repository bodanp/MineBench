#!/usr/bin/env node
// ─────────────────────────────────────────────
// LIVE SERVER — a tiny built-in-http server that mirrors the currently-running benchmark.
//
// OWNER: Dashboard & Demo (Role 6)
//
// You run `npm run dashboard:live` once and leave it open at http://localhost:8099. Then run
// benchmarks as usual (`npm run bench -- --task ...`); bench.js POSTs live events here and the
// page reflects whatever run is currently active. No build step, no external dependencies.
//
// Endpoints:
//   GET  /            -> dashboard static files (index.html, app.js, live.js, styles.css, data.js)
//   GET  /events      -> Server-Sent Events stream (sends a snapshot of the current run on connect)
//   POST /ingest      -> receive a run event from bench.js, update state, broadcast to clients
//   GET  /state       -> JSON snapshot of the current run (debug / late join)
//
// State machine for a lane's status:
//   launching --(run_awaiting)--> awaiting --(run_start)--> running --(run_end)--> ended --(run_scored)--> done
// Interactive runs pass through 'awaiting' (bot idling for a chat goal); task runs skip it.
// A run carries up to two lanes (A | B) for head-to-head; single runs use lane A only.
// ─────────────────────────────────────────────
// Load .env BEFORE requiring server-manager: it reads MINEBENCH_SERVER_A_DIR/port/etc. at module
// load, and live-server now drives the server lifecycle in-process (not just via child benches).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const sm = require('../harness/server-manager')

const PORT = parseInt(process.env.MINEBENCH_LIVE_PORT || '8099', 10)
const DASH_DIR = __dirname
const REPO_ROOT = path.join(__dirname, '..')
const TASKS_DIR = path.join(REPO_ROOT, 'tasks')
const BENCH_JS = path.join(REPO_ROOT, 'bench.js')
const MODELS_JSON = path.join(DASH_DIR, 'models.json')

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

// ---- live run state -------------------------------------------------------
// Up to two side-by-side lanes. `mode` tells the browser whether to show one panel or two.
let mode = 'single'              // 'single' | 'h2h'
let interactive = false          // standby-then-chat run?
const runs = { A: null, B: null } // per-lane run state, keyed by lane
const clients = new Set()

// The benchmark child process(es) launched from the page. One for single, two for H2H. Each is
// { lane, proc }. Empty when nothing is running.
let benchProcs = []
// Prepared bot targets for the current run — [{ lane, port, username }]. Used by /prompt to relay
// an interactive goal to the right server(s) via the console `say` command.
let runTargets = []
let stoppedByUser = false
let launchOutput = []   // tail of children's stdout/stderr + prep logs, for surfacing failures

function sse(res, event) {
  try { res.write(`data: ${JSON.stringify(event)}\n\n`) } catch (_) {}
}
function broadcast(event) {
  for (const res of clients) sse(res, event)
}

function startRun(e, lane) {
  runs[lane] = {
    lane,
    status: e.type === 'run_awaiting' ? 'awaiting' : 'running',
    task_id: e.task_id || 'unknown',
    title: e.title || e.task_id || 'unknown',
    model: e.model || (runs[lane] && runs[lane].model) || 'model',
    goal: e.goal || '',
    max_steps: e.max_steps || (runs[lane] && runs[lane].max_steps) || null,
    started_at: e.started_at || new Date().toISOString(),
    steps: [],
    latest_inventory: e.inventory || null,
    ended_reason: null,
    duration_s: null,
    final_inventory: null,
    scorecard: null
  }
}

function regenerateHistory() {
  // Refresh dashboard/data.js so the historical view picks up the just-saved result.
  try {
    delete require.cache[require.resolve('./build')]
    require('./build').build()
    return true
  } catch (_) { return false }
}

// ---- launch-from-page: task discovery + child process management ----

function listTasks() {
  let files = []
  try { files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json')) } catch (_) { return [] }
  const tasks = []
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8'))
      if (t && t.id) tasks.push({ id: t.id, title: t.title || t.id, difficulty: t.difficulty ?? null, max_steps: t.max_steps ?? null })
    } catch (_) { /* skip malformed */ }
  }
  return tasks.sort((a, b) => (a.difficulty ?? 99) - (b.difficulty ?? 99) || a.id.localeCompare(b.id))
}

function knownTaskIds() { return new Set(listTasks().map(t => t.id)) }

// Suggested model names: those seen in saved results, plus the configured Azure default.
// Names are normalized (trimmed, stray leading dashes stripped) and de-duped so a malformed
// historical entry (e.g. "-claude-opus-4") can't show up as a separate junk option.
function normalizeModelName(m) {
  return String(m || '').trim().replace(/^-+/, '').trim()
}

function modelSuggestions() {
  const set = new Set()
  try {
    const { loadResults } = require('../scoring/store')
    for (const r of loadResults()) {
      const m = normalizeModelName(r && r.scorecard && r.scorecard.model)
      if (m) set.add(m)
    }
  } catch (_) {}
  return [...set]
}

// The dashboard's model dropdown is driven by dashboard/models.json — a curated list the team
// edits. Each entry is either a plain string or { label, value }; we normalize to { label, value }
// (label = what the user sees, value = the actual --model arg). Read fresh each call so edits to
// the file show up without restarting the server. `default` is the preselected value.
function loadModelsConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(MODELS_JSON, 'utf8'))
    const options = []
    const seen = new Set()
    for (const m of (raw.models || [])) {
      const value = normalizeModelName(typeof m === 'string' ? m : (m && m.value))
      if (!value || seen.has(value)) continue
      seen.add(value)
      const label = (m && typeof m === 'object' && m.label) ? String(m.label) : value
      options.push({ label, value })
    }
    let def = normalizeModelName(raw.default)
    if (def && !seen.has(def)) { options.unshift({ label: def, value: def }); seen.add(def) }
    if (!def) def = options[0] ? options[0].value : ''
    return { default: def, options }
  } catch (_) {
    return { default: '', options: [] }
  }
}

function defaultModel() {
  return loadModelsConfig().default || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o'
}

const isBusy = () => benchProcs.length > 0 ||
  Object.values(runs).some(r => r && (r.status === 'launching' || r.status === 'awaiting' || r.status === 'running'))

const cleanModel = (m) => (m && String(m).trim().slice(0, 200)) || ''

// Surface server-prep progress (cold boot is ~50-60s) to the page so it shows "starting server…"
// instead of looking hung.
function prepLog(msg) {
  const s = String(msg)
  launchOutput.push(s)
  if (launchOutput.length > 80) launchOutput = launchOutput.slice(-80)
  broadcast({ type: 'prep_log', message: s })
}

// Generalized launch. config = { task, mode, model, modelA, modelB, world, reset, interactive }.
// live-server owns the whole server lifecycle so warm-reuse and reset stay consistent across runs
// (its `procs` map persists, unlike a short-lived child). Every mode preps via prepareForRun, then
// spawns pure `--no-server` children that just connect:
//   single (task|interactive) -> prepareForRun({mode:'single', reset}) -> one child
//   h2h    (task|interactive) -> prepareForRun({mode:'h2h', world, reset}) -> two children, one per lane
function launchRun(cfg) {
  if (isBusy()) return { ok: false, code: 409, error: 'A run is already in progress. Stop it first.' }

  const isH2H = cfg.mode === 'h2h'
  const isInteractive = cfg.interactive === true
  const reset = cfg.reset === true
  const world = cfg.world === 'same' ? 'same' : 'different'
  const task = String(cfg.task || '')

  if (!isInteractive && !knownTaskIds().has(task)) return { ok: false, code: 400, error: `Unknown task "${task}".` }

  mode = isH2H ? 'h2h' : 'single'
  interactive = isInteractive
  stoppedByUser = false
  launchOutput = []
  benchProcs = []
  runTargets = []
  runs.A = null
  runs.B = null

  const lanes = isH2H ? ['A', 'B'] : ['A']

  // Placeholder launching state per lane so the UI flips to "busy" immediately.
  for (const lane of lanes) {
    const model = isH2H ? (lane === 'A' ? cfg.modelA : cfg.modelB) : cfg.model
    runs[lane] = {
      lane, status: 'launching',
      task_id: isInteractive ? 'interactive' : task,
      title: isInteractive ? 'Interactive session' : task,
      model: normalizeModelName(model) || defaultModel(),
      goal: '', max_steps: null, started_at: new Date().toISOString(),
      steps: [], latest_inventory: null, ended_reason: null, duration_s: null, final_inventory: null, scorecard: null
    }
  }
  broadcast({ type: 'run_config', mode, interactive, lanes })
  for (const lane of lanes) broadcast({ type: 'run_launching', lane, task_id: runs[lane].task_id, model: runs[lane].model })

  // Prep servers (may take ~a minute on cold boot) off the request path, then spawn children.
  // The UI already shows "launching"; prep_log events narrate progress. live-server does ALL
  // server prep (including reset) so children are pure `--no-server` clients.
  ;(async () => {
    try {
      const targets = isH2H
        ? await sm.prepareForRun({ mode: 'h2h', world, reset }, { log: prepLog })
        : await sm.prepareForRun({ mode: 'single', reset }, { log: prepLog })
      runTargets = targets.map((t, i) => ({ lane: lanes[i], port: t.port, username: t.username }))
      spawnChildren({ cfg, lanes, targets, isH2H, isInteractive })
    } catch (e) {
      for (const lane of lanes) if (runs[lane]) runs[lane].status = 'error'
      broadcast({ type: 'launch_error', message: `Server preparation failed: ${e.message}` })
    }
  })()

  return { ok: true }
}

function spawnChildren({ cfg, lanes, targets, isH2H, isInteractive }) {
  const baseEnv = { ...process.env, MINEBENCH_LIVE_PORT: String(PORT), MINEBENCH_LIVE: '1' }
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i]
    const t = targets[i]
    const model = isH2H ? (lane === 'A' ? cfg.modelA : cfg.modelB) : cfg.model

    const args = [BENCH_JS]
    if (isInteractive) args.push('--interactive')
    else args.push('--task', String(cfg.task))
    const m = cleanModel(model)
    if (m) args.push('--model', m)
    args.push('--no-server')   // live-server already prepared (and reset) the server(s)

    const env = { ...baseEnv, MINEBENCH_LANE: lane, MC_SERVER_PORT: String(t.port), MC_BOT_USERNAME: t.username }

    let proc
    try {
      // No shell: args are passed as an array, so model/task strings can't inject commands.
      proc = spawn(process.execPath, args, { cwd: REPO_ROOT, windowsHide: true, env })
    } catch (e) {
      if (runs[lane]) runs[lane].status = 'error'
      broadcast({ type: 'launch_error', lane, message: `Failed to start lane ${lane}: ${e.message}` })
      continue
    }
    benchProcs.push({ lane, proc })
    wireChild(lane, proc)
  }
}

function wireChild(lane, proc) {
  const capture = (buf) => {
    launchOutput.push(`[${lane}] ${buf.toString()}`)
    if (launchOutput.length > 80) launchOutput = launchOutput.slice(-80)
  }
  if (proc.stdout) proc.stdout.on('data', capture)
  if (proc.stderr) proc.stderr.on('data', capture)

  proc.on('error', (e) => {
    benchProcs = benchProcs.filter(b => b.proc !== proc)
    if (runs[lane]) runs[lane].status = 'error'
    broadcast({ type: 'launch_error', lane, message: `Lane ${lane}: failed to start bench: ${e.message}` })
  })

  proc.on('exit', (code) => {
    benchProcs = benchProcs.filter(b => b.proc !== proc)
    const run = runs[lane]
    if (stoppedByUser) {
      if (run) { run.status = 'stopped'; run.ended_reason = run.ended_reason || 'stopped_by_user' }
      broadcast({ type: 'run_exit', lane, reason: 'stopped' })
    } else if (run && run.status === 'done') {
      // Normal completion — run_scored already finalized it.
    } else if (code && code !== 0) {
      if (run) run.status = 'error'
      const tail = launchOutput.join('').split('\n').filter(Boolean).slice(-8).join('\n')
      broadcast({ type: 'launch_error', lane, message: `Lane ${lane} exited with code ${code}.`, detail: tail })
    } else {
      if (run && run.status !== 'done') run.status = run.status === 'launching' ? 'error' : 'ended'
      broadcast({ type: 'run_exit', lane, reason: 'exited' })
    }
  })
}

// Relay an interactive goal to the idling bot(s). live-server runs `say [GOAL] <text>` on each
// distinct prepared server console; the standby bots receive it as a chat message and start.
// (Only works for servers WE started — an externally-pre-started server can't take console
// commands, so in that case the human types the goal in-game instead.)
function deliverPrompt(goal) {
  const g = String(goal || '').trim().slice(0, 500)
  if (!g) return { ok: false, code: 400, error: 'Empty goal.' }
  if (!interactive) return { ok: false, code: 409, error: 'The current run is not interactive.' }
  const ports = [...new Set(runTargets.map(t => t.port))]
  if (!ports.length) return { ok: false, code: 409, error: 'No interactive server is ready yet.' }
  for (const p of ports) sm.sendCommand(p, `say [GOAL] ${g}`)
  return { ok: true, ports: ports.length }
}

function stopRun() {
  if (!benchProcs.length) return { ok: false, code: 409, error: 'No run is in progress.' }
  stoppedByUser = true
  const snapshot = benchProcs.slice()
  for (const { proc } of snapshot) { try { proc.kill() } catch (_) {} }
  // Safety net: force-terminate any that ignore the first signal. Servers are left warm.
  setTimeout(() => { for (const { proc } of snapshot) { try { if (proc && !proc.killed) proc.kill('SIGKILL') } catch (_) {} } }, 2500)
  return { ok: true }
}

function readJsonBody(req, cb) {
  let body = ''
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy() })
  req.on('end', () => { try { cb(JSON.parse(body || '{}')) } catch (_) { cb(null) } })
}

function handleEvent(e) {
  if (!e || typeof e !== 'object') return
  const lane = e.lane || 'A'
  switch (e.type) {
    case 'run_awaiting':
      startRun(e, lane)   // status -> 'awaiting' (bot idling for a chat goal)
      break
    case 'run_start':
      startRun(e, lane)   // status -> 'running'
      break
    case 'step':
      if (!runs[lane]) startRun({}, lane)
      // De-dupe by step index in case a client races snapshot + broadcast.
      if (!runs[lane].steps.some(s => s.i === e.i)) runs[lane].steps.push(e)
      if (e.inventory) runs[lane].latest_inventory = e.inventory
      break
    case 'run_end':
      if (runs[lane]) {
        // run_end finalizes a running OR still-awaiting (no-goal) lane; never downgrades 'done'.
        if (runs[lane].status === 'running' || runs[lane].status === 'awaiting') runs[lane].status = 'ended'
        runs[lane].ended_reason = e.ended_reason
        runs[lane].error = e.error || null
        runs[lane].duration_s = e.duration_s
        runs[lane].final_inventory = e.final_inventory
      }
      break
    case 'run_scored':
      if (runs[lane]) {
        runs[lane].status = 'done'
        runs[lane].scorecard = e.scorecard
      }
      if (regenerateHistory()) broadcast({ type: 'history_updated' })
      break
    default:
      return
  }
  broadcast(e)
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0])
  if (rel === '/') rel = '/index.html'
  const file = path.normalize(path.join(DASH_DIR, rel))
  if (!file.startsWith(DASH_DIR)) { res.writeHead(403); return res.end('forbidden') }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found') }
    res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream' })
    res.end(buf)
  })
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]

  if (url === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*'
    })
    res.write('retry: 2000\n\n')
    clients.add(res)
    sse(res, { type: 'snapshot', mode, interactive, runs })
    const ping = setInterval(() => { try { res.write(': ping\n\n') } catch (_) {} }, 25000)
    req.on('close', () => { clearInterval(ping); clients.delete(res) })
    return
  }

  if (url === '/ingest' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 5e6) req.destroy() })
    req.on('end', () => { try { handleEvent(JSON.parse(body)) } catch (_) {} res.writeHead(204); res.end() })
    return
  }

  if (url === '/state') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    return res.end(JSON.stringify({ mode, interactive, runs }))
  }

  if (url === '/tasks') {
    const mc = loadModelsConfig()
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    return res.end(JSON.stringify({
      tasks: listTasks(),
      default_model: mc.default || defaultModel(),
      model_options: mc.options,
      models: modelSuggestions(),
      busy: isBusy()
    }))
  }

  if (url === '/run' && req.method === 'POST') {
    return readJsonBody(req, (body) => {
      if (!body) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'Invalid request body.' })) }
      if (body.interactive !== true && !body.task) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'Missing "task".' })) }
      const r = launchRun({
        task: body.task,
        mode: body.mode === 'h2h' ? 'h2h' : 'single',
        model: body.model,
        modelA: body.modelA,
        modelB: body.modelB,
        world: body.world === 'same' ? 'same' : 'different',
        reset: body.reset === true,
        interactive: body.interactive === true
      })
      res.writeHead(r.ok ? 200 : (r.code || 400), { 'content-type': 'application/json' })
      res.end(JSON.stringify(r.ok ? { ok: true } : { error: r.error }))
    })
  }

  if (url === '/prompt' && req.method === 'POST') {
    return readJsonBody(req, (body) => {
      const r = deliverPrompt(body && body.goal)
      res.writeHead(r.ok ? 200 : (r.code || 400), { 'content-type': 'application/json' })
      res.end(JSON.stringify(r.ok ? { ok: true, ports: r.ports } : { error: r.error }))
    })
  }

  if (url === '/stop' && req.method === 'POST') {
    const r = stopRun()
    res.writeHead(r.ok ? 200 : (r.code || 400), { 'content-type': 'application/json' })
    return res.end(JSON.stringify(r.ok ? { ok: true } : { error: r.error }))
  }

  serveStatic(req, res)
})

function openBrowser(url) {
  try {
    const { spawn } = require('child_process')
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
  } catch (_) {}
}

regenerateHistory()   // make sure history is fresh on startup
// Bind to loopback only: this server can spawn benchmark processes, so it must not be
// reachable from the network.
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`
  console.log(`\n  MineBench dashboard  →  ${url}`)
  console.log(`  Pick a task and click Start in the page — or run a benchmark in another terminal.\n`)
  if (process.env.MINEBENCH_NO_OPEN !== '1' && !process.argv.includes('--no-open')) openBrowser(url)
})

// Stop any benchmark children AND the warm Minecraft server(s) we started when the dashboard
// itself shuts down (Ctrl+C). Runs are otherwise left warm for fast reuse — only a full
// dashboard exit tears the servers down.
let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  for (const { proc } of benchProcs) { try { proc.kill() } catch (_) {} }
  try { await sm.stopAll() } catch (_) {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

module.exports = { server, handleEvent }
