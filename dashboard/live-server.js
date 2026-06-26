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
// State machine for a run's status: running --(run_end)--> ended --(run_scored)--> done.
// run_end never downgrades a run that already reached 'done' (events can race on localhost).
// ─────────────────────────────────────────────
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const PORT = parseInt(process.env.MINEBENCH_LIVE_PORT || '8099', 10)
const DASH_DIR = __dirname
const REPO_ROOT = path.join(__dirname, '..')
const TASKS_DIR = path.join(REPO_ROOT, 'tasks')
const BENCH_JS = path.join(REPO_ROOT, 'bench.js')

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

let currentRun = null
const clients = new Set()

// The benchmark child process launched from the page (one at a time — a single bot can only
// hold one Minecraft connection). benchProc is null when nothing is running.
let benchProc = null
let stoppedByUser = false
let launchOutput = []   // tail of the child's stdout/stderr, for surfacing launch failures

function sse(res, event) {
  try { res.write(`data: ${JSON.stringify(event)}\n\n`) } catch (_) {}
}
function broadcast(event) {
  for (const res of clients) sse(res, event)
}

function startRun(e) {
  currentRun = {
    status: 'running',
    task_id: e.task_id || 'unknown',
    title: e.title || e.task_id || 'unknown',
    model: e.model || 'model',
    goal: e.goal || '',
    max_steps: e.max_steps || null,
    started_at: e.started_at || new Date().toISOString(),
    steps: [],
    latest_inventory: null,
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

function defaultModel() {
  return process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o'
}

const isBusy = () => !!benchProc || !!(currentRun && (currentRun.status === 'launching' || currentRun.status === 'running'))

function launchRun(task, model) {
  if (isBusy()) return { ok: false, code: 409, error: 'A run is already in progress. Stop it first.' }
  if (!knownTaskIds().has(task)) return { ok: false, code: 400, error: `Unknown task "${task}".` }

  const args = [BENCH_JS, '--task', task]
  const cleanModel = (model && String(model).trim().slice(0, 200)) || ''
  if (cleanModel) args.push('--model', cleanModel)

  // Placeholder so the UI flips to "busy" immediately, before the bot finishes connecting.
  stoppedByUser = false
  launchOutput = []
  currentRun = {
    status: 'launching', task_id: task, title: task, model: cleanModel || defaultModel(),
    goal: '', max_steps: null, started_at: new Date().toISOString(),
    steps: [], latest_inventory: null, ended_reason: null, duration_s: null, final_inventory: null, scorecard: null
  }
  broadcast({ type: 'run_launching', task_id: task, model: currentRun.model })

  try {
    // No shell: args are passed as an array, so the model/task strings can't inject commands.
    benchProc = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      windowsHide: true,
      env: { ...process.env, MINEBENCH_LIVE_PORT: String(PORT), MINEBENCH_LIVE: '1' }
    })
  } catch (e) {
    benchProc = null
    currentRun.status = 'error'
    broadcast({ type: 'launch_error', message: e.message })
    return { ok: false, code: 500, error: e.message }
  }

  const capture = (buf) => {
    const text = buf.toString()
    launchOutput.push(text)
    if (launchOutput.length > 40) launchOutput = launchOutput.slice(-40)
  }
  if (benchProc.stdout) benchProc.stdout.on('data', capture)
  if (benchProc.stderr) benchProc.stderr.on('data', capture)

  benchProc.on('error', (e) => {
    benchProc = null
    if (currentRun) currentRun.status = 'error'
    broadcast({ type: 'launch_error', message: `Failed to start bench: ${e.message}` })
  })

  benchProc.on('exit', (code) => {
    benchProc = null
    if (stoppedByUser) {
      if (currentRun) { currentRun.status = 'stopped'; currentRun.ended_reason = currentRun.ended_reason || 'stopped_by_user' }
      broadcast({ type: 'run_exit', reason: 'stopped' })
    } else if (currentRun && currentRun.status === 'done') {
      // Normal completion — run_scored already finalized it. Nothing to do.
    } else if (code && code !== 0) {
      if (currentRun) currentRun.status = 'error'
      const tail = launchOutput.join('').split('\n').filter(Boolean).slice(-8).join('\n')
      broadcast({ type: 'launch_error', message: `Bench exited with code ${code}.`, detail: tail })
    } else {
      if (currentRun && currentRun.status !== 'done') currentRun.status = currentRun.status === 'launching' ? 'error' : 'ended'
      broadcast({ type: 'run_exit', reason: 'exited' })
    }
  })

  return { ok: true }
}

function stopRun() {
  if (!benchProc) return { ok: false, code: 409, error: 'No run is in progress.' }
  stoppedByUser = true
  try { benchProc.kill() } catch (_) {}
  // Safety net: force-terminate if it ignores the first signal.
  const proc = benchProc
  setTimeout(() => { try { if (proc && !proc.killed) proc.kill('SIGKILL') } catch (_) {} }, 2500)
  return { ok: true }
}

function readJsonBody(req, cb) {
  let body = ''
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy() })
  req.on('end', () => { try { cb(JSON.parse(body || '{}')) } catch (_) { cb(null) } })
}

function handleEvent(e) {
  if (!e || typeof e !== 'object') return
  switch (e.type) {
    case 'run_start':
      startRun(e)
      break
    case 'step':
      if (!currentRun) startRun({})
      // De-dupe by step index in case a client races snapshot + broadcast.
      if (!currentRun.steps.some(s => s.i === e.i)) currentRun.steps.push(e)
      if (e.inventory) currentRun.latest_inventory = e.inventory
      break
    case 'run_end':
      if (currentRun) {
        if (currentRun.status === 'running') currentRun.status = 'ended'
        currentRun.ended_reason = e.ended_reason
        currentRun.error = e.error || null
        currentRun.duration_s = e.duration_s
        currentRun.final_inventory = e.final_inventory
      }
      break
    case 'run_scored':
      if (currentRun) {
        currentRun.status = 'done'
        currentRun.scorecard = e.scorecard
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
    sse(res, { type: 'snapshot', run: currentRun })
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
    return res.end(JSON.stringify(currentRun))
  }

  if (url === '/tasks') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    return res.end(JSON.stringify({
      tasks: listTasks(),
      default_model: defaultModel(),
      models: modelSuggestions(),
      busy: isBusy()
    }))
  }

  if (url === '/run' && req.method === 'POST') {
    return readJsonBody(req, (body) => {
      if (!body || !body.task) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'Missing "task".' })) }
      const r = launchRun(String(body.task), body.model)
      res.writeHead(r.ok ? 200 : (r.code || 400), { 'content-type': 'application/json' })
      res.end(JSON.stringify(r.ok ? { ok: true } : { error: r.error }))
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

module.exports = { server, handleEvent }
