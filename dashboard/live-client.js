// ─────────────────────────────────────────────
// LIVE CLIENT — forwards runner events to the live dashboard server (dashboard/live-server.js).
//
// OWNER: Dashboard & Demo (Role 6)
//
// createLiveEmitter() returns an `emit(event)` function the bench process passes to
// runner.run({ onEvent }). It fire-and-forgets a POST to the live server's /ingest endpoint
// using only Node's built-in http (no deps). If no server is running it fails fast and
// SILENTLY — the benchmark must never break or slow down just because nobody is watching.
//
// Config:
//   MINEBENCH_LIVE=0          disable entirely
//   MINEBENCH_LIVE_URL=...    full base URL (default http://127.0.0.1:<port>)
//   MINEBENCH_LIVE_PORT=8099  port when URL not given
//   MINEBENCH_LANE=A|B        tags every event with its lane so two H2H children don't
//                             clobber each other on the server (defaults to 'A' / single).
//
// emit() returns a Promise that resolves once the request settles, so the caller can
// `await` the FINAL event (run_scored) before process.exit to guarantee it flushes.
// ─────────────────────────────────────────────
const http = require('http')

const DEFAULT_PORT = 8099

function liveBaseUrl() {
  if (process.env.MINEBENCH_LIVE_URL) return process.env.MINEBENCH_LIVE_URL
  return `http://127.0.0.1:${process.env.MINEBENCH_LIVE_PORT || DEFAULT_PORT}`
}

function createLiveEmitter(opts = {}) {
  if (process.env.MINEBENCH_LIVE === '0') return () => Promise.resolve()

  // Which H2H lane this process drives. Stamped onto every event so the live server can keep
  // two side-by-side runs separate. Single runs are lane 'A'.
  const lane = opts.lane || process.env.MINEBENCH_LANE || 'A'

  let target
  try { target = new URL('/ingest', opts.url || liveBaseUrl()) } catch { return () => Promise.resolve() }

  return function emit(event) {
    // Tag the event with its lane (without clobbering an explicit one a caller already set).
    const payload = (event && typeof event === 'object' && event.lane == null)
      ? { ...event, lane }
      : event
    return new Promise((resolve) => {
      let settled = false
      const done = () => { if (!settled) { settled = true; resolve() } }
      try {
        const body = Buffer.from(JSON.stringify(payload))
        const req = http.request({
          hostname: target.hostname,
          port: target.port || DEFAULT_PORT,
          path: target.pathname,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': body.length },
          timeout: 1500
        }, (res) => { res.on('data', () => {}); res.on('end', done) })
        req.on('error', done)          // server not up — ignore
        req.on('timeout', () => { req.destroy(); done() })
        req.write(body)
        req.end()
      } catch (_) { done() }
    })
  }
}

module.exports = { createLiveEmitter, liveBaseUrl, DEFAULT_PORT }
