// ─────────────────────────────────────────────
// MILESTONES — a dependency GRAPH (DAG) of progress checkpoints, DEFINED PER TASK.
//
// OWNER: Scoring & Results (Role 2)
//
// WHERE MILESTONES COME FROM:
//   Milestones are authored explicitly in the task JSON under `"milestones"`. There is no recipe
//   auto-derivation — a task owns its own progress graph, right next to its goal and setup. A task
//   with no `milestones` array simply scores on the four milestone-free dimensions (tool_use,
//   adaptation, efficiency, robustness); `completion` and the planning ordering check are skipped.
//
// WHY A DAG, NOT A LINEAR CHAIN:
//   A complex task usually has MANY valid solution paths, and the order of independent steps does
//   not matter (you can mine stone before or after whittling sticks). A single linear chain bakes
//   in ONE assumed path, so a run that diverges — a different recipe variant, a tool delivered by a
//   world block instead of the inventory, steps done in another legal order — scores wrong in
//   several dimensions at once. So milestones form a DAG of `{ matcher, count, deps }` and we score
//   against the GRAPH:
//     * completion uses BACKWARD ENTAILMENT — reaching a node entails all of its prerequisites (you
//       cannot hold a stone pickaxe without having had sticks, cobblestone and table access), so
//       credit never depends on catching a transient intermediate in the inventory.
//     * planning checks a craft/smelt's ACTUAL direct prerequisites (its parents in the DAG), not
//       "every earlier step", so legal reorderings are not punished. (See scorer.js.)
//
// TASK JSON SCHEMA (authoring guide):
//   "milestones": [
//     { "id": "log",   "suffix": "_log",   "label": "Gather wood" },
//     { "id": "planks", "suffix": "_planks","label": "Craft planks", "deps": ["log"] },
//     { "id": "table",  "item": "crafting_table", "label": "Crafting-table access",
//                       "tool": true, "deps": ["planks"] },
//     { "id": "stone_pickaxe", "item": "stone_pickaxe", "label": "Craft stone pickaxe",
//                       "deps": ["stick", "cobblestone", "table"] }
//   ]
//   Each node has ONE matcher — { item } | { any:[...] } | { suffix } — plus optional:
//     count (default 1) · label · id (defaults to the matcher key; give an explicit id when two
//     nodes share a matcher, e.g. a 1/2/3 count ramp) · deps (ids of direct prerequisites) ·
//     tool:true (a recipe REQUIREMENT like a crafting_table/furnace satisfied by a world block —
//     counted for completion via entailment, but excluded from the premature-prerequisite check
//     since its presence is proven by the dependent action succeeding, not by an inventory snapshot).
//   The goal is the node nothing depends on (the DAG's sink); it ends up last in topo order.
//
// Public API:
//   getMilestones(task) -> [{ ...matcher, count, label, id, deps, tool? }]  topo-ordered base-first
//   validateMilestones(task) -> [errorString]   (authoring guard; [] when the DAG is well-formed)
//   reachedCount(maxHeld, milestone) -> number
//   matchesItem(name, milestone) -> boolean
// ─────────────────────────────────────────────

const prettify = (name) => name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

// Stable identity for a matcher so DAG edges can reference nodes by id.
const matcherKey = (m) => m.suffix || (m.any && m.any.join('|')) || m.item

function labelFor(m) {
  if (m.item) return prettify(m.item)
  if (m.suffix) return prettify(m.suffix.replace(/^_/, ''))
  if (m.any) return prettify(m.any[0])
  return 'item'
}

// Attach a stable id + default count/label/deps to every node, drop dangling edges, then
// topologically order base-first (a node always appears after its dependencies; the goal — which
// nothing depends on — comes last). Cycle-guarded so a malformed task can never blow the stack.
function finalize(list) {
  const nodes = (list || []).map((m, k) => {
    const id = m.id || matcherKey(m)
    return { count: 1, deps: [], ...m, id, label: m.label || labelFor(m) || `step ${k + 1}` }
  })
  const byId = new Map(nodes.map(n => [n.id, n]))
  nodes.forEach(n => { n.deps = (n.deps || []).filter(d => byId.has(d)) })

  const depth = new Map()
  const compute = (id, stack) => {
    if (depth.has(id)) return depth.get(id)
    if (stack.has(id)) return 0           // cycle guard
    stack.add(id)
    const real = byId.get(id).deps
    const dd = real.length ? 1 + Math.max(...real.map(d => compute(d, stack))) : 0
    stack.delete(id)
    depth.set(id, dd)
    return dd
  }
  nodes.forEach(n => compute(n.id, new Set()))
  return nodes.sort((a, b) => depth.get(a.id) - depth.get(b.id))
}

// getMilestones(task) -> the task's explicit milestone DAG, topo-ordered. Empty when the task
// declares none (the run is then scored on the four milestone-free dimensions only).
function getMilestones(task) {
  if (Array.isArray(task && task.milestones) && task.milestones.length) return finalize(task.milestones)
  return []
}

// Authoring guard: flag the mistakes that silently corrupt a DAG. Returns [] when well-formed.
function validateMilestones(task) {
  const list = task && task.milestones
  if (!Array.isArray(list) || !list.length) return []
  const errors = []
  const ids = new Set()
  for (const m of list) {
    const matchers = ['item', 'any', 'suffix'].filter(k => m[k] != null)
    if (matchers.length !== 1) errors.push(`node ${JSON.stringify(m.id || m)} must have exactly one matcher (item|any|suffix), found ${matchers.length}`)
    const id = m.id || matcherKey(m)
    if (ids.has(id)) errors.push(`duplicate milestone id "${id}" — give colliding nodes explicit ids`)
    ids.add(id)
  }
  for (const m of list) {
    for (const d of (m.deps || [])) {
      if (!ids.has(d)) errors.push(`node "${m.id || matcherKey(m)}" depends on unknown id "${d}"`)
    }
  }
  return errors
}

function matchesItem(name, m) {
  if (!name) return false
  if (m.item) return name === m.item
  if (m.any) return m.any.includes(name)
  if (m.suffix) return name.endsWith(m.suffix)
  return false
}

function reachedCount(held, m) {
  let n = 0
  for (const [name, count] of Object.entries(held || {})) {
    if (matchesItem(name, m)) n += count || 0
  }
  return n
}

module.exports = { getMilestones, validateMilestones, reachedCount, matchesItem }
