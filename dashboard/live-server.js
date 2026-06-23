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

const PORT = parseInt(process.env.MINEBENCH_LIVE_PORT || '8099', 10)
const DASH_DIR = __dirname

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
server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`
  console.log(`\n  MineBench dashboard  →  ${url}`)
  console.log(`  Leave this running, then in another terminal start a benchmark to watch it live:`)
  console.log(`    npm run bench -- --task gather_wood --model <model>\n`)
  if (process.env.MINEBENCH_NO_OPEN !== '1' && !process.argv.includes('--no-open')) openBrowser(url)
})

module.exports = { server, handleEvent }
