// ─────────────────────────────────────────────
// SKILLS — the agent's in-world capabilities (mineflayer tools) + reliable movement.
//
// OWNER: Agent: Skills & Movement (Role 3)
//
// Public API:
//   TOOL_SCHEMAS                       -> array of OpenAI tool/function schemas
//   executeAction(bot, { tool, args }) -> { result, ok, done }
//   TOOL_IMPLS                         -> raw implementations (name -> async (bot,args)=>string)
//
// Add a new skill = add a schema to TOOL_SCHEMAS + an impl to TOOL_IMPLS. Each impl
// returns a human-readable string; strings that start like an error are scored as failures.
// ─────────────────────────────────────────────
const { goals, Movements } = require('mineflayer-pathfinder')

const STOP_SIGNAL = '__STOP__'

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
        properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
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
        properties: { seconds: { type: 'number', description: 'How long to walk forward, 1-5. Default 1.5.' } }
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
        properties: { block_type: { type: 'string', description: 'e.g., "oak_log", "stone", "dirt", "coal_ore"' } },
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
        properties: { item: { type: 'string', description: 'e.g., "wooden_pickaxe"' } },
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
        properties: { direction: { type: 'string', enum: ['north', 'south', 'east', 'west'] } },
        required: ['direction']
      }
    }
  },
  {
    type: 'function',
    function: { name: 'jump', description: 'Jump once.', parameters: { type: 'object', properties: {} } }
  },
  {
    type: 'function',
    function: {
      name: 'chat',
      description: 'Send a message in game chat.',
      parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }
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

    // Make sure we'll actually COLLECT a drop: stone/ores break into nothing unless the
    // right tool is held. Auto-equip the best tool we own; refuse if we have none so the
    // model goes and crafts a pickaxe instead of wasting the block by hand.
    const tool = await ensureHarvestTool(bot, block)
    if (tool.error) return tool.error

    try {
      await navigate(bot, new goals.GoalLookAtBlock(block.position, bot.world), block.position)
      await bot.dig(block)
      await collectNearbyDrops(bot, block.position)
      return `Mined ${block_type} at ${formatPos(block.position)}${tool.note}`
    } catch (e) {
      // Navigation may have stalled but left us within reach — try digging anyway.
      try {
        if (bot.entity.position.distanceTo(block.position) <= 5) {
          await bot.dig(block)
          await collectNearbyDrops(bot, block.position)
          return `Mined ${block_type} at ${formatPos(block.position)}${tool.note} (recovered after getting stuck)`
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

    return placeOnSurface(bot, item, block_type, dx, dy, dz)
  },

  async craft(bot, { item, count = 1 }) {
    const mcData = require('minecraft-data')(bot.version)
    const itemData = mcData.itemsByName[item]
    if (!itemData) return `Unknown item: ${item}`

    // 1) Craftable right now in the 2x2 inventory grid? (planks, sticks, the table itself)
    let recipe = bot.recipesFor(itemData.id, null, count, null)[0]
    let table = null
    if (!recipe) {
      // 2) Otherwise try at a nearby crafting_table (pickaxe, furnace, ...), walking up to
      //    it first so opening its window doesn't time out from across the room.
      table = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 32 })
      recipe = table ? bot.recipesFor(itemData.id, null, count, table)[0] : null
      if (!recipe) {
        // Report the REAL reason so the model fixes the right thing.
        const tablelessExists = bot.recipesAll(itemData.id, null, false).length > 0
        return tablelessExists
          ? `Could not craft ${item}: not enough ingredients (did you turn all your planks into sticks?). Get more first.`
          : `Could not craft ${item}: needs a crafting_table within reach — place one beside you first.`
      }
      try { await navigate(bot, new goals.GoalLookAtBlock(table.position, bot.world), table.position) } catch (_) {}
    }

    try {
      await bot.craft(recipe, count, table)
      // Crafting at a table leaves its window open, which makes the just-crafted item briefly
      // unfindable for equip/mine_block (the inventory looks right but item moves fail). Close
      // the window and wait for the result to settle into inventory before the next action.
      if (bot.currentWindow) { try { await bot.closeWindow(bot.currentWindow) } catch (_) {} }
      for (let i = 0; i < 12 && !bot.inventory.items().some(it => it.name === item); i++) await sleep(50)
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
    await sleep(400)
    bot.setControlState('jump', false)
    return 'Jumped.'
  },

  async chat(bot, { message }) {
    bot.chat(message)
    return `Said: "${message}"`
  },

  async stop() {
    return STOP_SIGNAL
  }
}

// ─────────────────────────────────────────────
// executeAction — the single seam the harness calls.
// ─────────────────────────────────────────────
const isErrorResult = (r) => /^(Failed|Unknown|No |Could not|Nothing|Tool .* threw)/.test(String(r))

async function executeAction(bot, { tool, args }) {
  const impl = TOOL_IMPLS[tool]
  if (!impl) return { result: `Unknown tool: ${tool}`, ok: false, done: false }
  let result
  try {
    result = await impl(bot, args || {})
  } catch (e) {
    result = `Tool ${tool} threw an error: ${e.message}`
  }
  if (result === STOP_SIGNAL) return { result: 'Agent requested stop.', ok: true, done: true }
  return { result, ok: !isErrorResult(result), done: false }
}

// ─────────────────────────────────────────────
// MOVEMENT / NAVIGATION HELPERS (the reliability layer)
// ─────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function formatPos(p) {
  return `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`
}

