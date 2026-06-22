// ─────────────────────────────────────────────
// OBSERVATION — turns the live world into the structured state the model perceives.
//
// OWNER: Agent: Skills & Movement (Role 3) owns the world-reading;
//        Agent: Brain & Models (Role 4) decides what shape the model needs.
//
// Public API:
//   buildObservation(bot) -> object   (the per-step observation)
//   readInventory(bot)    -> { itemName: count }
// ─────────────────────────────────────────────

// Sparse, important blocks worth reporting WITH coordinates (common blocks like
// dirt/grass/stone are omitted — they're everywhere and findable on demand).
const RADAR_BLOCKS = [
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
  'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'diamond_ore', 'redstone_ore', 'lapis_ore',
  'crafting_table', 'furnace', 'chest', 'water', 'lava'
]

function cardinalFromYaw(yaw) {
  const deg = ((yaw * 180 / Math.PI) % 360 + 360) % 360   // 0=S, 90=W, 180=N, 270=E
  if (deg < 45 || deg >= 315) return 'south'
  if (deg < 135) return 'west'
  if (deg < 225) return 'north'
  return 'east'
}

function compass(dx, dz) {
  const ns = dz > 0.5 ? 'south' : dz < -0.5 ? 'north' : ''
  const ew = dx > 0.5 ? 'east' : dx < -0.5 ? 'west' : ''
  return [ns, ew].filter(Boolean).join('-') || 'here'
}

// What's immediately around the bot, so it can reason about obstacles/steps/drops.
function describeSurroundings(bot) {
  const yaw = bot.entity.yaw
  const fx = Math.round(-Math.sin(yaw))
  const fz = Math.round(Math.cos(yaw))
  const nameAt = (dx, dy, dz) => {
    const b = bot.blockAt(bot.entity.position.offset(dx, dy, dz))
    return b ? b.name : 'unknown'
  }
  const solid = (n) => n !== 'air' && n !== 'cave_air' && n !== 'water' && n !== 'unknown'
  const frontFeet = nameAt(fx, 0, fz)
  const frontHead = nameAt(fx, 1, fz)
  return {
    block_in_front: frontFeet,
    block_in_front_head: frontHead,
    can_step_up: solid(frontFeet) && !solid(frontHead),
    blocked: solid(frontFeet) && solid(frontHead),
    standing_on: nameAt(0, -1, 0),
    above_head: nameAt(0, 2, 0),
    drop_ahead: !solid(frontFeet) && nameAt(fx, -1, fz) === 'air'
  }
}

// A block is only reachable if at least one face touches air/water; otherwise it is
// buried inside solid terrain and pathfinding/mining straight to it will fail.
function isExposed(bot, pos) {
  const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  for (const [dx, dy, dz] of faces) {
    const b = bot.blockAt(pos.offset(dx, dy, dz))
    if (b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'water')) return true
  }
  return false
}

// A coordinate "radar" of the nearest notable resource/hazard of each type. Prefers the
// nearest EXPOSED block (one the bot can actually reach) and tags each with "exposed", so
// the model stops wasting turns pathing to ore buried inside rock.
function nearestResources(bot) {
  const mcData = require('minecraft-data')(bot.version)
  const ids = RADAR_BLOCKS.map(n => mcData.blocksByName[n]?.id).filter(id => id !== undefined)
  const positions = bot.findBlocks({ matching: ids, maxDistance: 32, count: 64 })
  const p = bot.entity.position
  const best = {}
  for (const pos of positions) {
    const b = bot.blockAt(pos)
    if (!b) continue
    const exposed = isExposed(bot, pos)
    const prev = best[b.name]
    // findBlocks is nearest-first. Keep the closest EXPOSED hit; only fall back to a
    // buried one when nothing exposed of that type exists in range.
    if (prev && (prev.exposed || !exposed)) continue
    best[b.name] = {
      at: { x: pos.x, y: pos.y, z: pos.z },
      dist: +p.distanceTo(pos).toFixed(1),
      dir: compass(pos.x - p.x, pos.z - p.z),
      exposed
    }
  }
  return best
}

function readInventory(bot) {
  const inv = {}
  if (!bot || !bot.inventory) return inv
  for (const item of bot.inventory.items()) inv[item.name] = (inv[item.name] || 0) + item.count
  return inv
}

function buildObservation(bot) {
  const p = bot.entity.position
  return {
    position: { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) },
    facing: cardinalFromYaw(bot.entity.yaw),
    health: bot.health,
    food: bot.food,
    on_ground: bot.entity.onGround,
    inventory: readInventory(bot),
    surroundings: describeSurroundings(bot),
    nearby: nearestResources(bot),
    time_of_day: bot.time.timeOfDay
  }
}

module.exports = { buildObservation, readInventory }
