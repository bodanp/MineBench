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
      name: 'smelt',
      description: 'Smelt items in the nearest furnace (within 32 blocks) using a fuel you specify. Loads the input + fuel, waits for smelting to finish, collects the output, and returns any leftovers to your inventory. Reports the VERIFIED result — what actually came out — not advice. Needs the input item and the fuel item already in your inventory.',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Item to smelt, e.g. "raw_iron", "sand", "raw_copper", "potato".' },
          fuel: { type: 'string', description: 'Fuel item to burn, e.g. "coal", "charcoal", "oak_planks".' },
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
      name: 'read_data',
      description: 'Look up the game data for an item or block and get the raw FACTS in readable form (names instead of numbers): every crafting recipe with its ingredient names + amounts and whether it needs a crafting_table, and — for blocks — what the block drops and which tools yield a drop. This is a reference lookup, NOT instructions: it does not tell you what to do or pick a recipe for you. YOU read the facts and decide which recipe to use and what to do next. Returns JSON: { name, recipes, mining }.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Item or block name to look up, e.g. "stone_pickaxe", "oak_planks", "iron_ore". Lowercase underscored names work best; "minecraft:" prefix and spaces are tolerated.' }
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
      ? ' (still blocked — the obstacle may be 2+ blocks tall)'
      : ''
    return `Moved forward ${ms / 1000}s, traveled ${traveled} blocks to ${formatPos(bot.entity.position)}${note}`
  },

  async mine_block(bot, { block_type }) {
    const mcData = loadMcData(bot)
    const name = normalizeName(block_type)
    const blockId = mcData.blocksByName[name]?.id
    if (blockId === undefined) {
      const guesses = suggestNames(mcData, name)
      return `Unknown block: ${block_type}.${guesses.length ? ' Similar names: ' + guesses.join(', ') + '.' : ''}`
    }

    const block = bot.findBlock({ matching: blockId, maxDistance: 32 })
    if (!block) return `No ${name} found within 32 blocks.`

    // Make sure we'll actually COLLECT a drop: stone/ores break into nothing unless the
    // right tool is held. Auto-equip the best tool we own; refuse if we have none so the
    // model goes and crafts a pickaxe instead of wasting the block by hand.
    const tool = await ensureHarvestTool(bot, block)
    if (tool.error) return tool.error

    // Name this block is expected to drop, so we report on the SPECIFIC drop that lands in
    // the inventory rather than on whatever the bot happened to vacuum up (old ground litter
    // like dirt from earlier mining gets picked up mid-action and must NOT be misattributed
    // to this block).
    const expectedDrop = blockDropIds(block).map(id => idToName(mcData, id)).filter(Boolean)[0] || name

    // Report the VERIFIED result for THIS block's drop only: compare the expectedDrop's count
    // before/after. The block can break yet collect nothing (drop not yet picked up), and the
    // bot can incidentally pick up unrelated items — neither should be reported as this block's
    // yield. The per-step observation inventory still shows total counts for everything else.
    const report = (before, note) => {
      const gained = (readInventory(bot)[expectedDrop] || 0) - (before[expectedDrop] || 0)
      return gained > 0
        ? `Broke ${name} at ${formatPos(block.position)}; collected ${gained}x ${expectedDrop}.${note}`
        : `Broke ${name} at ${formatPos(block.position)}; drop (${expectedDrop}) not collected yet.${note}`
    }

    try {
      const before = readInventory(bot)
      await navigate(bot, new goals.GoalLookAtBlock(block.position, bot.world), block.position)
      await bot.dig(block)
      await collectNearbyDrops(bot, block.position)
      await settleInventory(bot, before, expectedDrop)
      return report(before, tool.note)
    } catch (e) {
      // Navigation may have stalled but left us within reach — try digging anyway.
      try {
        if (bot.entity.position.distanceTo(block.position) <= 5) {
          const before = readInventory(bot)
          await bot.dig(block)
          await collectNearbyDrops(bot, block.position)
          await settleInventory(bot, before, expectedDrop)
          return report(before, tool.note)
        }
      } catch (_) { /* fall through to the failure message */ }
      return `Failed to mine ${name}: ${e.message}`
    }
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
    try {
      await equipAndConfirm(bot, i)
      return `Equipped ${name}.`
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

  async read_data(bot, { target }) {
    if (!target || typeof target !== 'string') {
      return 'No target given. Call read_data with an item/block name, e.g. read_data({ target: "stone_pickaxe" }).'
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
    if (!item && !block) {
      const guesses = suggestNames(mcData, name)
      return `Unknown "${target}". ${guesses.length ? 'Did you mean: ' + guesses.join(', ') + '?' : 'Not found in the knowledge base.'}`
    }

    // This is a READER, not a planner: it only resolves the raw numeric JSON
    // (node_modules/minecraft-data) into readable names and reports the facts as-is.
    // It does NOT pick a "best" recipe, order steps, or build a plan — the model does
    // all of that reasoning itself from these facts.
    const out = { name }
    const displayName = item?.displayName || block?.displayName
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

    // Mining facts for a world block: what it drops + which tools yield a drop.
    if (block && block.diggable) {
      const tools = block.harvestTools
        ? Object.keys(block.harvestTools).map(id => mcData.items[+id]?.name).filter(Boolean)
        : []
      out.mining = {
        drops: blockDropIds(block).map(id => idToName(mcData, id)),
        hardness: block.hardness,
        tools_that_get_a_drop: tools.length ? tools : 'any (hand works)'
      }
    }

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

// bot.equip resolves when the server ACKs the inventory move, but the actual held-hand slot
// can take an extra tick to update — so the NEXT action (e.g. mine_block) may run while the
// hand still holds the OLD item (the "it only switched after mining" bug). Wait until the
// hand actually holds the requested item (short bounded poll). If it still hasn't switched,
// throw so the caller reports an honest failure instead of a false "Equipped X".
async function equipAndConfirm(bot, item) {
  await bot.equip(item, 'hand')
  for (let i = 0; i < 20 && bot.heldItem?.type !== item.type; i++) await sleep(25)
  if (bot.heldItem?.type !== item.type) {
    throw new Error(`hand still holds ${bot.heldItem?.name || 'nothing'}`)
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
    bot._mbMovements.diagonalCost = 1.8
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

// Run pathfinder.goto with only a hard overall time cap so it can't hang forever.
// UNSTUCK ASSISTANCE DISABLED — the stall detection (aborting with "stuck" when the bot
// stopped making progress, which triggered stuck-recovery) has been commented out.
function gotoWithStallGuard(bot, goal, { stallMs = 2000, maxMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    // let last = bot.entity.position.clone()
    // let lastProgress = Date.now()
    const started = Date.now()
    let settled = false
    const finish = (fn) => { if (settled) return; settled = true; clearInterval(timer); fn() }
    const timer = setInterval(() => {
      // const now = bot.entity.position
      // if (last.distanceTo(now) > 0.15) { last = now.clone(); lastProgress = Date.now() }
      // Stall-based stuck detection removed; only the hard maxMs cap remains.
      if (/* Date.now() - lastProgress > stallMs || */ Date.now() - started > maxMs) {
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

// Navigate to a goal. UNSTUCK ASSISTANCE DISABLED — the automatic stuck-recovery (on a
// stall: facing the target, digging through the obstacle, then hopping forward, retried
// up to 4 times) has been commented out. Navigation now makes a single attempt.
async function navigate(bot, goal, target) {
  bot.pathfinder.setMovements(getMovements(bot))
  await gotoWithStallGuard(bot, goal)
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

module.exports = { TOOL_SCHEMAS, TOOL_IMPLS, executeAction, STOP_SIGNAL }
