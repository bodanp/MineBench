// ─────────────────────────────────────────────
// CONTEXT SELF-TEST — guards the Minecraft-context helpers that give the agent (a) perception
// parity (mobs in the observation, via observation.nearestEntities) and (b) on-demand game FACTS
// (mob drops, "how to obtain X", best tool — via read_data's helpers in skills.js).
//
// These are perception/fact helpers, NOT planners: they must surface what the world/data say and
// let the model reason. Pure Node, no network, no live bot. Run with: node agent/context.selftest.js
// ─────────────────────────────────────────────
const assert = require('assert')
const Vec3 = require('vec3')
const MCD = require('minecraft-data')
const { itemSources, entityDropsFor, bestToolFor, toolTypeFromNames, recordChestContents, equipDestination, TOOL_IMPLS } = require('./skills')
const { nearestEntities } = require('./observation')

// Pick any installed minecraft-data version that ships the loot tables we read.
function pickVersion() {
  for (const v of ['1.21.9', '1.21.8', '1.21.6', '1.21.4', '1.21.1', '1.20.6', '1.20.4']) {
    try { const d = MCD(v); if (d && d.entityLoot && d.entityLoot.cow && d.blockLoot) return v } catch (_) {}
  }
  return null
}

let passed = 0
const ok = (name, fn) => { fn(); passed++; console.log(`  \u2713 ${name}`) }

console.log('context self-test:')

const ver = pickVersion()
assert.ok(ver, 'found an installed minecraft-data version with loot tables')
const mcData = MCD(ver)
console.log(`  (using minecraft-data ${ver})`)

// 1. best_tool is parsed from the material tag (a SPEED hint), null when the hand is fine.
ok('bestToolFor parses the material tag; null when no tool beats the hand', () => {
  assert.strictEqual(bestToolFor('mineable/axe'), 'axe')
  assert.strictEqual(bestToolFor('mineable/pickaxe'), 'pickaxe')
  assert.strictEqual(bestToolFor('plant;mineable/axe'), 'axe')          // compound material tag
  assert.strictEqual(bestToolFor('incorrect_for_wooden_tool'), null)    // tier string, no tool type
  assert.strictEqual(bestToolFor(undefined), null)
})

// 1b. For ores the material tag is only a tier, so the REQUIRED tool type is derived from the
//     harvest-tool item names instead.
ok('toolTypeFromNames derives the tool type from harvest-tool names', () => {
  assert.strictEqual(toolTypeFromNames(['copper_pickaxe', 'iron_pickaxe']), 'pickaxe')
  assert.strictEqual(toolTypeFromNames(['stone_axe']), 'axe')
  assert.strictEqual(toolTypeFromNames([]), null)
})

// 2. A mob's drops come straight from the game's entity loot table (cow -> leather + beef).
ok('entityDropsFor returns a mob\'s drops (cow -> leather + beef)', () => {
  const drops = entityDropsFor(mcData, 'cow')
  assert.ok(drops.includes('leather'), 'cow drops leather')
  assert.ok(drops.includes('beef'), 'cow drops beef')
  assert.deepStrictEqual(entityDropsFor(mcData, 'not_a_mob'), [], 'unknown mob -> no drops')
})

// 3. The reverse "how do I obtain X" index is derived from real data (facts, not a plan).
ok('itemSources reverse-indexes how to obtain an item', () => {
  const leather = itemSources(mcData, 'leather')
  assert.ok(Array.isArray(leather.hunt) && leather.hunt.includes('cow'), 'leather is hunted from cows')
  const rawIron = itemSources(mcData, 'raw_iron')
  assert.ok(Array.isArray(rawIron.mine) && rawIron.mine.includes('iron_ore'), 'raw_iron is mined from iron_ore')
  const ironIngot = itemSources(mcData, 'iron_ingot')
  assert.ok(Array.isArray(ironIngot.smelt) && ironIngot.smelt.includes('raw_iron'), 'iron_ingot is smelted from raw_iron')
})

