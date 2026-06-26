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
const Vec3 = require('vec3')
const { readInventory } = require('./observation')

const STOP_SIGNAL = '__STOP__'

// Inventory snapshots let a skill report the VERIFIED change in the world instead of
// optimistically asserting an action worked. `invGain` returns only the items whose count
// went UP (positive deltas) between two snapshots — crafting can also consume items, so we
// never infer success from the total count, only from the specific items that increased.
function invGain(before, after) {
  const gained = {}
  for (const name of Object.keys(after)) {
    const delta = after[name] - (before[name] || 0)
    if (delta > 0) gained[name] = delta
  }
  return gained
}

// A mined drop can take a tick or more to land in the inventory after the bot walks onto it.
// Wait (bounded) for a SPECIFIC item to register when `wantItem` is given, so we don't report
// "drop not collected" a moment before the real drop arrives — and so unrelated incidental
// pickups don't end the wait early. Falls back to "any gain" when no item is specified.
async function settleInventory(bot, before, wantItem = null) {
  const max = wantItem ? 30 : 12   // ~1.5s for a named drop, ~0.6s for the generic case
  for (let i = 0; i < max; i++) {
    const after = readInventory(bot)
    if (wantItem) {
      if ((after[wantItem] || 0) > (before[wantItem] || 0)) return
    } else if (Object.keys(invGain(before, after)).length) {
      return
    }
    await sleep(50)
  }
}

