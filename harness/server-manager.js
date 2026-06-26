// ─────────────────────────────────────────────
// SERVER MANAGER — lifecycle for the Minecraft (Paper) server instance(s).
//
// OWNER: Harness / Runner (Role 1).
//
// Lets the dashboard / CLI auto-launch the server(s) before a run, keep them warm across
// runs, and reset the worlds for a clean, reproducible, same-seed regeneration.
//
//   prepareForRun({mode, world, reset}) -> [{port, username}]   ← the one call the UI/CLI uses
//   ensureServer(key)        -> provision (clone if missing) + boot/adopt + wait for the port
//   ensureOpped(key, names)  -> guarantee usernames are operators (for same-world H2H)
//   resetAndRestart(keys)    -> wipe world(s) + reboot (the "clean reset" action)
//   stopServer(port) / stopAll()
//
// prepareForRun hides all of the above: provisioning, adopt-or-boot, reset, and op management.
// Two instances share one fixed seed, so each bot gets an identical but independent world.
// ─────────────────────────────────────────────
const { spawn, spawnSync } = require('child_process')
const net = require('net')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const DEFAULT_SEED = process.env.MINEBENCH_SEED || '6720193'
const JAVA = process.env.MINEBENCH_JAVA || 'java'
const JAVA_ARGS = (process.env.MINEBENCH_JAVA_ARGS || '-Xms1G -Xmx2G').split(/\s+/).filter(Boolean)

// Bot usernames. Singleplayer and different-world H2H reuse one (already-op) name because the
// bots are on separate servers; same-world H2H needs two distinct names (one server can't host
// the same username twice) — those get auto-opped when needed.
const USERNAME = process.env.MC_BOT_USERNAME || 'MineBenchBot'
const USERNAME_A = process.env.MC_BOT_USERNAME_A || 'MineBenchBotA'
const USERNAME_B = process.env.MC_BOT_USERNAME_B || 'MineBenchBotB'

// Server instances. B's dir derives from A's (so an env override of A moves B with it); ports
// and dirs are all individually overridable so this isn't machine-specific.
const A_DIR = process.env.MINEBENCH_SERVER_A_DIR || 'C:\\hackathon\\minebench-server'
const SERVERS = {
  A: { dir: A_DIR, port: parseInt(process.env.MINEBENCH_SERVER_A_PORT || '25565', 10) },
  B: { dir: process.env.MINEBENCH_SERVER_B_DIR || `${A_DIR}-b`, port: parseInt(process.env.MINEBENCH_SERVER_B_PORT || '25566', 10) }
}

// port -> { proc, dir, key }. Only servers WE started are tracked here.
const procs = new Map()

function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host })
    sock.setTimeout(1000)
    const done = (v) => { try { sock.destroy() } catch (_) {} resolve(v) }
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

async function waitForPort(port, { timeoutMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true
    await sleep(1000)
  }
  return false
}

// Keep server.properties in sync with the managed seed/port so a regenerated world is
// always the same terrain regardless of what the file said before.
function patchProps(dir, port, seed) {
  const f = path.join(dir, 'server.properties')
  let txt = fs.readFileSync(f, 'utf8')
  txt = txt.replace(/^level-seed=.*$/m, `level-seed=${seed}`)
           .replace(/^server-port=.*$/m, `server-port=${port}`)
           .replace(/^query\.port=.*$/m, `query.port=${port}`)
  fs.writeFileSync(f, txt)
}

function waitForExit(proc, timeoutMs) {
  if (proc.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs)
    proc.once('exit', () => { clearTimeout(t); resolve(true) })
  })
}

// Offline-mode UUID — matches the server's own derivation (Java nameUUIDFromBytes of
// "OfflinePlayer:<name>"), so an ops.json entry we write is recognized for that bot.
function offlineUuid(name) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  md5[6] = (md5[6] & 0x0f) | 0x30   // version 3
  md5[8] = (md5[8] & 0x3f) | 0x80   // IETF variant
  const h = md5.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// Make sure each name is an operator (level 4) in the server's ops.json. Takes effect at boot;
// for an already-running server we also issue a live `op` so same-world bots can run setup now.
function ensureOpped(key, names, { log = console.log } = {}) {
  const { dir, port } = SERVERS[key]
  const f = path.join(dir, 'ops.json')
  let ops = []
  try { ops = JSON.parse(fs.readFileSync(f, 'utf8')) } catch (_) {}
  const have = new Set(ops.map(o => String(o.name || '').toLowerCase()))
  let changed = false
  for (const name of names) {
    if (!have.has(name.toLowerCase())) {
      ops.push({ uuid: offlineUuid(name), name, level: 4, bypassesPlayerLimit: false })
      changed = true
    }
    sendCommand(port, `op ${name}`)   // no-op unless we manage this server's console
  }
  if (changed) { fs.writeFileSync(f, JSON.stringify(ops, null, 2)); log(`Opped ${names.join(', ')} on server ${key}.`) }
}

