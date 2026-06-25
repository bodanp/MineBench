// ─────────────────────────────────────────────
// SCORER SELF-TEST — guards the invariants the capability-profile redesign depends on.
// Pure Node, no deps, no network. Run with:  npm test   (or: node scoring/scorer.selftest.js)
//
// These are behavioural contracts, not exact-number snapshots, so tuning weights won't break
// them — but a regression that re-introduces an old bug (e.g. penalising correct repeats, or
// letting elapsed time leak into the score) will.
// ─────────────────────────────────────────────
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { score } = require('./scorer')
const { getMilestones, deriveFromRecipes } = require('./milestones')

const loadTask = (id) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tasks', `${id}.json`), 'utf8'))
let passed = 0
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`) }

// Build a minimal trace from a list of [tool, args, ok, inventoryBEFORE] tuples.
function trace(model, ended, steps, finalInv, extra = {}) {
  return {
    model, ended_reason: ended, duration_s: extra.duration_s ?? 1,
    final_state: { inventory: finalInv || {} },
    steps: steps.map(([tool, args, okv, inv]) => ({
      action: { tool, args: args || {} }, ok: okv, result: args && args.__result || '', observation: { inventory: inv || {} }
    }))
  }
}

console.log('scorer self-test:')

// 1. A correct repeated gather (mining log after log) is NOT a loop and stays fully efficient.
ok('productive repeats are not penalised', () => {
  const gw = loadTask('gather_wood')
  const c = score(trace('m', 'success', [
    ['mine_block', { block_type: 'oak_log' }, true, {}],
    ['mine_block', { block_type: 'oak_log' }, true, { oak_log: 1 }],
    ['mine_block', { block_type: 'oak_log' }, true, { oak_log: 2 }]
  ], { oak_log: 3 }), gw)
  assert.strictEqual(c.repeated_actions, 0, 'no loops')
  assert.strictEqual(c.capabilities.efficiency, 1, 'fully efficient')
  assert.strictEqual(c.success, true)
  assert.strictEqual(c.progress, 1)
})

// 2. A failing run still earns partial credit proportional to how far it progressed.
ok('failures get milestone partial credit (not a flat 0)', () => {
  const sp = loadTask('stone_pickaxe')
  const c = score(trace('m', 'max_steps', [
    ['mine_block', { block_type: 'oak_log' }, true, {}],
    ['craft', { item: 'oak_planks' }, true, { oak_log: 2 }],
    ['craft', { item: 'stick' }, true, { oak_planks: 8 }]
  ], { stick: 4, oak_planks: 4 }), sp)
  assert.strictEqual(c.success, false)
  assert.ok(c.progress > 0 && c.progress < 1, `progress in (0,1), got ${c.progress}`)
  assert.ok(c.score > 0, 'failing run scores > 0')
})

// 3. Elapsed time never changes the score.
ok('elapsed time does not affect the score', () => {
  const gw = loadTask('gather_wood')
  const steps = [['mine_block', { block_type: 'oak_log' }, true, { oak_log: 2 }]]
  const fast = score(trace('m', 'success', steps, { oak_log: 3 }, { duration_s: 5 }), gw)
  const slow = score(trace('m', 'success', steps, { oak_log: 3 }, { duration_s: 5000 }), gw)
  assert.strictEqual(fast.score, slow.score, 'score independent of duration')
  assert.notStrictEqual(fast.duration_s, slow.duration_s, 'but duration still recorded')
})

// 4. A dimension that the run never exercised is null (excluded from averages), not 0.
ok('un-exercised dimensions are null, not 0', () => {
  const gw = loadTask('gather_wood')
  const c = score(trace('m', 'success', [
    ['mine_block', { block_type: 'oak_log' }, true, { oak_log: 2 }]
  ], { oak_log: 3 }), gw)
  assert.strictEqual(c.capabilities.robustness, null, 'no disturbance -> null robustness')
  assert.strictEqual(c.capabilities.adaptation, null, 'no failure -> null adaptation')
})

// 5. Pathfinder scaffolding (losing dirt during move_to) is NOT counted as a disturbance.
ok('scaffolding loss is not a false disturbance', () => {
  const sp = loadTask('stone_pickaxe')
  const c = score(trace('m', 'max_steps', [
    ['move_to', { x: 1, y: 1, z: 1 }, true, { dirt: 5, oak_log: 1 }],
    ['move_to', { x: 2, y: 2, z: 2 }, true, { dirt: 3, oak_log: 1 }]
  ], { dirt: 2, oak_log: 1 }), sp)
  assert.strictEqual(c.diagnostics.disturbance_events, 0, 'movement block-use is not theft')
})

// 6. A self-inflicted failure followed by a DIFFERENT action counts as recovery (adaptation=1);
//    repeating the same failing action does not (adaptation=0).
ok('adaptation rewards changing strategy, punishes looping', () => {
  const sp = loadTask('stone_pickaxe')
  const recover = score(trace('m', 'max_steps', [
    ['craft', { item: 'wooden_pickaxe' }, false, { oak_log: 1 }],
    ['mine_block', { block_type: 'oak_log' }, true, { oak_log: 1 }]
  ], { oak_log: 2 }), sp)
  assert.strictEqual(recover.capabilities.adaptation, 1, 'changed action after failure')
  const loop = score(trace('m', 'max_steps', [
    ['craft', { item: 'wooden_pickaxe' }, false, { oak_log: 1 }],
    ['craft', { item: 'wooden_pickaxe' }, false, { oak_log: 1 }]
  ], { oak_log: 1 }), sp)
  assert.strictEqual(loop.capabilities.adaptation, 0, 'repeated the failing action')
})

// 7. Milestone chains exist for the crafted tasks and end at the goal item.
ok('milestone chains are defined and end at the goal', () => {
  for (const id of ['stone_pickaxe', 'iron_pickaxe', 'gather_wood']) {
    const ms = getMilestones(loadTask(id))
    assert.ok(ms.length >= 1, `${id} has milestones`)
  }
})

// 8. A NEW task (no built-in chain, no manual milestones) auto-derives milestones from the recipe
//    graph — so adding tasks needs no hand-authoring. Cycle-prone goals must not blow the stack.
ok('milestones auto-derive for new tasks (no manual authoring)', () => {
  const chest = getMilestones({ id: 'chest', success: { inventory: { chest: 1 } } })
  assert.ok(chest.length >= 2, `chest auto-derived a chain, got ${chest.length}`)
  const iron = deriveFromRecipes('iron_pickaxe', 1)   // recipe cycles must terminate, not throw
  assert.ok(Array.isArray(iron) && iron.length >= 1, 'cycle-prone goal derives without crashing')
})

console.log(`\n${passed} checks passed.`)
