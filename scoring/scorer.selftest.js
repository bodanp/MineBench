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
const { score, checkSuccess } = require('./scorer')
const { getMilestones, validateMilestones } = require('./milestones')

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

// 7. Each shipped task defines a well-formed milestone DAG that ends at the goal.
ok('task milestone DAGs are valid and end at the goal', () => {
  const goalOf = { stone_pickaxe: 'stone_pickaxe', iron_pickaxe: 'iron_pickaxe', gather_wood: 'oak_log' }
  const matchesGoal = (node, item) =>
    (node.item === item) || (node.any && node.any.includes(item)) || (node.suffix && item.endsWith(node.suffix))
  for (const id of ['stone_pickaxe', 'iron_pickaxe', 'gather_wood']) {
    const task = loadTask(id)
    assert.deepStrictEqual(validateMilestones(task), [], `${id} milestones are well-formed`)
    const ms = getMilestones(task)
    assert.ok(ms.length >= 1, `${id} has milestones`)
    assert.ok(matchesGoal(ms[ms.length - 1], goalOf[id]), `${id} chain ends at ${goalOf[id]}`)
  }
})

// 8. Milestones are TASK-DEFINED only: a task with no `milestones` array yields an empty chain, so
//    completion is null but the four milestone-free dimensions still score the run.
ok('tasks own their milestones; none declared -> empty chain, still scored', () => {
  const task = { id: 'x', success: { inventory: { chest: 1 } } }
  assert.deepStrictEqual(getMilestones(task), [], 'no auto-derivation')
  const c = score(trace('m', 'max_steps', [
    ['craft', { item: 'chest' }, false, { oak_planks: 2 }]
  ], { oak_planks: 2 }), task)
  assert.strictEqual(c.capabilities.completion, null, 'no milestones -> completion null')
  assert.strictEqual(c.progress, null, 'no milestones -> progress null')
  assert.ok(c.capabilities.tool_use != null, 'behaviour dimensions still scored')
})

// 9. validateMilestones flags the mistakes a task author can make (dangling dep, duplicate id).
ok('validateMilestones catches dangling deps and duplicate ids', () => {
  const dangling = validateMilestones({ milestones: [{ id: 'a', item: 'x', deps: ['ghost'] }] })
  assert.ok(dangling.some(e => /unknown id "ghost"/.test(e)), 'reports dangling dep')
  const dup = validateMilestones({ milestones: [{ id: 'a', item: 'x' }, { id: 'a', item: 'y' }] })
  assert.ok(dup.some(e => /duplicate milestone id/.test(e)), 'reports duplicate id')
})

// 10. Combat success DSL: killed_entity counts real mob deaths; a bare string means "at least one".
ok('killed_entity needs the required kill counts', () => {
  const task = { id: 'z', success: { killed_entity: { zombie: 3 } } }
  assert.strictEqual(checkSuccess({ killed_entities: { zombie: 3 } }, task), true, 'exact count succeeds')
  assert.strictEqual(checkSuccess({ killed_entities: { zombie: 5 } }, task), true, 'more than enough succeeds')
  assert.strictEqual(checkSuccess({ killed_entities: { zombie: 2 } }, task), false, 'short of count fails')
  assert.strictEqual(checkSuccess({ killed_entities: {} }, task), false, 'no kills fails')
  const bare = { id: 'z2', success: { killed_entity: 'skeleton' } }
  assert.strictEqual(checkSuccess({ killed_entities: { skeleton: 1 } }, bare), true, 'string form = at least one')
  assert.strictEqual(checkSuccess({ killed_entities: { zombie: 9 } }, bare), false, 'wrong type does not count')
})

// 11. Survival success DSL: only credited when the harness reports the bot stayed alive.
ok('survived only succeeds when state.survived is true', () => {
  const task = { id: 's', success: { survived: true } }
  assert.strictEqual(checkSuccess({ survived: true }, task), true, 'alive at end succeeds')
  assert.strictEqual(checkSuccess({ survived: false }, task), false, 'died fails')
  assert.strictEqual(checkSuccess({}, task), false, 'unknown (mid-run) never succeeds early')
})

// 12. Shipped combat/survival tasks are well-formed and use the new success DSL.
ok('combat and survival tasks load with valid success specs', () => {
  const cz = loadTask('clear_zombies')
  assert.deepStrictEqual(cz.success, { killed_entity: { zombie: 3 } }, 'clear_zombies kills 3 zombies')
  assert.strictEqual(checkSuccess({ killed_entities: { zombie: 3 } }, cz), true)
  const sn = loadTask('survive_night')
  assert.deepStrictEqual(sn.success, { survived: true }, 'survive_night requires survival')
  assert.strictEqual(checkSuccess({ survived: true }, sn), true)
})

console.log(`\n${passed} checks passed.`)
