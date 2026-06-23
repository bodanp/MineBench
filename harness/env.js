// ─────────────────────────────────────────────
// ENV — make a run reproducible by applying the task's setup to the world.
//
// OWNER: Harness / Runner (Role 1), with per-task values from Tasks (Role 5).
//
// Applies gamerules / time / weather / spawn / starting inventory via chat commands.
// REQUIRES the bot to be OP on the server (run `/op MineBenchBot` once, server-side).
// If the bot is not op, the commands are silently ignored by the server.
//
// IMPORTANT: when `clear_inventory` is set we VERIFY the inventory actually emptied. The
// server persists a player's inventory across reconnects, so a leftover item from a previous
// run (e.g. a stone_pickaxe) would otherwise satisfy the task the instant the run starts.
// ─────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const { readInventory } = require('../agent/observation')

async function send(bot, cmds, gap = 150) {
  for (const c of cmds) { bot.chat(c); await sleep(gap) }
}

// Re-issue `/clear` until the inventory is actually empty (or we give up). Returns true only
// when the client confirms an empty inventory — so the caller can detect a failed reset
// (typically: the bot is not OP, so the command is silently ignored by the server).
async function clearInventory(bot, attempts = 3, perAttemptMs = 1500) {
  for (let a = 0; a < attempts; a++) {
    bot.chat(`/clear ${bot.username}`)
    const deadline = Date.now() + perAttemptMs
    while (Date.now() < deadline) {
      await sleep(100)
      if (Object.keys(readInventory(bot)).length === 0) return true
    }
  }
  return Object.keys(readInventory(bot)).length === 0
}

async function applyTaskSetup(bot, task, log = () => {}) {
  const s = (task && task.setup) || {}

  const pre = []
  pre.push(`/attribute ${bot.username} minecraft:scale base set 0.9999999`)
  for (const [rule, val] of Object.entries(s.gamerules || {})) pre.push(`/gamerule ${rule} ${val}`)
  if (s.time) pre.push(`/time set ${s.time}`)
  if (s.weather) pre.push(`/weather ${s.weather}`)
  if (Array.isArray(s.teleport)) {
    const [x, y, z] = s.teleport
    pre.push(`/tp ${bot.username} ${x} ${y} ${z}`)
  } else if (s.teleport === 'spawn') {
    // Drop the bot on the world spawn — always a safe surface spot, no Y guessing.
    const sp = bot.spawnPoint
    if (sp) pre.push(`/tp ${bot.username} ${sp.x} ${sp.y} ${sp.z}`)
  }
  await send(bot, pre)

  // Clear FIRST and confirm it took effect, BEFORE giving any starting items.
  let cleared = true
  if (s.clear_inventory !== false) {
    cleared = await clearInventory(bot)
    if (!cleared) {
      log(`⚠ Inventory did NOT clear. Is the bot OP? Run "/op ${bot.username}" on the server — non-OP players have setup commands (clear/tp/gamerule) silently ignored, so leftover items from a previous run can make a task succeed instantly.`)
    } else {
      log('Inventory cleared.')
    }
  }

  // Starting inventory is applied AFTER the clear.
  const give = []
  for (const g of (s.give || [])) give.push(`/give ${bot.username} ${g.item} ${g.count || 1}`)
  if (give.length) { await send(bot, give); await sleep(300) }

  log(`Applied setup for task "${task.id}".`)
  return { cleared }
}

module.exports = { applyTaskSetup, clearInventory }