// Copy server A's folder into a new instance, minus the per-world / disposable dirs, so the
// clone regenerates its own world from the seed on first boot.
function copyServerDir(src, dest) {
  const skip = new Set(['world', 'world_nether', 'world_the_end', 'logs', 'cache'])
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (s) => { const top = path.relative(src, s).split(path.sep)[0]; return !skip.has(top) }
  })
}

// Create instance `key` by cloning A if it isn't on disk yet. Idempotent: returns immediately
// once the instance has a paper.jar. This is what lets a dev pick "different worlds" without
// ever having set up the second server themselves.
function provisionServer(key, { log = console.log } = {}) {
  const cfg = SERVERS[key]
  if (!cfg) throw new Error(`Unknown server "${key}"`)
  if (fs.existsSync(path.join(cfg.dir, 'paper.jar'))) return cfg
  if (!fs.existsSync(path.join(SERVERS.A.dir, 'paper.jar'))) {
    throw new Error(`Cannot provision server ${key}: base server not found at ${SERVERS.A.dir}.`)
  }
  log(`📦 Provisioning server ${key} at ${cfg.dir} (cloning from A)...`)
  copyServerDir(SERVERS.A.dir, cfg.dir)
  patchProps(cfg.dir, cfg.port, DEFAULT_SEED)
  return cfg
}

// Start a server if it isn't already running, then block until its port is accepting
// connections (Paper binds the port near the end of startup). Idempotent + warm-reuse:
// provisions the folder if missing, adopts an already-running server, else cold-boots.
async function ensureServer(key, { log = console.log } = {}) {
  const cfg = provisionServer(key, { log })
  const { dir, port } = cfg

  const existing = procs.get(port)
  if (existing && existing.proc.exitCode === null) return cfg          // we already started it
  if (await isPortOpen(port)) { log(`Server ${key} already up on ${port}.`); return cfg }  // adopt external

  patchProps(dir, port, DEFAULT_SEED)
  log(`🟢 Starting server ${key} (port ${port})...`)
  const proc = spawn(JAVA, [...JAVA_ARGS, '-jar', 'paper.jar', '--nogui'], {
    cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  })
  procs.set(port, { proc, dir, key })
  proc.on('exit', () => { const e = procs.get(port); if (e && e.proc === proc) procs.delete(port) })
  // Surface fatal early failures (bad java, port in use) instead of just timing out.
  proc.stderr.on('data', (d) => { const s = String(d).trim(); if (s) log(`[server ${key}] ${s.split('\n')[0]}`) })

  const ok = await waitForPort(port, { timeoutMs: parseInt(process.env.MINEBENCH_SERVER_BOOT_MS || '180000', 10) })
  if (!ok) {
    await stopServer(port, { log })
    throw new Error(`Server ${key} did not open port ${port} in time.`)
  }
  // Small settle so spawn chunks/console are ready before a bot connects.
  await sleep(2000)
  log(`✅ Server ${key} ready on ${port}.`)
  return cfg
}

function sendCommand(port, cmd) {
  const e = procs.get(port)
  if (e && e.proc.stdin && e.proc.stdin.writable) e.proc.stdin.write(cmd.replace(/\n?$/, '\n'))
}

async function stopServer(port, { log = console.log } = {}) {
  const e = procs.get(port)
  if (!e) return
  log(`🛑 Stopping server on ${port}...`)
  try { e.proc.stdin.write('stop\n') } catch (_) {}
  const exited = await waitForExit(e.proc, 30000)
  if (!exited) { try { e.proc.kill('SIGKILL') } catch (_) {} }
  procs.delete(port)
}

async function stopAll(opts = {}) {
  await Promise.all([...procs.keys()].map((p) => stopServer(p, opts)))
}

async function deleteWorlds(dir, { log = console.log } = {}) {
  for (const w of ['world', 'world_nether', 'world_the_end']) {
    const p = path.join(dir, w)
    for (let attempt = 1; attempt <= 6; attempt++) {
      try { fs.rmSync(p, { recursive: true, force: true }); break }
      catch (e) {
        // On Windows the world dir can stay locked for a moment after the server exits —
        // retry a few times before giving up so a reset reliably wipes it.
        if (attempt === 6) { log(`⚠️ Could not delete ${w} (${e.code || e.message}); world may not regenerate.`); break }
        await sleep(500)
      }
    }
  }
}