// Wait (bounded) for a furnace to finish smelting `want` items. Resolves with the number of
// output items observed when: the output slot reaches `want`, the input slot empties (nothing
// left to smelt), or progress stalls with no fuel burning — and always bails at a hard time
// cap (~12s per item + buffer) so a stuck/under-fuelled furnace can never hang the step.
async function waitForSmelt(furnace, want) {
  const outCount = () => furnace.outputItem()?.count || 0
  const inCount = () => furnace.inputItem()?.count || 0
  const burning = () => (furnace.fuel || 0) > 0 || (furnace.fuelItem()?.count || 0) > 0
  const deadline = Date.now() + want * 12000 + 8000
  let stalls = 0
  while (Date.now() < deadline) {
    if (outCount() >= want) break
    if (inCount() === 0 && (furnace.progress || 0) === 0) break   // nothing left to smelt
    // No fuel and no active progress: it can't make further output — stop after a couple of
    // confirmations so a momentary between-items reading doesn't end the wait early.
    if (!burning() && (furnace.progress || 0) === 0) {
      if (++stalls >= 3) break
    } else {
      stalls = 0
    }
    await sleep(500)
  }
  return outCount()
}

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
      description: 'Mine a block of a given type. By default it finds and mines the NEAREST matching block within 32 blocks. You can also target a SPECIFIC block by passing its exact x, y, z — use this to mine a precise coordinate you read from look_around\'s "block_coords" (e.g. the one ore/stone you actually want) instead of letting it pick the nearest. When x, y, z are given they must match the "block_type"; otherwise it falls back to the nearest matching block.',
      parameters: {
        type: 'object',
        properties: {
          block_type: { type: 'string', description: 'The block type to mine (lowercase underscored name)' },
          x: { type: 'integer', description: 'Optional. Exact X of the specific block to mine (e.g. from look_around block_coords). Provide all of x, y, z together to target one block.' },
          y: { type: 'integer', description: 'Optional. Exact Y of the specific block to mine. Provide all of x, y, z together.' },
          z: { type: 'integer', description: 'Optional. Exact Z of the specific block to mine. Provide all of x, y, z together.' }
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
          item: { type: 'string', description: 'The item to craft (lowercase underscored name)' },
          count: { type: 'integer', default: 1 }
        },
        required: ['item']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'smelt',
      description: 'Smelt items in the nearest furnace (within 32 blocks) using a fuel you specify. Loads the input + fuel, waits for smelting to finish, collects the output, and returns any leftovers to your inventory. Reports the VERIFIED result — what actually came out — not advice. Needs the input item and the fuel item already in your inventory.',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Item to smelt (lowercase underscored name).' },
          fuel: { type: 'string', description: 'Fuel item to burn (lowercase underscored name).' },
          count: { type: 'integer', description: 'How many input items to smelt. Default 1.', default: 1 }
        },
        required: ['input', 'fuel']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'equip',
      description: 'Equip an item from your inventory. A tool/weapon goes to your HAND (e.g. a pickaxe before mining); a piece of ARMOR is WORN in its slot automatically (helmet->head, chestplate->chest, leggings->legs, boots->feet); a shield goes to your off-hand. Equip each armor piece in turn to wear a full set.',
      parameters: {
        type: 'object',
        properties: { item: { type: 'string', description: 'The item to equip (lowercase underscored name)' } },
        required: ['item']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'store_in_chest',
      description: 'Deposit an item from your inventory into the NEAREST chest (within 32 blocks). If there is no chest, craft one and place_block it first. Moves up to "count" of the item into the chest, verifies the deposit by the drop in your inventory, and reports what actually went in. Use this to put a finished item away — e.g. each piece of an armor set into a chest.',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'The item to store (lowercase underscored name, e.g. "leather_chestplate").' },
          count: { type: 'integer', description: 'How many to deposit. Omit to deposit all of that item you are holding.' }
        },
        required: ['item']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'attack_entity',
      description: 'Attack and kill the nearest mob/entity of a given type to get its drops. Use look_around to see which entities are nearby, then call this with the entity_type — the bot walks to the nearest one, swings with whatever it has equipped until it dies, then collects the drops and reports the VERIFIED items gained. Players are never targeted.',
      parameters: {
        type: 'object',
        properties: {
          entity_type: { type: 'string', description: 'The mob/entity type to attack (lowercase name, e.g. "chicken", "cow", "sheep", "pig", "zombie").' }
        },
        required: ['entity_type']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'attack_player',
      description: 'Attack another PLAYER by their exact username. Uses the same combat as attack_entity: walks to that player and swings with whatever it has equipped. If "hits" is provided, the bot swings that many times and then returns, reporting the hits landed, the target\'s health, and its own health. If "hits" is omitted, the bot keeps swinging until the player dies. Never the human or yourself.',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'The exact username of the player to attack (e.g. "MineBenchBotB").' },
          hits: { type: 'integer', minimum: 1, description: 'How many times to swing at the player before returning. If omitted, the bot attacks until the player dies.' }
        },
        required: ['username']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'look_around',
      description: 'Scan surroundings: returns nearby blocks and entities within a cube of the given radius (default 8 blocks). Returns "nearby_blocks" (total counts per block type — how abundant each is) AND "block_coords" (up to the 3 NEAREST [x,y,z] coordinates per block type, sorted closest-first). Every coordinate in "block_coords" is guaranteed to be that exact block type, so pick the first (closest) one and move_to(x,y,z) or mine_block(block_type, x, y, z) it directly. If a first scan does not reveal what you need, call it again with a LARGER radius to search farther out.',
      parameters: {
        type: 'object',
        properties: {
          radius: { type: 'number', description: 'How far out (in blocks) to scan in each horizontal direction. Defaults to 8. Increase it (e.g. 16, 24, 32) to widen the search when a smaller scan did not find what you are looking for.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_data',
      description: 'Look up the game data for an item or block and get the raw FACTS in readable form (names instead of numbers): every crafting recipe with its ingredient names + amounts and whether it needs a crafting_table, and — for blocks — what the block drops and which tools yield a drop. This is a reference lookup, NOT instructions: it does not tell you what to do or pick a recipe for you. YOU read the facts and decide which recipe to use and what to do next. Returns JSON: { name, recipes, mining }.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Item or block name to look up. Lowercase underscored names work best; "minecraft:" prefix and spaces are tolerated.' }
        },
        required: ['target']
      }
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
      description: 'End the task. Call ONLY when the goal is complete, OR you have genuinely exhausted your options after trying several different approaches. A single failed step is not "stuck".',
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
      return verticalGapReport(bot, { x, y, z }) || `Reached ${formatPos(bot.entity.position)}`
    } catch (e) {
      const gap = verticalGapReport(bot, { x, y, z })
      if (gap) return gap
      // Factual reason only — no advice. Map pathfinder's error to what actually happened.
      let reason
      if (e.name === 'NoPath') reason = 'no path to the goal exists'
      else if (e.name === 'Timeout') reason = 'pathfinding timed out before a route was found'
      else if (e.message === 'stuck') reason = 'movement stopped making progress toward the goal'
      else reason = e.message
      return `Failed to reach (${x},${y},${z}) from ${formatPos(bot.entity.position)}: ${reason}.`
    }
  },

  async move_forward(bot, { seconds = 1.5 }) {
    const ms = Math.max(0.1, Math.min(Number(seconds) || 1.5, 5)) * 1000
    const traveled = await walkForwardHopping(bot, ms)
    const note = traveled < 0.5
      ? ' (still blocked — the obstacle may be 2+ blocks tall)'
      : ''
    return `Moved forward ${ms / 1000}s, traveled ${traveled} blocks to ${formatPos(bot.entity.position)}${note}`
  },

  async mine_block(bot, { block_type, x, y, z }) {
    const mcData = loadMcData(bot)
    const name = normalizeName(block_type)
    const blockId = mcData.blocksByName[name]?.id
    if (blockId === undefined) {
      const guesses = suggestNames(mcData, name)
      return `Unknown block: ${block_type}.${guesses.length ? ' Similar names: ' + guesses.join(', ') + '.' : ''}`
    }

    // Two ways to pick the target block:
    //  (a) explicit x,y,z — the model read a SPECIFIC coordinate from look_around's
    //      "block_coords" and wants THAT block (e.g. the one exposed ore it spotted),
    //      not whatever happens to be nearest.
    //  (b) no coords — use the built-in "nearest matching block" search.
    // (a) never replaces (b); it just lets the look_around coords steer mining.
    let block
    const hasCoords = [x, y, z].every(v => Number.isFinite(Number(v)))
    if (hasCoords) {
      const target = new Vec3(Math.floor(Number(x)), Math.floor(Number(y)), Math.floor(Number(z)))
      block = bot.blockAt(target)
      if (!block) {
        return `No block found at (${target.x},${target.y},${target.z}) — it may be outside loaded chunks. Move closer or look_around again to refresh its coordinates.`
      }
      if (block.name !== name) {
        // The world changed since the scan (already mined, or the model mistyped a coord).
        // Don't silently mine the wrong block; let the model re-scan or pick again.
        return `Block at (${target.x},${target.y},${target.z}) is ${block.name}, not ${name}. Re-run look_around to get fresh ${name} coordinates, or omit x/y/z to mine the nearest ${name}.`
      }
    } else {
      block = bot.findBlock({ matching: blockId, maxDistance: 32 })
      if (!block) return `No ${name} found within 32 blocks.`
    }

    // Walk to a block, dig it, and collect the drop — reporting the VERIFIED inventory gain.
    // Returns { ok } on success, { error } if we own no tool that can harvest it, or
    // { failed } when navigation/dig could not reach the block. Factored out so a specific
    // coordinate that turns out UNREACHABLE (e.g. a log floating in a tree canopy, or a block
    // across a ravine) can transparently fall back to the nearest reachable match instead of
    // stranding the bot with a hard "stuck" failure.
    const mineOne = async (target) => {
      // Make sure we'll actually COLLECT a drop: stone/ores break into nothing unless the
      // right tool is held. Auto-equip the best tool we own; refuse if we have none so the
      // model goes and crafts a pickaxe instead of wasting the block by hand.
      const tool = await ensureHarvestTool(bot, target)
      if (tool.error) return { error: tool.error }

      // Name this block is expected to drop, so we report on the SPECIFIC drop that lands in
      // the inventory rather than on whatever the bot happened to vacuum up (old ground litter
      // like dirt from earlier mining gets picked up mid-action and must NOT be misattributed
      // to this block).
      const expectedDrop = blockDropIds(target).map(id => idToName(mcData, id)).filter(Boolean)[0] || name
      const report = (before) => {
        const gained = (readInventory(bot)[expectedDrop] || 0) - (before[expectedDrop] || 0)
        return gained > 0
          ? `Broke ${name} at ${formatPos(target.position)}; collected ${gained}x ${expectedDrop}.${tool.note}`
          : `Broke ${name} at ${formatPos(target.position)}; drop (${expectedDrop}) not collected yet.${tool.note}`
      }

      try {
        const before = readInventory(bot)
        await navigate(bot, new goals.GoalLookAtBlock(target.position, bot.world), target.position)
        await bot.dig(target)
        await collectNearbyDrops(bot, target.position)
        await settleInventory(bot, before, expectedDrop)
        return { ok: report(before) }
      } catch (e) {
        // Navigation may have stalled but left us within reach — try digging anyway.
        try {
          if (bot.entity.position.distanceTo(target.position) <= 5) {
            const before = readInventory(bot)
            await bot.dig(target)
            await collectNearbyDrops(bot, target.position)
            await settleInventory(bot, before, expectedDrop)
            return { ok: report(before) }
          }
        } catch (_) { /* fall through to the failure result */ }
        return { failed: e }
      }
    }

    const first = await mineOne(block)
    if (first.ok) return first.ok
    if (first.error) return first.error   // no usable tool — fallback wouldn't help

    // Navigation to the chosen block failed. If we were aiming at a SPECIFIC coordinate that
    // turned out unreachable, don't dead-end: retry with the nearest matching block (the same
    // search used when no coords are given). This keeps look_around coords useful when the
    // target is reachable, while restoring reliable traversal when the picked coord is not.
    if (hasCoords) {
      const nearest = bot.findBlock({ matching: blockId, maxDistance: 32 })
      if (nearest && !nearest.position.equals(block.position)) {
        const second = await mineOne(nearest)
        if (second.ok) {
          return `${second.ok} (Could not reach the exact coordinate (${block.position.x},${block.position.y},${block.position.z}) — it may be unreachable; mined the nearest ${name} instead.)`
        }
        if (second.error) return second.error
        return `Failed to mine ${name}: could not reach the coordinate (${block.position.x},${block.position.y},${block.position.z}) or the nearest ${name} (${second.failed.message}). Try move_to a closer open spot first, or look_around for a more reachable one.`
      }
    }
    return `Failed to mine ${name}: ${first.failed.message}`
  },

  async place_block(bot, { block_type, dx, dy, dz }) {
    const name = normalizeName(block_type)
    const item = bot.inventory.items().find(i => i.name === name)
    if (!item) return `No ${name} in inventory.`

    // Placing into your own feet column means "pillar up": jump and place beneath
    // yourself with the right timing instead of relying on a lucky airborne frame.
    if (dx === 0 && dz === 0 && (dy === 0 || dy === -1)) {
      return pillarUp(bot, item, name)
    }

    return placeOnSurface(bot, item, name, dx, dy, dz)
  },

  async craft(bot, { item, count = 1 }) {
    const mcData = loadMcData(bot)
    const name = normalizeName(item)
    const itemData = mcData.itemsByName[name]
    if (!itemData) {
      const guesses = suggestNames(mcData, name)
      return `Unknown item: ${item}.${guesses.length ? ' Similar names: ' + guesses.join(', ') + '.' : ''}`
    }

    // 1) Craftable right now in the 2x2 inventory grid? (planks, sticks, the table itself)
    let recipe = bot.recipesFor(itemData.id, null, count, null)[0]
    let table = null
    if (!recipe) {
      // 2) Needs the 3x3 grid -> a crafting_table in the world. Find the nearest one.
      table = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 32 })
      if (!table) {
        // No table nearby. Distinguish "this recipe needs a table" from "we just lack
        // ingredients" so the model fixes the RIGHT thing.
        const needsTable = bot.recipesAll(itemData.id, null, false).length === 0
        return needsTable
          ? `Could not craft ${name}: needs a crafting_table — none within 32 blocks.`
          : `Could not craft ${name}: not enough ingredients.`
      }
      // A table IS nearby. If we still can't make it, the problem is INGREDIENTS, not the
      // table — say so explicitly (with the table's position) so the model stops looping on
      // "place another crafting_table" when one is already right next to it.
      recipe = bot.recipesFor(itemData.id, null, count, table)[0]
      if (!recipe) {
        return `Could not craft ${name}: not enough ingredients — a crafting_table is already here at ${formatPos(table.position)}.`
      }
      // Walk up to the table, then CONFIRM we're actually in interaction range before opening
      // its window. A short/failed path otherwise leaves us too far and bot.craft hangs the
      // full 20s on "windowOpen did not fire".
      try { await navigate(bot, new goals.GoalLookAtBlock(table.position, bot.world), table.position) } catch (_) {}
      const dist = bot.entity.position.distanceTo(table.position)
      if (dist > 4) {
        return `Could not craft ${name}: a crafting_table is at ${formatPos(table.position)} but I couldn't get close enough to use it (stuck ${dist.toFixed(1)} blocks away).`
      }
    }

    try {
      const beforeCount = readInventory(bot)[name] || 0
      await bot.craft(recipe, count, table)
      // Crafting at a table leaves its window open, which makes the just-crafted item briefly
      // unfindable for equip/mine_block (the inventory looks right but item moves fail). Close
      // the window and wait for the result to settle into inventory before the next action.
      if (bot.currentWindow) { try { await bot.closeWindow(bot.currentWindow) } catch (_) {} }
      // Crafting CONSUMES ingredients, so total inventory size can drop — verify success by the
      // TARGET item's own count rising, not by total count or mere presence (the bot may have
      // already owned some). Report what actually appeared instead of asserting it worked.
      let afterCount = readInventory(bot)[name] || 0
      for (let i = 0; i < 12 && afterCount <= beforeCount; i++) { await sleep(50); afterCount = readInventory(bot)[name] || 0 }
      const gained = afterCount - beforeCount
      return gained > 0
        ? `Crafted ${gained}x ${name}.`
        : `Craft of ${name} produced nothing; ${name} count unchanged.`
    } catch (e) {
      return `Failed to craft ${name}: ${e.message}`
    }
  },

  async smelt(bot, { input, fuel, count = 1 }) {
    const mcData = loadMcData(bot)
    const inputName = normalizeName(input)
    const fuelName = normalizeName(fuel)
    const want = Math.max(1, Math.floor(Number(count) || 1))

    // Validate both names against the knowledge base, mirroring craft/mine_block: report
    // the unknown name (with close guesses) rather than failing deeper with a cryptic error.
    const inputData = mcData.itemsByName[inputName]
    if (!inputData) {
      const guesses = suggestNames(mcData, inputName)
      return `Unknown item: ${input}.${guesses.length ? ' Similar names: ' + guesses.join(', ') + '.' : ''}`
    }
    const fuelData = mcData.itemsByName[fuelName]
    if (!fuelData) {
      const guesses = suggestNames(mcData, fuelName)
      return `Unknown fuel: ${fuel}.${guesses.length ? ' Similar names: ' + guesses.join(', ') + '.' : ''}`
    }

    // Verify we actually hold the input + fuel before opening anything. State only — no advice.
    const startInv = readInventory(bot)
    const haveInput = startInv[inputName] || 0
    const haveFuel = startInv[fuelName] || 0
    if (haveInput < 1) return `Could not smelt: no ${inputName} in inventory.`
    if (haveFuel < 1) return `Could not smelt: no ${fuelName} in inventory to use as fuel.`
    const toSmelt = Math.min(want, haveInput)

    // Locate the furnace exactly like the craft tool locates a crafting_table: nearest within
    // 32, walk up, then CONFIRM interaction range before opening its window (a short/failed
    // path otherwise leaves us too far and openFurnace hangs on "windowOpen did not fire").
    const furnaceBlock = bot.findBlock({ matching: mcData.blocksByName.furnace.id, maxDistance: 32 })
    if (!furnaceBlock) return `Could not smelt ${inputName}: no furnace within 32 blocks.`
    try { await navigate(bot, new goals.GoalLookAtBlock(furnaceBlock.position, bot.world), furnaceBlock.position) } catch (_) {}
    const dist = bot.entity.position.distanceTo(furnaceBlock.position)
    if (dist > 4) {
      return `Could not smelt ${inputName}: a furnace is at ${formatPos(furnaceBlock.position)} but I couldn't get close enough to use it (stuck ${dist.toFixed(1)} blocks away).`
    }

    // Fuel to load: coal/charcoal smelt 8 items each. Load enough for the batch, clamped to
    // what we own (min 1). The model picked the fuel; we only size the amount sensibly.
    const fuelToLoad = Math.min(haveFuel, Math.max(1, Math.ceil(toSmelt / 8)))

    let furnace
    try {
      furnace = await bot.openFurnace(furnaceBlock)
    } catch (e) {
      return `Could not open furnace at ${formatPos(furnaceBlock.position)}: ${e.message}`
    }

    try {
      try {
        await furnace.putFuel(fuelData.id, null, fuelToLoad)
      } catch (e) {
        return `Could not load ${fuelName} as fuel: ${e.message}`
      }
      try {
        await furnace.putInput(inputData.id, null, toSmelt)
      } catch (e) {
        return `Could not load ${inputName} into the furnace: ${e.message}`
      }

      // Wait (bounded) for the furnace to actually produce the output. Returns when the
      // output reaches the batch size, the input slot empties, or progress stalls with no
      // fuel left — and always bails at the hard time cap so a stuck furnace can't hang us.
      await waitForSmelt(furnace, toSmelt)

      // Pull the output AND any leftover input/fuel back into the inventory so the reported
      // state matches reality and nothing is silently abandoned in the furnace.
      try { if (furnace.outputItem()) await furnace.takeOutput() } catch (_) {}
      try { if (furnace.inputItem()) await furnace.takeInput() } catch (_) {}
      try { if (furnace.fuelItem()) await furnace.takeFuel() } catch (_) {}

      // Verify the yield by the inventory delta only (invGain reports just the items whose
      // count rose) — never assume the smelt worked. The single gained item is the output.
      await settleInventory(bot, startInv)
      const gained = invGain(startInv, readInventory(bot))
      const outputName = Object.keys(gained)[0]
      const outputCount = outputName ? gained[outputName] : 0

      if (outputCount <= 0) {
        return `Furnace at ${formatPos(furnaceBlock.position)} produced nothing (no output after smelting ${toSmelt}x ${inputName}).`
      }
      const remaining = readInventory(bot)
      const leftInput = remaining[inputName] || 0
      if (outputCount < toSmelt) {
        return `Smelted ${outputCount}x ${outputName} at ${formatPos(furnaceBlock.position)} (${outputCount} of ${toSmelt} requested before the furnace stopped); ${leftInput}x ${inputName} left in inventory.`
      }
      return `Smelted ${outputCount}x ${outputName} at ${formatPos(furnaceBlock.position)}.`
    } finally {
      try { await bot.closeWindow(furnace) } catch (_) {}
    }
  },

  async equip(bot, { item }) {
    const name = normalizeName(item)
    // A just-crafted item (especially crafted at a table) can be transiently invisible to
    // bot.inventory.items() while the crafting window is still closing/settling. Close any
    // open window, then poll briefly so we don't falsely report "No X in inventory" for an
    // item the inventory actually holds.
    if (bot.currentWindow) { try { await bot.closeWindow(bot.currentWindow) } catch (_) {} }
    let i = bot.inventory.items().find(x => x.name === name)
    for (let n = 0; n < 12 && !i; n++) { await sleep(50); i = bot.inventory.items().find(x => x.name === name) }
    if (!i) return `No ${name} in inventory.`
    const dest = equipDestination(name)
    try {
      await equipAndConfirm(bot, i, dest)
      return dest === 'hand' ? `Equipped ${name} in hand.`
        : dest === 'off-hand' ? `Equipped ${name} in your off-hand.`
        : `Equipped — now wearing ${name}.`
    } catch (e) {
      return `Failed to equip ${item}: ${e.message}`
    }
  },

  async store_in_chest(bot, { item, count }) {
    const name = normalizeName(item)
    const mcData = loadMcData(bot)
    const chestBlock = bot.findBlock({ matching: mcData.blocksByName.chest.id, maxDistance: 32 })
    if (!chestBlock) return `No chest nearby to store in — craft a chest and place_block it first.`

    // Walk to the chest and CONFIRM we're in interaction range before opening it, or openContainer
    // hangs waiting for a window that never fires.
    try { await navigate(bot, new goals.GoalLookAtBlock(chestBlock.position, bot.world), chestBlock.position) } catch (_) {}
    const dist = bot.entity.position.distanceTo(chestBlock.position)
    if (dist > 4) return `Could not reach the chest at ${formatPos(chestBlock.position)} (stuck ${dist.toFixed(1)} blocks away).`

    const itemId = mcData.itemsByName[name]?.id
    if (itemId == null) return `Unknown item: ${item}.`

    // A JUST-crafted item can take a tick to appear in bot.inventory — poll briefly before
    // concluding we hold none, so we don't skip a deposit for an item we actually have.
    let have = readInventory(bot)[name] || 0
    for (let n = 0; n < 10 && have <= 0; n++) { await sleep(60); have = readInventory(bot)[name] || 0 }

    let chest, depositErr = null, deposited = 0
    try {
      chest = await bot.openContainer(chestBlock)
      if (have > 0) {
        const before = chestCount(chest, name)
        const want = count && count > 0 ? Math.min(count, have) : have
        try { await chest.deposit(itemId, null, want) } catch (e) { depositErr = e }
        deposited = Math.max(0, chestCount(chest, name) - before)
      }
      // AUTHORITATIVE: record what is ACTUALLY in the chest now. The open container is the server's
      // ground truth — unlike a player-inventory delta it can't be fooled by client-sync lag, so a
      // deposit whose inventory update lagged is still counted and re-attempts never desync.
      recordChestContents(bot, chest)
    } finally {
      try { if (chest) await chest.close() } catch (_) {}
    }

    const inChest = (bot._storedItems && bot._storedItems[name]) || 0
    if (deposited > 0) return `Stored ${deposited}x ${name} in the chest at ${formatPos(chestBlock.position)} (it now holds ${inChest}).`
    if (inChest > 0) return `${name} is already in the chest (${inChest} there) — nothing more to store.`
    if (depositErr) return `Failed to store ${name} in the chest: ${depositErr.message}`
    return `Nothing was stored; no ${name} in your inventory or the chest.`
  },

  async attack_entity(bot, { entity_type }) {
    const name = normalizeName(entity_type)

    // Find the NEAREST live mob of this type. Players and item-drops are never valid targets.
    const target = Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.isValid && e.position && e.type !== 'player'
        && e.name !== 'item' && entityMatches(e, name))
      .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0]
    if (!target) {
      return `No ${name} found nearby. Use look_around to check what entities are around first.`
    }

    // Walk to the mob and swing with whatever you have equipped until it dies.
    const before = readInventory(bot)
    const result = await attackUntilDead(bot, target)
    if (!result.killed) {
      return `Could not kill the ${name}: ${result.reason}. Move_to closer and try again.`
    }

    // Collect the drops at the death spot and report the VERIFIED inventory gain.
    await collectNearbyDrops(bot, result.pos)
    await settleInventory(bot, before)
    const gained = invGain(before, readInventory(bot))
    const gainedStr = Object.entries(gained).map(([n, c]) => `${c}x ${n}`).join(', ')
    return gainedStr
      ? `Killed ${name}; collected ${gainedStr}.`
      : `Killed ${name} but no drops were collected (they may have despawned or fallen out of reach).`
  },

  async attack_player(bot, { username, hits }) {
    if (!username || typeof username !== 'string') {
      return 'No username given. Call attack_player with the exact username of the player to attack.'
    }
    if (username === bot.username) return 'Refusing to attack yourself.'

    // Resolve the player's live entity. bot.players is keyed by username; .entity is only set
    // while they are in render range. Fall back to scanning entities for a matching player.
    const target = bot.players[username]?.entity
      || Object.values(bot.entities).find(e => e.type === 'player' && e.username === username)
    if (!target || !target.isValid) {
      return `Player ${username} is not currently visible. Check "nearby_players" in your observation (or call look_around) for their coordinates, move_to them, then try again.`
    }

    // Optional swing budget: when the model supplies a positive integer, we swing that many
    // times and hand control back so it can drive its own hit-and-run engagement. Invalid or
    // non-positive values are ignored, falling back to the default attack-until-dead behavior.
    let maxHits
    if (hits != null) {
      const n = Math.floor(Number(hits))
      if (Number.isFinite(n) && n > 0) maxHits = n
    }

    // Same combat path as attack_entity: chase + swing with whatever you have equipped.
    const result = await attackUntilDead(bot, target, { maxHits })
    if (result.killed) {
      return `Killed ${username} after ${result.hits} hits.`
    }

    // Report only facts so the model can decide its next move on its own. Other players'
    // health is not always sent by the server, so report "unknown" when it is unavailable.
    const targetHealth = (target.isValid && typeof target.health === 'number') ? target.health : 'unknown'
    if (maxHits != null) {
      return `Swung ${result.hits}x at ${username}. ${username} is still alive. Target health: ${targetHealth}. Your health: ${bot.health}.`
    }
    return `Could not kill ${username} after ${result.hits} hits: ${result.reason}. Target health: ${targetHealth}. Your health: ${bot.health}.`
  },

  async look_around(bot, { radius } = {}) {
    const nearbyBlocks = {}
    // Per-block-name list of world coordinates the model can pick from to move_to/mine a
    // SPECIFIC instance. We cap how many we surface per type — dumping every block (a
    // 16-radius scan can find 10k+ stone) produced a huge wall of near-identical coordinate
    // triples that the model could not read reliably. A short, distance-sorted list (the
    // nearest few of each type) makes the coordinate it pulls trustworthy.
    const coordsByType = {}
    const MAX_COORDS_PER_TYPE = 3
    // The model picks the radius so it can widen its own search when a scan comes up empty.
    // Clamp to a sane range so a huge radius can't stall the bot scanning thousands of blocks.
    let scanRadius = Number(radius)
    if (!Number.isFinite(scanRadius) || scanRadius <= 0) scanRadius = 8
    scanRadius = Math.min(Math.max(Math.round(scanRadius), 2), 64)

    const origin = bot.entity.position
    for (let dx = -scanRadius; dx <= scanRadius; dx++) {
      for (let dz = -scanRadius; dz <= scanRadius; dz++) {
        for (let dy = -scanRadius; dy <= scanRadius; dy++) {
          const b = bot.blockAt(origin.offset(dx, dy, dz))
          if (b && b.name !== 'air' && b.name !== 'cave_air') {
            nearbyBlocks[b.name] = (nearbyBlocks[b.name] || 0) + 1
            const dist = origin.distanceTo(b.position);
            
            (coordsByType[b.name] || (coordsByType[b.name] = [])).push({
              xyz: [b.position.x, b.position.y, b.position.z],
              dist
            })
          }
        }
      }
    }

    // Keep only the nearest few blocks per type, sorted closest-first, so the model can
    // confidently pick the closest instance to move_to/mine.
    const blockCoords = {}
    for (const [name, list] of Object.entries(coordsByType)) {
      list.sort((a, b) => a.dist - b.dist)
      blockCoords[name] = list.slice(0, MAX_COORDS_PER_TYPE).map(e => e.xyz)
    }

    // Mobs/animals around the bot (NOT players — those go in a separate "players" list below).
    // Item-drops are skipped: they're auto-collected, not navigation targets.
    const entities = Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.type !== 'player' && e.name !== 'item'
        && e.position && bot.entity.position.distanceTo(e.position) < 16)
      .map(e => ({ type: e.name || e.kind || e.type, dist: +bot.entity.position.distanceTo(e.position).toFixed(1) }))

    // OTHER PLAYERS (e.g. an opposing bot in a duel). These ARE valid navigation/attack
    // targets, so unlike mobs we report them with their exact "username" AND live coordinates
    // ("at") and we do NOT apply the 16-block cap — a player who wandered off must still be
    // findable so the model can move_to them and then attack_player(username). The bot itself
    // is excluded. Closest-first.
    const players = Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.type === 'player' && e.username && e.username !== bot.username && e.position)
      .map(e => ({
        username: e.username,
        dist: +bot.entity.position.distanceTo(e.position).toFixed(1),
        at: { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) }
      }))
      .sort((a, b) => a.dist - b.dist)

    // "nearby_blocks" = total counts of every block type around you (abundance). "block_coords"
    // = up to the 3 NEAREST coordinates per type, sorted closest-first, each guaranteed to be
    // the block type it is listed under — pick one to move_to/mine.
    return JSON.stringify({
      scanned_radius: scanRadius,
      coords_are: 'nearest blocks per type, sorted closest-first (up to 3 each)',
      nearby_blocks: nearbyBlocks,
      block_coords: blockCoords,
      entities,
      players
    })
  },

  async read_data(bot, { target }) {
    if (!target || typeof target !== 'string') {
      return 'No target given. Call read_data with an item/block name, e.g. read_data({ target: "<item_name>" }).'
    }
    let mcData
    try {
      mcData = loadMcData(bot)
    } catch (e) {
      return `Could not load the knowledge base: ${e.message}`
    }
    if (!mcData || !mcData.itemsByName) return 'Knowledge base unavailable for this version.'

    const name = normalizeName(target)
    const item = mcData.itemsByName[name]
    const block = mcData.blocksByName[name]
    const entity = mcData.entitiesByName ? mcData.entitiesByName[name] : null
    if (!item && !block && !entity) {
      const guesses = suggestNames(mcData, name)
      return `Unknown "${target}". ${guesses.length ? 'Did you mean: ' + guesses.join(', ') + '?' : 'Not found in the knowledge base.'}`
    }

    // This is a READER, not a planner: it only resolves the raw numeric JSON
    // (node_modules/minecraft-data) into readable names and reports the facts as-is.
    // It does NOT pick a "best" recipe, order steps, or build a plan — the model does
    // all of that reasoning itself from these facts.
    const out = { name }
    const displayName = item?.displayName || block?.displayName || entity?.displayName
    if (displayName) out.displayName = displayName

    // Every crafting recipe for this item, ids resolved to names. No ranking/filtering.
    const recipes = item ? (mcData.recipes[item.id] || []) : []
    const seenRecipes = new Set()
    const readableRecipes = []
    for (const r of recipes) {
      const ingredients = mapCounts(mcData, recipeIngredients(r))
      const entry = { ingredients, makes: resultCount(r), needs_crafting_table: needsTable(r) }
      const key = JSON.stringify(entry)
      if (seenRecipes.has(key)) continue   // drop exact-duplicate rows, not real choices
      seenRecipes.add(key)
      readableRecipes.push(entry)
      if (readableRecipes.length >= 12) break
    }
    out.craftable = readableRecipes.length > 0
    if (readableRecipes.length) out.recipes = readableRecipes

    // Mining facts for a world block: what it drops, which tools yield a drop, and the BEST tool —
    // distinguishing a tool that is REQUIRED for any drop (mining it by hand wastes the block) from
    // one that is merely FASTER, so the model can equip the right thing instead of using its hand.
    if (block && block.diggable) {
      const tools = block.harvestTools
        ? Object.keys(block.harvestTools).map(id => mcData.items[+id]?.name).filter(Boolean)
        : []
      const requiredType = toolTypeFromNames(tools)
      const fasterType = bestToolFor(block.material)
      const best_tool = requiredType
        ? `${requiredType} (REQUIRED — mining this by hand drops nothing)`
        : (fasterType ? `${fasterType} (fastest; hand works but is slower)` : 'hand is fine')
      out.mining = {
        drops: blockDropIds(block).map(id => idToName(mcData, id)),
        hardness: block.hardness,
        tools_that_get_a_drop: tools.length ? tools : 'any (hand works)',
        best_tool
      }
    }

    // Mob facts: what this entity DROPS when killed, plus the weapon that kills it fastest.
    if (entity) {
      out.entity = {
        category: entity.category || 'mob',
        drops: entityDropsFor(mcData, name),
        best_weapon: 'sword (kills fastest; an axe also works; a bare hand is slowest)'
      }
    }

    // Reverse lookup: HOW can you obtain this item? Facts derived from recipes (craft), block loot
    // (mine), entity loot (hunt) + a small smelt table — NOT a plan; the model picks the source.
    const sources = itemSources(mcData, name)
    if (Object.keys(sources).length) out.obtained_by = sources

    return JSON.stringify(out)
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

// After a move_to attempt, detect the case where the bot is standing essentially underneath
// the target but still below it in Y — i.e. the only thing left between it and the goal is
// height it can't walk up to (pathfinder no longer builds towers). Returns a FACTUAL state
// report (no tool names, no suggested actions) so the model decides how to gain the height.
// Returns null when there's no such vertical-only gap (then the caller's normal message wins).
function verticalGapReport(bot, target) {
  const p = bot.entity.position
  const dy = Math.floor(target.y) - Math.floor(p.y)
  const xzDist = Math.hypot(target.x - p.x, target.z - p.z)
  if (dy >= 1 && xzDist <= 2.5) {
    return `At ${formatPos(p)}. Target (${target.x}, ${target.y}, ${target.z}) is ${dy} block(s) higher and there is no walkable or diggable route up to it from here.`
  }
  return null
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
    return { error: `Could not collect ${block.name}: no equipped tool yields a drop (it would drop nothing).` }
  }
  try {
    await equipAndConfirm(bot, usable)
    return { note: ` (equipped ${usable.name} first)` }
  } catch (e) {
    return { error: `Failed to equip ${usable.name} to mine ${block.name}: ${e.message}` }
  }
}

