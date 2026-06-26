// ─────────────────────────────────────────────
// ENV — make a run reproducible by applying the task's setup to the world.
//
// OWNER: Harness / Runner (Role 1), with per-task values from Tasks (Role 5).
//
// Applies gamerules / time / weather / spawn / starting inventory via chat commands.
// REQUIRES the bot to be OP on the server (run `/op MineBenchBot` once, server-side).
// If the bot is not op, the commands are silently ignored by the server.
// ─────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function applyTaskSetup(bot, task, log = () => {}) {
  const s = (task && task.setup) || {}
  const cmds = []

  cmds.push(`/attribute ${bot.username} minecraft:scale base set 0.9999999`)
  cmds.push(`/advancement revoke ${bot.username} everything`)
  for (const [rule, val] of Object.entries(s.gamerules || {})) cmds.push(`/gamerule ${rule} ${val}`)
  if (s.time) cmds.push(`/time set ${s.time}`)
  if (s.weather) cmds.push(`/weather ${s.weather}`)
  if (Array.isArray(s.teleport)) {
    const [x, y, z] = s.teleport
    cmds.push(`/tp ${bot.username} ${x} ${y} ${z}`)
  } else if (s.teleport === 'spawn') {
    // Drop the bot on the world spawn — always a safe surface spot, no Y guessing. An optional
    // spawn_offset nudges the bot a few blocks off spawn so two duelists don't start stacked on
    // the same point; give each opposing task an opposite offset to set them apart for a duel.
    const sp = bot.spawnPoint
    if (sp) {
      const [ox, oy, oz] = Array.isArray(s.spawn_offset) ? s.spawn_offset : [0, 0, 0]
      cmds.push(`/tp ${bot.username} ${sp.x + ox} ${sp.y + oy} ${sp.z + oz}`)
    }
  }
  if (s.clear_inventory !== false) cmds.push(`/clear ${bot.username}`)
  for (const g of (s.give || [])) cmds.push(`/give ${bot.username} ${g.item} ${g.count || 1}`)
  // Summon mobs the task needs (e.g. a cow for beef, a sheep for wool) at an offset from the
  // bot, so PvP/attack tasks have a deterministic target instead of waiting on natural spawns.
  // Coordinates are relative (~) to the bot's post-teleport position; each extra copy is nudged
  // one block over so they don't stack on a single spot.
  for (const m of (s.summon || [])) {
    const [dx, dy, dz] = m.offset || [2, 0, 2]
    const entity = m.entity.includes(':') ? m.entity : `minecraft:${m.entity}`
    for (let i = 0; i < (m.count || 1); i++) {
      cmds.push(`/summon ${entity} ~${dx + i} ~${dy} ~${dz}`)
    }
  }

  for (const c of cmds) {
    bot.chat(c)
    await sleep(150)
  }
  log(`Applied ${cmds.length} setup command(s) for task "${task.id}".`)
  return cmds.length
}

module.exports = { applyTaskSetup }
