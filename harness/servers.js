#!/usr/bin/env node
// ─────────────────────────────────────────────
// SERVERS — standalone launcher to keep the Minecraft server(s) warm.
//
// OWNER: Harness / Runner (Role 1).
//
// Boots the server instance(s) and HOLDS them in the foreground so they stay warm across many
// benchmark runs. Ctrl+C stops them cleanly. With this running, `npm run bench` just adopts the
// already-open port (instant) instead of cold-booting a server each time.
//
// Usage:
//   node harness/servers.js up [A|B|both]      # start + hold (default: A)
//   node harness/servers.js reset [A|B|both]   # wipe world(s), regenerate from seed, then hold
//   node harness/servers.js down               # stop servers this process can see
//
// Config (env): MINEBENCH_SEED, MINEBENCH_JAVA, MINEBENCH_JAVA_ARGS,
//               MINEBENCH_SERVER_A_DIR / _B_DIR, MINEBENCH_SERVER_A_PORT / _B_PORT.
// ─────────────────────────────────────────────
require('dotenv').config()
const sm = require('./server-manager')

function keysFromArg(which) {
  const w = String(which || 'A').toUpperCase()
  return w === 'BOTH' ? ['A', 'B'] : [w]
}

async function main() {
  const cmd = (process.argv[2] || 'up').toLowerCase()
  const keys = keysFromArg(process.argv[3])

  if (cmd === 'down') {
    await sm.stopAll()
    console.log('Stopped servers started by this process. (Orphaned servers from other processes are not affected.)')
    process.exit(0)
  }

  if (cmd === 'reset') {
    console.log(`Resetting + respinning: ${keys.join(', ')} (seed "${sm.DEFAULT_SEED}")`)
    await sm.resetAndRestart(keys)
  } else if (cmd === 'up') {
    for (const k of keys) await sm.ensureServer(k)
  } else {
    console.error(`Unknown command "${cmd}". Use: up | reset | down`)
    process.exit(1)
  }

  const ports = keys.map(k => sm.SERVERS[k].port).join(', ')
  console.log(`\n✅ Servers warm: ${keys.join(', ')} (ports ${ports}). Press Ctrl+C to stop them.\n`)

  const shutdown = async () => {
    console.log('\nStopping servers...')
    try { await sm.stopAll() } catch (_) {}
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  setInterval(() => {}, 1 << 30)   // keep the event loop alive
}

main().catch(e => { console.error(e.message); process.exit(1) })