// Player-window slot index for each equipment destination (armor + off-hand), used to CONFIRM an
// equip actually landed. bot.getEquipmentDestSlot is preferred at runtime; this is the fallback.
const ARMOR_SLOT = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 }

// Where an item is equipped, by its name: armor goes to its body slot, a shield to the off-hand,
// everything else to the hand. This is what lets `equip` WEAR armor instead of just holding it.
function equipDestination(name) {
  if (/_helmet$/.test(name) || name === 'turtle_helmet' || name === 'carved_pumpkin') return 'head'
  if (/_chestplate$/.test(name) || name === 'elytra') return 'torso'
  if (/_leggings$/.test(name)) return 'legs'
  if (/_boots$/.test(name)) return 'feet'
  if (name === 'shield') return 'off-hand'
  return 'hand'
}

// bot.equip resolves when the server ACKs the inventory move, but the actual destination slot can
// take an extra tick to update — so the NEXT action may run before it lands. Wait until the item
// is actually in the right slot (hand, or the armor/off-hand slot). If it never lands, throw so the
// caller reports an honest failure instead of a false "Equipped X".
async function equipAndConfirm(bot, item, destination = 'hand') {
  await bot.equip(item, destination)
  const inPlace = () => {
    if (destination === 'hand') return !!bot.heldItem && bot.heldItem.type === item.type
    let slot
    try { slot = bot.getEquipmentDestSlot(destination) } catch (_) { slot = ARMOR_SLOT[destination] }
    const s = slot != null && bot.inventory ? bot.inventory.slots[slot] : null
    return !!s && s.type === item.type
  }
  for (let i = 0; i < 20 && !inPlace(); i++) await sleep(25)
  if (!inPlace()) {
    throw new Error(destination === 'hand'
      ? `hand still holds ${bot.heldItem?.name || 'nothing'}`
      : `${item.name} did not move to the ${destination} slot`)
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

// Does a live entity match the type the model asked for? Mineflayer names mobs by their
// lowercase id ("chicken", "cow", "zombie"); we also tolerate a displayName match and a
// loose substring so e.g. "zombie" still finds "zombie_villager".
function entityMatches(entity, name) {
  const candidates = [entity.name, entity.displayName, entity.kind]
    .filter(Boolean)
    .map(s => String(s).toLowerCase().replace(/\s+/g, '_'))
  return candidates.some(c => c === name) || candidates.some(c => c.includes(name))
}

// Chase a single entity into melee range and swing until it dies (or we time out / lose it).
// Returns { killed: true, pos } with the death location for drop collection, or
// { killed: false, reason } when the mob survives past the time cap.
//
// Tracking a MOVING mob is the hard part: pathing to a one-off snapshot of its position
// (GoalNear with fixed x/y/z) sends the bot to where the mob WAS, so a wandering/fleeing
// target is constantly just out of reach. Instead we hand pathfinder a DYNAMIC GoalFollow,
// which keeps re-computing the route toward the mob's live position for the whole fight —
// the bot stays glued to the target instead of giving up after a single stale approach.
async function attackUntilDead(bot, target, { maxHits } = {}) {
  const REACH = 3.5
  const deadline = Date.now() + 30000
  const targetId = target.id
  let lastPos = target.position.clone()
  // Count the swings we actually land (only incremented when in melee range and attacking).
  // When maxHits is set, we stop after that many swings so the caller can hand control back
  // to the model between bursts; when it's null we fall through to the death/timeout guards.
  let hits = 0

  // The server sends an entity-status "dead" packet (mineflayer 'entityDead') the moment an
  // entity actually dies. For PLAYERS this is the only trustworthy kill signal: a player going
  // out of render range also flips entity.isValid to false, so isValid alone can't tell "dead"
  // from "ran away". We latch this flag and treat it as the authoritative death for the result.
  let died = false
  const onDead = (e) => { if (e && e.id === targetId) died = true }
  bot.on('entityDead', onDead)

  bot.pathfinder.setMovements(getMovements(bot))
  // `true` = dynamic goal: pathfinder recalculates as the entity moves, continuously pursuing
  // a target that walks/runs around rather than locking onto one stale coordinate.
  try { bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true) } catch (_) {}

  try {
    while (!died && target.isValid && Date.now() < deadline && (maxHits == null || hits < maxHits)) {
      lastPos = target.position.clone()
      if (bot.entity.position.distanceTo(target.position) <= REACH) {
        // In range: face it and swing, paced to the ~0.6s attack cooldown so each hit lands
        // at full damage. GoalFollow keeps us in range while we trade blows.
        try { await bot.lookAt(target.position.offset(0, target.height ? target.height * 0.5 : 0.5, 0), true) } catch (_) {}
        try { bot.attack(target); hits++ } catch (_) {}
        await sleep(620)
      } else {
        // Out of reach: let the dynamic GoalFollow keep closing the gap; just poll until we
        // are back in melee range (or the target dies / we time out).
        await sleep(150)
      }
    }
  } finally {
    bot.removeListener('entityDead', onDead)
    // Always release pathfinder control so the next action starts from a clean state.
    try { bot.pathfinder.setGoal(null) } catch (_) {}
    try { bot.clearControlStates() } catch (_) {}
  }

  // A confirmed death packet is definitive. For mobs in the arena, isValid going false also
  // reliably means dead (they don't roam out of range), so we keep accepting that too.
  if (died || !target.isValid) return { killed: true, pos: lastPos, hits }
  // Stopped because we reached the requested swing budget (not dead, not timed out): the
  // caller asked for a fixed burst of hits and now gets control back.
  if (maxHits != null && hits >= maxHits) return { killed: false, reason: 'reached the requested number of hits', hits }
  return { killed: false, reason: 'the target kept its distance for too long', hits }
}


// One shared, reusable Movements config (recreating it on every call is wasteful).
function getMovements(bot) {
  if (!bot._mbMovements) {
    const mcData = require('minecraft-data')(bot.version)
    bot._mbMovements = new Movements(bot, mcData)
    bot._mbMovements.diagonalCost = 1.8
    // Don't let pathfinder build 1x1 towers to gain height: its apex-placement timing is
    // unreliable (the bot bounces ~10 times before a block lands). move_to instead reports
    // the remaining vertical gap and leaves the climb to the model (which can pillar up via
    // place_block, choosing a block it can spare).
    bot._mbMovements.allow1by1towers = false
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

// UNSTUCK ASSISTANCE DISABLED — last-resort unstick that dug the block(s) directly in
// front (feet + head height) so the bot could always get past a 1-2 block obstacle.
// async function digInFront(bot) {
//   const yaw = bot.entity.yaw
//   const fx = Math.round(-Math.sin(yaw))
//   const fz = Math.round(Math.cos(yaw))
//   if (fx === 0 && fz === 0) return 0
//   const isSolid = (n) => n && n !== 'air' && n !== 'cave_air' && n !== 'water' && n !== 'lava'
//   let dug = 0
//   for (const cell of [bot.entity.position.offset(fx, 1, fz), bot.entity.position.offset(fx, 0, fz)]) {
//     const b = bot.blockAt(cell)
//     if (b && isSolid(b.name) && bot.canDigBlock(b)) {
//       try { await bot.dig(b); dug++ } catch (_) { /* skip if it can't be dug right now */ }
//     }
//   }
//   return dug
// }

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

// Run pathfinder.goto guarded by a PROGRESS watchdog (no fixed total-time budget).
//
// The bot is only declared "stuck" when it makes NO progress toward the goal for `stallMs`.
// "Progress" means the bot got CLOSER to the target than ever before this trip, OR pathfinder
// is actively mining a block in its path (`isMining`), OR placing scaffolding (`isBuilding`)
// — all of which can keep the bot briefly stationary while still legitimately working toward
// the goal. Because a far target the bot is steadily walking/mining toward keeps hitting new
// closest distances, the watchdog NEVER trips while real progress is happening — however long
// the trip takes. There is intentionally no absolute time cap: defining progress as "getting
// closer" (not "any movement") is what lets us drop it — a bot that merely jitters or paces in
// place without getting closer is still caught by `stallMs`.
//
// pathfinder.goto resolves on goal_reached and rejects on its own for the genuinely-unexpected
// cases (NoPath = unreachable goal, Timeout = couldn't compute a path, GoalChanged, PathStop);
// those pass straight through and surface immediately/accurately.
function gotoWithStallGuard(bot, goal, target, { stallMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const targetVec = target && Number.isFinite(Number(target.x))
      ? new Vec3(Number(target.x), Number(target.y), Number(target.z))
      : null
    let bestDist = targetVec ? bot.entity.position.distanceTo(targetVec) : Infinity
    let lastPos = bot.entity.position.clone()
    let lastProgress = Date.now()
    let settled = false
    const finish = (fn) => { if (settled) return; settled = true; clearInterval(timer); fn() }
    const timer = setInterval(() => {
      let progressed = false
      if (targetVec) {
        // Primary signal: a new closest approach to the goal.
        const d = bot.entity.position.distanceTo(targetVec)
        if (d < bestDist - 0.5) { bestDist = d; progressed = true }
      } else {
        // No target coords available: fall back to raw movement as the progress signal.
        const now = bot.entity.position
        if (lastPos.distanceTo(now) > 0.5) { lastPos = now.clone(); progressed = true }
      }
      let mining = false
      let building = false
      try { mining = bot.pathfinder.isMining() } catch (_) {}
      try { building = bot.pathfinder.isBuilding() } catch (_) {}
      if (progressed || mining || building) lastProgress = Date.now()
      if (Date.now() - lastProgress > stallMs) {
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

// Navigate to a goal. A single attempt, guarded by the progress watchdog above: it runs as
// long as the bot keeps getting closer (or is mining/placing toward the goal) and only fails
// with "stuck" after `stallMs` of no progress — or immediately if pathfinder reports the goal
// is unreachable (NoPath). UNSTUCK ASSISTANCE DISABLED — the automatic stuck-recovery (on a
// stall: facing the target, digging through the obstacle, then hopping forward, retried
// up to 4 times) has been commented out.
async function navigate(bot, goal, target) {
  bot.pathfinder.setMovements(getMovements(bot))
  await gotoWithStallGuard(bot, goal, target)
  return true
  // let lastErr
  // for (let attempt = 0; attempt < 4; attempt++) {
  //   try {
  //     await gotoWithStallGuard(bot, goal)
  //     return true
  //   } catch (e) {
  //     lastErr = e
  //     try { bot.pathfinder.stop() } catch (_) {}
  //     if (target) { try { await faceXZ(bot, target) } catch (_) {} }
  //     if (attempt >= 1) { try { await digInFront(bot) } catch (_) {} }
  //     await walkForwardHopping(bot, 1000)
  //   }
  // }
  // throw new Error((lastErr && lastErr.message) || 'could not navigate')
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
  return `Failed to place ${name}: no open spot next to you.`
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
      : `Could not place ${name} beneath you.`
  } catch (e) {
    bot.setControlState('jump', false)
    return `Failed to pillar up with ${name}: ${e.message}`
  }
}

// ─────────────────────────────────────────────
// KNOWLEDGE-BASE READER (minecraft-data)
// Turns the raw, numeric, deeply-nested JSON in
// node_modules/minecraft-data/.../<version> (items.json, blocks.json, recipes.json)
// into human-readable facts (names instead of ids). It only TRANSLATES the data — it
// makes no decisions; the model reasons over the facts itself.
// ─────────────────────────────────────────────

// Cache the loaded data on the bot (it indexes the same JSON files mineflayer uses).
function loadMcData(bot) {
  if (!bot._mbMcData) bot._mbMcData = require('minecraft-data')(bot.version)
  return bot._mbMcData
}

function normalizeName(s) {
  return String(s).trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
}

// Suggest close item/block names for a typo'd/unknown lookup.
function suggestNames(mcData, name) {
  const pool = new Set([...Object.keys(mcData.itemsByName), ...Object.keys(mcData.blocksByName)])
  const out = []
  for (const n of pool) {
    if (n.includes(name) || name.includes(n)) { out.push(n); if (out.length >= 5) break }
  }
  return out
}

// Map any item/block id to a readable name (prefer item names, fall back to blocks).
function idToName(mcData, id) {
  return mcData.items[id]?.name || mcData.blocks[id]?.name || `id_${id}`
}

// A recipe cell/ingredient may be: null, a number, an {id,count} object, or an array of
// choices (any-of). Reduce it to a single item id (or null for an empty slot).
function ingredientId(x) {
  if (x == null) return null
  if (typeof x === 'number') return x < 0 ? null : x
  if (Array.isArray(x)) return ingredientId(x[0])
  if (typeof x === 'object') return ingredientId(x.id)
  return null
}

// Aggregate a recipe's inputs into { itemId: count }, handling shaped + shapeless forms.
function recipeIngredients(recipe) {
  const counts = {}
  const add = (id) => { if (id != null) counts[id] = (counts[id] || 0) + 1 }
  if (recipe.inShape) {
    for (const row of recipe.inShape) for (const cell of row) add(ingredientId(cell))
  } else if (recipe.ingredients) {
    for (const ing of recipe.ingredients) add(ingredientId(ing))
  }
  return counts
}

function resultCount(recipe) {
  const r = recipe.result
  if (r == null || typeof r === 'number') return 1
  return r.count || 1
}

// A recipe fits a 2x2 inventory grid (no table) only if it is shapeless with <=4 inputs
// or shaped within a 2x2 footprint; anything larger needs a crafting_table.
function needsTable(recipe) {
  if (!recipe.inShape) return (recipe.ingredients || []).length > 4
  const rows = recipe.inShape.length
  const cols = Math.max(...recipe.inShape.map(r => r.length))
  return rows > 2 || cols > 2
}

function mapCounts(mcData, idCounts) {
  const out = {}
  for (const [id, c] of Object.entries(idCounts)) out[idToName(mcData, +id)] = c
  return out
}

// Normalize a block's drops (numbers or {drop:{id}} objects) into an array of item ids.
function blockDropIds(block) {
  return (block.drops || []).map(d => {
    if (typeof d === 'number') return d
    if (d && typeof d === 'object') return d.drop?.id ?? d.drop ?? d.item ?? null
    return null
  }).filter(id => id != null)
}

// Items actually sitting in an OPEN chest window (the container slots, NOT the player's inventory).
// Reading this is the server's ground truth for "what's in the chest".
function chestContainerItems(chest) {
  try {
    if (chest && typeof chest.containerItems === 'function') return chest.containerItems().filter(Boolean)
  } catch (_) {}
  const end = chest && chest.inventoryStart != null ? chest.inventoryStart : (chest && chest.slots ? chest.slots.length : 0)
  return ((chest && chest.slots) || []).slice(0, end).filter(Boolean)
}

function chestCount(chest, name) {
  let n = 0
  for (const it of chestContainerItems(chest)) if (it.name === name) n += it.count
  return n
}

// Record the chest's TRUE contents onto the bot as the authoritative "stored" tally the harness
// scores. Monotonic union (max per item) so once we've seen an item in a chest it stays counted —
// there is no withdraw tool, so chest contents only ever accumulate.
function recordChestContents(bot, chest) {
  bot._storedItems = bot._storedItems || {}
  const counts = {}
  for (const it of chestContainerItems(chest)) counts[it.name] = (counts[it.name] || 0) + it.count
  for (const [n, c] of Object.entries(counts)) bot._storedItems[n] = Math.max(bot._storedItems[n] || 0, c)
}

// Curated furnace smelts that the data files don't expose cleanly (output -> typical inputs).
// Facts, not a plan — used by read_data's "obtained_by" so the model can reason about smelting.
const SMELTS = {
  iron_ingot: ['raw_iron', 'iron_ore', 'deepslate_iron_ore'],
  gold_ingot: ['raw_gold', 'gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'],
  copper_ingot: ['raw_copper', 'copper_ore', 'deepslate_copper_ore'],
  glass: ['sand', 'red_sand'],
  stone: ['cobblestone'],
  smooth_stone: ['stone'],
  charcoal: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'],
  cooked_beef: ['beef'], cooked_porkchop: ['porkchop'], cooked_chicken: ['chicken'],
  cooked_mutton: ['mutton'], cooked_cod: ['cod'], cooked_salmon: ['salmon'],
  cooked_rabbit: ['rabbit'], baked_potato: ['potato'], dried_kelp: ['kelp']
}

// The FASTEST tool type for a block, parsed from minecraft-data's "material" tag
// (e.g. "mineable/axe" -> "axe", "plant;mineable/axe" -> "axe"). null when no tool beats the hand.
// This is a SPEED hint; harvestTools separately says which tools yield a DROP at all.
function bestToolFor(material) {
  if (!material || typeof material !== 'string') return null
  const m = material.split(';').find(s => s.startsWith('mineable/'))
  return m ? m.split('/')[1] : null
}

// The tool TYPE (pickaxe/axe/shovel/hoe/sword) shared by a list of tool item names, e.g.
// ["stone_pickaxe","iron_pickaxe"] -> "pickaxe". Used to name a block's REQUIRED harvest tool
// when minecraft-data's material tag only encodes the tier (e.g. ores -> "incorrect_for_*_tool").
function toolTypeFromNames(names) {
  for (const n of (names || [])) {
    const m = /_(pickaxe|axe|shovel|hoe|sword)$/.exec(n)
    if (m) return m[1]
  }
  return null
}

// Item names a mob drops when killed (from minecraft-data's entityLoot).
function entityDropsFor(mcData, entityName) {
  const loot = mcData.entityLoot && mcData.entityLoot[entityName]
  if (!loot || !Array.isArray(loot.drops)) return []
  return [...new Set(loot.drops.map(d => d.item).filter(Boolean))]
}

// Reverse index: how can the player OBTAIN this item? Pure facts from the game data
// (recipes -> craft, block loot -> mine, entity loot -> hunt) plus a small curated smelt table.
// NOT a plan: it lists the available sources; the model decides which one to pursue.
function itemSources(mcData, name) {
  const out = {}
  const itemData = mcData.itemsByName[name]
  if (itemData && (mcData.recipes[itemData.id] || []).length) out.craft = true
  const mineBlocks = []
  for (const [block, entry] of Object.entries(mcData.blockLoot || {})) {
    if (entry && Array.isArray(entry.drops) && entry.drops.some(d => d.item === name)) mineBlocks.push(block)
    if (mineBlocks.length >= 8) break
  }
  if (mineBlocks.length) out.mine = mineBlocks
  if (SMELTS[name]) out.smelt = SMELTS[name]
  const huntMobs = []
  for (const [mob, entry] of Object.entries(mcData.entityLoot || {})) {
    if (entry && Array.isArray(entry.drops) && entry.drops.some(d => d.item === name)) huntMobs.push(mob)
    if (huntMobs.length >= 8) break
  }
  if (huntMobs.length) out.hunt = huntMobs
  return out
}

module.exports = { TOOL_SCHEMAS, TOOL_IMPLS, executeAction, STOP_SIGNAL, itemSources, entityDropsFor, bestToolFor, toolTypeFromNames, recordChestContents, equipDestination }
