const { goals, Movements } = require('mineflayer-pathfinder')

// ─────────────────────────────────────────────
// TOOL SCHEMAS (what the LLM sees)
// ─────────────────────────────────────────────
const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'move_to',
      description: 'Walk/navigate to a specific (x, y, z) coordinate using pathfinding (handles obstacles).',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' }
        },
        required: ['x', 'y', 'z']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_forward',
      description: 'Walk straight forward (the way you are currently facing) for a few seconds, automatically hopping ONCE over any 1-block step in the way. Use this to get over a low obstacle or to get unstuck when move_to / mine_block leaves you jammed against a block. Turn to face the obstacle first.',
      parameters: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: 'How long to walk forward, 1-5. Default 1.5.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mine_block',
      description: 'Find and mine the nearest block of a given type within 32 blocks.',
      parameters: {
        type: 'object',
        properties: {
          block_type: {
            type: 'string',
            description: 'e.g., "oak_log", "stone", "dirt", "coal_ore"'
          }
        },
        required: ['block_type']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'place_block',
      description: 'Place a block from inventory at an offset (dx,dy,dz) relative to your feet. Use offset (0,0,0) to PILLAR UP: jump and place a block directly beneath yourself to climb up by one.',
      parameters: {
        type: 'object',
        properties: {
          block_type: { type: 'string', description: 'Block name from inventory' },
          dx: { type: 'integer', description: 'X offset from bot' },
          dy: { type: 'integer', description: 'Y offset from bot' },
          dz: { type: 'integer', description: 'Z offset from bot' }
        },
        required: ['block_type', 'dx', 'dy', 'dz']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'craft',
      description: 'Craft an item. Needs ingredients in inventory; optionally uses a crafting table.',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'e.g., "oak_planks", "stick", "crafting_table", "wooden_pickaxe"' },
          count: { type: 'integer', default: 1 }
        },
        required: ['item']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'equip',
      description: 'Equip an item from inventory to your hand (e.g. a pickaxe before mining stone/ore).',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'e.g., "wooden_pickaxe"' }
        },
        required: ['item']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'look_around',
      description: 'Scan surroundings: returns nearby blocks of interest and entities.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'turn',
      description: 'Turn the bot to face a cardinal direction.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['north', 'south', 'east', 'west'] }
        },
        required: ['direction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'jump',
      description: 'Jump once.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'chat',
      description: 'Send a message in game chat.',
      parameters: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'stop',
      description: 'End the task. Call when goal is complete OR truly stuck.',
      parameters: { type: 'object', properties: {} }
    }
  }
]

