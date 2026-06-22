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

  for (const [rule, val] of Object.entries(s.gamerules || {})) cmds.push(`/gamerule ${rule} ${val}`)
  if (s.time) cmds.push(`/time set ${s.time}`)
  if (s.weather) cmds.push(`/weather ${s.weather}`)
  if (Array.isArray(s.teleport)) {
    const [x, y, z] = s.teleport
    cmds.push(`/tp ${bot.username} ${x} ${y} ${z}`)
  }
  if (s.clear_inventory !== false) cmds.push(`/clear ${bot.username}`)
  for (const g of (s.give || [])) cmds.push(`/give ${bot.username} ${g.item} ${g.count || 1}`)

  for (const c of cmds) {
    bot.chat(c)
    await sleep(150)
  }
  log(`Applied ${cmds.length} setup command(s) for task "${task.id}".`)
  return cmds.length
}

module.exports = { applyTaskSetup }