// 4. The entity radar reports the NEAREST mob of each type with coords + category, and excludes
//    players and item-drops (perception parity with the block radar — not a plan).
ok('nearestEntities radars the nearest mob per type, excluding players and drops', () => {
  const bot = {
    version: ver,
    entity: { position: new Vec3(0, 64, 0), yaw: 0 },
    heldItem: null,
    entities: {
      1: { id: 1, type: 'mob', name: 'cow', position: new Vec3(5, 64, 0) },
      2: { id: 2, type: 'mob', name: 'cow', position: new Vec3(20, 64, 0) },
      3: { id: 3, type: 'mob', name: 'zombie', position: new Vec3(0, 64, 8) },
      4: { id: 4, type: 'player', username: 'Someone', name: 'Someone', position: new Vec3(2, 64, 2) },
      5: { id: 5, type: 'object', name: 'item', position: new Vec3(1, 64, 1) }
    }
  }
  const near = nearestEntities(bot)
  assert.ok(near.cow, 'cow is reported')
  assert.strictEqual(near.cow.dist, 5, 'reports the NEAREST cow (dist 5, not 20)')
  assert.deepStrictEqual(near.cow.at, { x: 5, y: 64, z: 0 }, 'with its coordinates')
  assert.ok(/passive/i.test(near.cow.category), 'cow tagged as a Passive mob')
  assert.ok(near.zombie, 'zombie is reported')
  assert.ok(!near.Someone && !near.item, 'players and item-drops are excluded')
})

// 4b. store_in_chest scores from the chest's TRUE contents (authoritative + monotonic), so a
//     deposit whose player-inventory update lagged is still counted and re-reads never lose it.
//     This guards the "crafted + placed in chest but scored fail" desync bug.
ok('recordChestContents records true chest contents (authoritative, monotonic)', () => {
  const bot = { _storedItems: {} }
  recordChestContents(bot, { containerItems: () => [{ name: 'wooden_axe', count: 1 }, { name: 'wooden_hoe', count: 1 }] })
  assert.strictEqual(bot._storedItems.wooden_axe, 1)
  assert.strictEqual(bot._storedItems.wooden_hoe, 1)
  // a later open that momentarily shows fewer items must NOT erase what we already recorded
  recordChestContents(bot, { containerItems: () => [{ name: 'wooden_axe', count: 1 }] })
  assert.strictEqual(bot._storedItems.wooden_hoe, 1, 'previously-seen item stays counted')
  // growing counts are picked up
  recordChestContents(bot, { containerItems: () => [{ name: 'wooden_axe', count: 3 }] })
  assert.strictEqual(bot._storedItems.wooden_axe, 3)
})

// 4c. equip routes armor to its body slot (so it is WORN, not just held) and tools to the hand —
//     the basis of the "craft and wear a full armor set" tasks.
ok('equipDestination routes armor to its slot, tools to the hand', () => {
  assert.strictEqual(equipDestination('leather_helmet'), 'head')
  assert.strictEqual(equipDestination('iron_chestplate'), 'torso')
  assert.strictEqual(equipDestination('diamond_leggings'), 'legs')
  assert.strictEqual(equipDestination('golden_boots'), 'feet')
  assert.strictEqual(equipDestination('shield'), 'off-hand')
  assert.strictEqual(equipDestination('wooden_pickaxe'), 'hand')
})

// 5. read_data integration: best_tool wording distinguishes a REQUIRED tool (ore) from a merely
//    FASTER one (wood) — the fix for ores whose material tag only encodes the tier.
;(async () => {
  const bot = { version: ver }
  const ore = JSON.parse(await TOOL_IMPLS.read_data(bot, { target: 'iron_ore' }))
  assert.ok(/pickaxe/.test(ore.mining.best_tool) && /REQUIRED/.test(ore.mining.best_tool),
    `ore best_tool should be a REQUIRED pickaxe, got "${ore.mining.best_tool}"`)
  const log = JSON.parse(await TOOL_IMPLS.read_data(bot, { target: 'oak_log' }))
  assert.ok(/axe \(fastest/.test(log.mining.best_tool),
    `wood best_tool should be a faster axe, got "${log.mining.best_tool}"`)
  passed++
  console.log('  \u2713 read_data best_tool: REQUIRED pickaxe for ore, faster axe for wood')
  console.log(`\n${passed} checks passed.`)
})().catch(e => { console.error('  \u2717 read_data integration failed:', e.message); process.exit(1) })