// ─────────────────────────────────────────────
// TOOL IMPLEMENTATIONS
// ─────────────────────────────────────────────
const TOOL_IMPLS = {
  async move_to(bot, { x, y, z }) {
    try {
      await navigate(bot, new goals.GoalNear(x, y, z, 1), { x, y, z })
      return `Reached ${formatPos(bot.entity.position)}`
    } catch (e) {
      return `Failed to reach (${x},${y},${z}): ${e.message}`
    }
  },

  async move_forward(bot, { seconds = 1.5 }) {
    const ms = Math.max(0.1, Math.min(Number(seconds) || 1.5, 5)) * 1000
    const traveled = await walkForwardHopping(bot, ms)
    const note = traveled < 0.5
      ? ' (still blocked — the obstacle may be 2+ blocks tall; turn() to face it, then mine_block it)'
      : ''
    return `Moved forward ${ms / 1000}s, traveled ${traveled} blocks to ${formatPos(bot.entity.position)}${note}`
  },

  async mine_block(bot, { block_type }) {
    const mcData = require('minecraft-data')(bot.version)
    const blockId = mcData.blocksByName[block_type]?.id
    if (blockId === undefined) return `Unknown block: ${block_type}`

    const block = bot.findBlock({ matching: blockId, maxDistance: 32 })
    if (!block) return `No ${block_type} found within 32 blocks.`

    try {
      await navigate(bot, new goals.GoalLookAtBlock(block.position, bot.world), block.position)
      await bot.dig(block)
      return `Mined ${block_type} at ${formatPos(block.position)}`
    } catch (e) {
      // Navigation may have stalled but left us within reach — try digging anyway.
      try {
        if (bot.entity.position.distanceTo(block.position) <= 5) {
          await bot.dig(block)
          return `Mined ${block_type} at ${formatPos(block.position)} (recovered after getting stuck)`
        }
      } catch (_) { /* fall through to the failure message */ }
      return `Failed to mine ${block_type}: ${e.message}`
    }
  },

  async place_block(bot, { block_type, dx, dy, dz }) {
    const item = bot.inventory.items().find(i => i.name === block_type)
    if (!item) return `No ${block_type} in inventory.`

    // Placing into your own feet column means "pillar up": jump and place beneath
    // yourself with the right timing instead of relying on a lucky airborne frame.
    if (dx === 0 && dz === 0 && (dy === 0 || dy === -1)) {
      return pillarUp(bot, item, block_type)
    }

    try {
      await bot.equip(item, 'hand')
      const refBlock = bot.blockAt(bot.entity.position.offset(dx, dy - 1, dz))
      if (!refBlock || refBlock.name === 'air') return `No solid block to place against at offset (${dx},${dy},${dz}).`
      await bot.placeBlock(refBlock, { x: 0, y: 1, z: 0 })
      return `Placed ${block_type} at offset (${dx},${dy},${dz})`
    } catch (e) {
      return `Failed to place ${block_type}: ${e.message}`
    }
  },

  async craft(bot, { item, count = 1 }) {
    const mcData = require('minecraft-data')(bot.version)
    const itemData = mcData.itemsByName[item]
    if (!itemData) return `Unknown item: ${item}`

    const craftingTable = bot.findBlock({
      matching: mcData.blocksByName.crafting_table.id,
      maxDistance: 8
    })
    const recipe = bot.recipesFor(itemData.id, null, count, craftingTable)[0]
    if (!recipe) return `No recipe found for ${item} (need crafting table?).`

    try {
      await bot.craft(recipe, count, craftingTable)
      return `Crafted ${count}x ${item}`
    } catch (e) {
      return `Failed to craft ${item}: ${e.message}`
    }
  },

  async equip(bot, { item }) {
    const i = bot.inventory.items().find(x => x.name === item)
    if (!i) return `No ${item} in inventory.`
    try {
      await bot.equip(i, 'hand')
      return `Equipped ${item}.`
    } catch (e) {
      return `Failed to equip ${item}: ${e.message}`
    }
  },

  async look_around(bot) {
    const nearbyBlocks = {}
    const radius = 8
    for (let dx = -radius; dx <= radius; dx += 2) {
      for (let dz = -radius; dz <= radius; dz += 2) {
        for (let dy = -2; dy <= 2; dy++) {
          const b = bot.blockAt(bot.entity.position.offset(dx, dy, dz))
          if (b && b.name !== 'air' && b.name !== 'cave_air') {
            nearbyBlocks[b.name] = (nearbyBlocks[b.name] || 0) + 1
          }
        }
      }
    }
    // Exclude the bot itself AND other players (including the human) — players are not
    // resources or navigation targets, and surfacing them makes the model chase them.
    const entities = Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.type !== 'player' && e.position && bot.entity.position.distanceTo(e.position) < 16)
      .map(e => ({ type: e.name || e.kind || e.type, dist: +bot.entity.position.distanceTo(e.position).toFixed(1) }))

    return JSON.stringify({ nearby_blocks: nearbyBlocks, entities })
  },

  async turn(bot, { direction }) {
    const yaws = { south: 0, west: Math.PI / 2, north: Math.PI, east: -Math.PI / 2 }
    await bot.look(yaws[direction], 0, true)
    return `Facing ${direction}.`
  },

  async jump(bot) {
    bot.setControlState('jump', true)
    await new Promise(r => setTimeout(r, 400))
    bot.setControlState('jump', false)
    return 'Jumped.'
  },

  async chat(bot, { message }) {
    bot.chat(message)
    return `Said: "${message}"`
  },

  async stop() {
    return '__STOP__'
  }
}

