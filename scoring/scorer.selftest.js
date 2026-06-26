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
const { score, reconstructPlacements, summarizeBuild } = require('./scorer')
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

// 10. "store it in a chest" tasks pass ONLY on a verified deposit — merely CRAFTING the item (even
//     holding all of it) must not pass, because storing empties it from the inventory. This also
//     guards the goalReached fallback from leaking a false pass on world-effect tasks.
ok('stored predicate: crafting is not storing; only a chest deposit passes', () => {
  const task = loadTask('wooden_toolset_chest')
  const tools = ['wooden_sword', 'wooden_pickaxe', 'wooden_axe', 'wooden_shovel', 'wooden_hoe']
  const held = Object.fromEntries(tools.map(t => [t, 1]))
  const craftedNotStored = {
    model: 'm', ended_reason: 'max_steps', duration_s: 1,
    final_state: { inventory: held, stored: {} },
    steps: tools.map(p => ({ action: { tool: 'craft', args: { item: p } }, ok: true, result: `Crafted 1x ${p}.`, observation: { inventory: { oak_planks: 20 } }, pos: [0, 64, 0] }))
  }
  const c1 = score(craftedNotStored, task)
  assert.strictEqual(c1.success, false, 'holding the full set is NOT storing it')
  assert.strictEqual(c1.outcome, 'fail')

  const deposited = {
    model: 'm', ended_reason: 'agent_stop', duration_s: 1,
    final_state: { inventory: {}, stored: held },
    steps: []
  }
  const c2 = score(deposited, task)
  assert.strictEqual(c2.success, true, 'all five deposited in a chest -> success')
  assert.strictEqual(c2.outcome, 'success')
})

// 10b. "wear a full armor set" tasks pass ONLY when the armor is actually WORN (in the armor slots),
//      not merely crafted/held — worn armor is not in the inventory, and the goalReached fallback
//      must not leak a pass from holding the milestone-sink piece.
ok('worn predicate: crafting armor is not wearing it; only equipping passes', () => {
  const task = loadTask('leather_armor')
  const pieces = ['leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots']
  const held = Object.fromEntries(pieces.map(p => [p, 1]))
  const craftedNotWorn = {
    model: 'm', ended_reason: 'max_steps', duration_s: 1,
    final_state: { inventory: held, worn: {} },
    steps: pieces.map(p => ({ action: { tool: 'craft', args: { item: p } }, ok: true, result: `Crafted 1x ${p}.`, observation: { inventory: { leather: 24 } }, pos: [0, 64, 0] }))
  }
  const c1 = score(craftedNotWorn, task)
  assert.strictEqual(c1.success, false, 'holding the armor is NOT wearing it')
  assert.strictEqual(c1.outcome, 'fail')

  const worn = {
    model: 'm', ended_reason: 'agent_stop', duration_s: 1,
    final_state: { inventory: {}, worn: held },
    steps: []
  }
  const c2 = score(worn, task)
  assert.strictEqual(c2.success, true, 'all four worn -> success')
  assert.strictEqual(c2.outcome, 'success')
})

// 11. Ambiguous tasks (success.review) are HUMAN-judged: never auto pass/fail, and a build artifact
//     is reconstructed from the placements so a reviewer can see what was built.
ok('review tasks never auto pass/fail and emit a build artifact', () => {
  const task = loadTask('tiny_house')
  const t = {
    model: 'm', ended_reason: 'agent_stop', duration_s: 1,
    final_state: { inventory: { dirt: 3 } },
    steps: [
      { action: { tool: 'place_block', args: { block_type: 'dirt', dx: 1, dy: 0, dz: 0 } }, ok: true, result: 'Placed dirt.', observation: { inventory: { dirt: 12 } }, pos: [10, 64, 10] },
      { action: { tool: 'place_block', args: { block_type: 'minecraft:dirt', dx: 1, dy: 1, dz: 0 } }, ok: true, result: 'Placed dirt.', observation: { inventory: { dirt: 11 } }, pos: [10, 64, 10] }
    ]
  }
  const c = score(t, task)
  assert.strictEqual(c.success, false, 'review tasks never auto-succeed')
  assert.strictEqual(c.outcome, 'review')
  assert.strictEqual(c.review_required, true)
  assert.ok(c.build && c.build.blocks_placed === 2, 'build artifact reconstructed from placements')
  assert.strictEqual(c.build.levels, 2, 'two stacked blocks span two levels')
})

// 12. Build reconstruction counts only SUCCESSFUL place_block steps (failed places / other tools out).
ok('build reconstruction ignores failed places and non-place tools', () => {
  const steps = [
    { action: { tool: 'place_block', args: { block_type: 'oak_planks', dx: 1, dy: 0, dz: 0 } }, ok: true, pos: [0, 64, 0] },
    { action: { tool: 'place_block', args: { block_type: 'oak_planks', dx: 2, dy: 0, dz: 0 } }, ok: false, pos: [0, 64, 0] },
    { action: { tool: 'mine_block', args: { block_type: 'oak_log' } }, ok: true, pos: [0, 64, 0] }
  ]
  const placed = reconstructPlacements(steps)
  assert.strictEqual(placed.length, 1, 'only the successful place_block counts')
  const b = summarizeBuild(placed)
  assert.strictEqual(b.blocks_placed, 1)
  assert.strictEqual(b.by_type.oak_planks, 1)
  assert.strictEqual(summarizeBuild([]), null, 'no placements -> no build artifact')
})

// 13. Every shipped task file parses and declares a well-formed milestone DAG (covers new tasks too).
ok('every task file parses and has a well-formed milestone DAG', () => {
  const dir = path.join(__dirname, '..', 'tasks')
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  assert.ok(files.length >= 1, 'there are task files')
  for (const f of files) {
    let task
    assert.doesNotThrow(() => { task = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }, `${f} is valid JSON`)
    assert.deepStrictEqual(validateMilestones(task), [], `${f} milestones are well-formed`)
  }
})

console.log(`\n${passed} checks passed.`)