// Force-stop whatever is LISTENING on `port` — used to tear down a Minecraft server we ADOPTED
// (port open but not started by us, e.g. an externally-run or orphaned server) so a reset can
// actually wipe its world. We can't send `stop` to a console we don't own, so we kill the PID
// bound to the port. Best-effort + cross-platform; only the listener is targeted (bot clients
// make outbound connections, so they're never matched).
function killProcessOnPort(port, { log = console.log } = {}) {
  try {
    if (process.platform === 'win32') {
      const psCmd = [
        "$ErrorActionPreference='SilentlyContinue';",
        `$ids = Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -ExpandProperty OwningProcess -Unique;`,
        `if (-not $ids) { $ids = netstat -ano | Select-String ':${port}\\s+.*LISTENING' | ForEach-Object { ($_ -split '\\s+')[-1] } | Select-Object -Unique }`,
        "foreach ($id in $ids) { if ($id -and $id -ne '0') { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }"
      ].join(' ')
      spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { stdio: 'ignore' })
    } else {
      const out = spawnSync('sh', ['-c', `lsof -ti tcp:${port} || true`], { encoding: 'utf8' })
      for (const pid of String(out.stdout || '').split(/\s+/).filter(Boolean)) {
        try { process.kill(parseInt(pid, 10), 'SIGKILL') } catch (_) {}
      }
    }
    log(`Force-stopped the server holding port ${port}.`)
  } catch (e) { log(`Could not force-stop port ${port}: ${e.message}`) }
}

// Stop the given servers (to release file locks) and delete their world dirs so the next
// boot regenerates from the fixed seed. A server we started stops gracefully via its console;
// one we only adopted (external/orphaned) is force-stopped by port so the reset still works.
async function resetWorlds(keys, { log = console.log } = {}) {
  for (const key of keys) {
    const { port } = SERVERS[key]
    await stopServer(port, { log })                       // graceful if WE started it
    if (await isPortOpen(port)) {                          // still up => adopted/external/orphaned
      log(`Server ${key} on ${port} wasn't started by us — force-stopping it to reset the world.`)
      killProcessOnPort(port, { log })
      const deadline = Date.now() + 20000
      while (Date.now() < deadline && await isPortOpen(port)) await sleep(500)
      if (await isPortOpen(port)) log(`⚠️ Port ${port} still open; world delete may fail (locked).`)
      else await sleep(1000)                              // settle so Windows releases file handles
    }
  }
  for (const key of keys) { await deleteWorlds(SERVERS[key].dir, { log }); log(`🧹 Reset worlds for server ${key}.`) }
}

async function resetAndRestart(keys, opts = {}) {
  await resetWorlds(keys, opts)
  for (const key of keys) await ensureServer(key, opts)
}

// ─────────────────────────────────────────────
// HIGH-LEVEL: resolve a UI/CLI run config into ready servers + the bots to launch.
//
//   config = { mode: 'single' | 'h2h', world: 'same' | 'different', reset: boolean }
//
// Returns the bot targets to connect — [{ port, username }] — one for single, two for h2h.
// This is the single seam the dashboard/CLI uses: it hides provisioning, adopt-or-boot,
// world reset, and op management entirely from the caller.
// ─────────────────────────────────────────────
async function prepareForRun({ mode = 'single', world = 'different', reset = false } = {}, opts = {}) {
  if (mode !== 'h2h') {
    if (reset) await resetAndRestart(['A'], opts); else await ensureServer('A', opts)
    return [{ port: SERVERS.A.port, username: USERNAME }]
  }

  if (world === 'same') {
    // Both bots in ONE world → one server, two distinct (auto-opped) usernames.
    if (reset) await resetAndRestart(['A'], opts); else await ensureServer('A', opts)
    ensureOpped('A', [USERNAME_A, USERNAME_B], opts)
    return [{ port: SERVERS.A.port, username: USERNAME_A }, { port: SERVERS.A.port, username: USERNAME_B }]
  }

  // Different worlds → two servers sharing the seed (identical but isolated terrain).
  if (reset) await resetAndRestart(['A', 'B'], opts)
  else { await ensureServer('A', opts); await ensureServer('B', opts) }
  return [{ port: SERVERS.A.port, username: USERNAME }, { port: SERVERS.B.port, username: USERNAME }]
}

module.exports = {
  SERVERS, DEFAULT_SEED, USERNAME, USERNAME_A, USERNAME_B,
  prepareForRun, provisionServer, ensureServer, ensureOpped,
  stopServer, stopAll, resetWorlds, resetAndRestart, sendCommand, isPortOpen
}