// Jump straight up and place a block under your feet at the apex (pillar up by 1).
// Retries at each apex so a single place_block(0,0,0) call reliably climbs one block.
async function pillarUp(bot, item, name) {
  try {
    await bot.equip(item, 'hand')
    const refBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0))
    if (!refBlock || refBlock.name === 'air') return `Nothing solid below to pillar up from.`
    const baseY = Math.floor(bot.entity.position.y)
    bot.setControlState('jump', true)
    let placed = false
    for (let i = 0; i < 16 && !placed; i++) {
      await new Promise(r => setTimeout(r, 80))
      // Only place once we've risen ~1 block so the new block isn't inside us.
      if (bot.entity.position.y - baseY >= 1.0) {
        try {
          await bot.placeBlock(refBlock, { x: 0, y: 1, z: 0 })
          placed = true
        } catch (_) { /* not at a valid apex yet — keep bouncing and retry */ }
      }
    }
    bot.setControlState('jump', false)
    return placed
      ? `Pillared up: placed ${name} beneath you.`
      : `Could not place ${name} beneath you — try again or move to clearer ground.`
  } catch (e) {
    bot.setControlState('jump', false)
    return `Failed to pillar up with ${name}: ${e.message}`
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// One shared, reusable Movements config (recreating it on every call is wasteful).
function getMovements(bot) {
  if (!bot._mbMovements) {
    const mcData = require('minecraft-data')(bot.version)
    bot._mbMovements = new Movements(bot, mcData)
  }
  return bot._mbMovements
}

// Turn to face an (x,z) target so a manual forward nudge goes the right way.
async function faceXZ(bot, target) {
  const dx = target.x - bot.entity.position.x
  const dz = target.z - bot.entity.position.z
  if (dx === 0 && dz === 0) return
  await bot.look(Math.atan2(-dx, dz), 0, true)
}

// Last-resort unstick: dig the block(s) directly in front (feet + head height) so the
// bot can ALWAYS get past a 1-2 block obstacle — if you can't go over it, go through it.
async function digInFront(bot) {
  const yaw = bot.entity.yaw
  const fx = Math.round(-Math.sin(yaw))
  const fz = Math.round(Math.cos(yaw))
  if (fx === 0 && fz === 0) return 0
  const isSolid = (n) => n && n !== 'air' && n !== 'cave_air' && n !== 'water' && n !== 'lava'
  let dug = 0
  for (const cell of [bot.entity.position.offset(fx, 1, fz), bot.entity.position.offset(fx, 0, fz)]) {
    const b = bot.blockAt(cell)
    if (b && isSolid(b.name) && bot.canDigBlock(b)) {
      try { await bot.dig(b); dug++ } catch (_) { /* skip if it can't be dug right now */ }
    }
  }
  return dug
}

// Walk forward for `ms`, hopping ONCE whenever forward progress stalls on the ground.
// Holding jump the whole time makes the bot bounce off the ledge and never settle on it.
// Returns how far (blocks) we actually travelled.
async function walkForwardHopping(bot, ms) {
  const start = bot.entity.position.clone()
  bot.setControlState('forward', true)
  const deadline = Date.now() + ms
  let prev = bot.entity.position.clone()
  try {
    while (Date.now() < deadline) {
      await sleep(200)
      const pos = bot.entity.position
      if (prev.distanceTo(pos) < 0.15 && bot.entity.onGround) {
        bot.setControlState('jump', true)
        await sleep(120)
        bot.setControlState('jump', false)
      }
      prev = pos.clone()
    }
  } finally {
    bot.setControlState('forward', false)
    bot.setControlState('jump', false)
  }
  return +start.distanceTo(bot.entity.position).toFixed(1)
}

// Run pathfinder.goto, but reject with "stuck" if the bot stops making progress so we
// never hang forever wedged against a block.
function gotoWithStallGuard(bot, goal, { stallMs = 2000, maxMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    let last = bot.entity.position.clone()
    let lastProgress = Date.now()
    const started = Date.now()
    let settled = false
    const finish = (fn) => { if (settled) return; settled = true; clearInterval(timer); fn() }
    const timer = setInterval(() => {
      const now = bot.entity.position
      if (last.distanceTo(now) > 0.15) { last = now.clone(); lastProgress = Date.now() }
      if (Date.now() - lastProgress > stallMs || Date.now() - started > maxMs) {
        try { bot.pathfinder.stop() } catch (_) {}
        finish(() => reject(new Error('stuck')))
      }
    }, 250)
    bot.pathfinder.goto(goal).then(
      () => finish(resolve),
      (err) => finish(() => reject(err))
    )
  })
}