// Ensure the bot is holding a tool that will actually drop `block`. Blocks like stone and
// ores expose `harvestTools` (the set of items that yield a drop); breaking them with the
// wrong tool or a bare hand destroys the block for nothing.
//   -> { note }  : '' or ' (equipped X first)' to append to a success message
//   -> { error } : a message to return immediately (no usable tool in inventory)
async function ensureHarvestTool(bot, block) {
  if (!block || !block.harvestTools) return { note: '' }                      // any tool/hand drops it
  if (bot.heldItem && block.harvestTools[bot.heldItem.type]) return { note: '' }

  const usable = bot.inventory.items().find(i => block.harvestTools[i.type])
  if (!usable) {
    return { error: `Could not collect ${block.name}: it needs a proper tool (a pickaxe) equipped or it drops NOTHING. Craft and equip a pickaxe first, then mine.` }
  }
  try {
    await bot.equip(usable, 'hand')
    return { note: ` (equipped ${usable.name} first)` }
  } catch (e) {
    return { error: `Failed to equip ${usable.name} to mine ${block.name}: ${e.message}` }
  }
}

// After breaking a block, its drop spawns near `pos` as an item entity. Walk onto it so the
// bot auto-collects it — mining from a distance (or the stuck-recovery dig) otherwise leaves
// the drop on the ground (e.g. cobblestone never picked up, so the run shows 0 progress).
async function collectNearbyDrops(bot, pos) {
  const nearestDrop = () => Object.values(bot.entities)
    .filter(e => e.name === 'item' && e.position && e.position.distanceTo(pos) < 3)
    .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))[0]
  for (let i = 0; i < 6 && !nearestDrop(); i++) await sleep(50)   // let the drop spawn
  const drop = nearestDrop()
  if (!drop) return
  try {
    await navigate(bot, new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1), drop.position)
  } catch (_) { /* best-effort pickup */ }
}

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
// 1-block step, stop it, hop forward toward the target, then (if still wedged) dig through.
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
      if (attempt >= 1) { try { await digInFront(bot) } catch (_) {} }
      await walkForwardHopping(bot, 1000)
    }
  }
  throw new Error((lastErr && lastErr.message) || 'could not navigate')
}

// Place a block reliably: try the cell the model asked for, then fall back to any adjacent
// ground cell. Pre-checks the target so we don't hang on a placement the server will reject
// (the "blockUpdate did not fire" timeout) and so utility blocks like a crafting_table
// always land somewhere reachable.
async function placeOnSurface(bot, item, name, dx, dy, dz) {
  try { await bot.equip(item, 'hand') } catch (e) { return `Failed to equip ${name}: ${e.message}` }

  const isAir = (b) => !b || b.name === 'air' || b.name === 'cave_air'
  const tryAt = async (refBlock) => {
    if (isAir(refBlock)) return false                                          // nothing solid to place against
    if (!isAir(bot.blockAt(refBlock.position.offset(0, 1, 0)))) return false   // target cell already filled
    try { await bot.placeBlock(refBlock, { x: 0, y: 1, z: 0 }); return true } catch (_) { return false }
  }

  // 1) the cell the model asked for (placed on top of the block just beneath it).
  if (await tryAt(bot.blockAt(bot.entity.position.offset(dx, dy - 1, dz)))) {
    return `Placed ${name} at offset (${dx},${dy},${dz}).`
  }
  // 2) fallback: on the ground in one of the 4 cells around your feet.
  for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (await tryAt(bot.blockAt(bot.entity.position.offset(ox, -1, oz)))) {
      return `Placed ${name} on the ground beside you.`
    }
  }
  return `Failed to place ${name}: no open spot next to you — move to flatter, clearer ground and retry.`
}

// Jump straight up and place a block under your feet at the apex (pillar up by 1).
async function pillarUp(bot, item, name) {
  try {
    await bot.equip(item, 'hand')
    const refBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0))
    if (!refBlock || refBlock.name === 'air') return `Nothing solid below to pillar up from.`
    const baseY = Math.floor(bot.entity.position.y)
    bot.setControlState('jump', true)
    let placed = false
    for (let i = 0; i < 16 && !placed; i++) {
      await sleep(80)
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

module.exports = { TOOL_SCHEMAS, TOOL_IMPLS, executeAction, STOP_SIGNAL }