// Navigate to a goal with automatic stuck-recovery: if pathfinder wedges against a
// 1-block step, stop it, manually hop forward toward the target, then retry.
async function navigate(bot, goal, target) {
  bot.pathfinder.setMovements(getMovements(bot))
  let lastErr
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await gotoWithStallGuard(bot, goal)
      return true
    } catch (e) {
      lastErr = e
      try { bot.pathfinder.stop() } catch (_) {}
      if (target) { try { await faceXZ(bot, target) } catch (_) {} }
      // Escalating recovery: first just hop the step; if still wedged, dig through it.
      if (attempt >= 1) { try { await digInFront(bot) } catch (_) {} }
      await walkForwardHopping(bot, 1000)
    }
  }
  throw new Error((lastErr && lastErr.message) || 'could not navigate')
}

function formatPos(p) {
  return `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`
}

// ─────────────────────────────────────────────
// OBSERVATION (what state the LLM sees each turn)
// ─────────────────────────────────────────────
// Sparse, important blocks worth reporting with coordinates (common blocks like
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
    block_in_front: frontFeet,                        // at feet height, the way you face
    block_in_front_head: frontHead,                   // at head height
    can_step_up: solid(frontFeet) && !solid(frontHead),   // a 1-block step you can hop
    blocked: solid(frontFeet) && solid(frontHead),        // 2-tall wall -> mine or go around
    standing_on: nameAt(0, -1, 0),
    above_head: nameAt(0, 2, 0),
    drop_ahead: !solid(frontFeet) && nameAt(fx, -1, fz) === 'air'   // gap/cliff in front
  }
}

// A coordinate "radar" of the nearest notable resource/hazard of each type.
function nearestResources(bot) {
  const mcData = require('minecraft-data')(bot.version)
  const ids = RADAR_BLOCKS.map(n => mcData.blocksByName[n]?.id).filter(id => id !== undefined)
  const positions = bot.findBlocks({ matching: ids, maxDistance: 32, count: 64 })
  const p = bot.entity.position
  const best = {}
  for (const pos of positions) {
    const b = bot.blockAt(pos)
    if (!b || best[b.name]) continue   // findBlocks is nearest-first: first hit per type is closest
    best[b.name] = {
      at: { x: pos.x, y: pos.y, z: pos.z },
      dist: +p.distanceTo(pos).toFixed(1),
      dir: compass(pos.x - p.x, pos.z - p.z)
    }
  }
  return best
}

function getObservation(bot) {
  const p = bot.entity.position
  const inventory = {}
  for (const item of bot.inventory.items()) {
    inventory[item.name] = (inventory[item.name] || 0) + item.count
  }
  return {
    position: { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) },
    facing: cardinalFromYaw(bot.entity.yaw),
    health: bot.health,
    food: bot.food,
    on_ground: bot.entity.onGround,
    inventory,
    surroundings: describeSurroundings(bot),
    nearby: nearestResources(bot),
    time_of_day: bot.time.timeOfDay
  }
}

module.exports = { TOOL_SCHEMAS, TOOL_IMPLS, getObservation }