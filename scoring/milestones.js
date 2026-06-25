// ─────────────────────────────────────────────
// MILESTONES — ordered progress checkpoints used for partial-credit / progress scoring.
//
// OWNER: Scoring & Results (Role 2)
//
// WHY MILESTONES EXIST (and why most dimensions DON'T need them):
//   Of the six capability dimensions, only `completion` (how far toward the goal) and the
//   ordering check inside `planning` use milestones. `tool_use`, `adaptation`, `efficiency` and
//   `robustness` are computed straight from the trace and work with NO milestones at all — so a
//   failed run is still scored on those four even when we have no chain. Milestones add the one
//   thing binary success throws away: a run that got 6/7 of the way scoring higher than one that
//   wandered.
//
// WHERE THE CHAIN COMES FROM (you do NOT hand-author milestones for new tasks):
//   1. task.progress    — an explicit override in the task JSON (only when you want it).
//   2. BUILT_IN[target] — a hand-tuned chain for the few long-horizon tasks whose PROCESS / TOOL-
//                         TIER steps (you need a furnace to smelt, a stone pickaxe to mine iron)
//                         are NOT visible in the crafting graph. These are optional richness.
//   3. auto-derive      — built automatically from Minecraft's own recipe data (`minecraft-data`)
//                         by walking the goal item's ingredient DAG. Zero manual work: a new task
//                         that just says `success: { <item>: n }` gets milestones for free.
//   4. count ramp       — for a pure-gather goal ("mine 3 logs"), the 1..N ramp.
//   If none apply (an item with no recipe and no override), milestones are empty and the run is
//   still scored on the four milestone-free dimensions.
//
// A milestone is matched against the MAX-EVER-HELD count of an item across the run, so items
// later consumed by crafting (logs -> planks, cobblestone -> pickaxe) still count. A matcher is:
//   { item: 'stick' } | { any: ['cobblestone','cobbled_deepslate'] } | { suffix: '_planks' }
// plus { count } (default 1) and { label }.
//
// Public API:
//   getMilestones(task) -> [{ ...matcher, count, label }]   ordered base-first, goal last
//   reachedCount(maxHeld, milestone) -> number
//   matchesItem(name, milestone) -> boolean
// ─────────────────────────────────────────────

// Hand-tuned chains kept ONLY for tasks whose process/tool-tier steps the crafting graph cannot
// express (smelting; mining gated by tool tier). New tasks do not need an entry here — they fall
// through to auto-derivation. Treat these as built-in `progress` overrides, not the default path.
const BUILT_IN = {
  stone_pickaxe: () => [
    { suffix: '_log', count: 1, label: 'Gather wood' },
    { suffix: '_planks', count: 1, label: 'Craft planks' },
    { item: 'stick', count: 1, label: 'Craft sticks' },
    { item: 'crafting_table', count: 1, label: 'Make crafting table' },
    { item: 'wooden_pickaxe', count: 1, label: 'Craft wooden pickaxe' },
    { any: ['cobblestone', 'cobbled_deepslate'], count: 3, label: 'Mine stone' },
    { item: 'stone_pickaxe', count: 1, label: 'Craft stone pickaxe' }
  ],
  iron_pickaxe: () => [
    { suffix: '_log', count: 1, label: 'Gather wood' },
    { suffix: '_planks', count: 1, label: 'Craft planks' },
    { item: 'stick', count: 1, label: 'Craft sticks' },
    { item: 'crafting_table', count: 1, label: 'Make crafting table' },
    { item: 'wooden_pickaxe', count: 1, label: 'Craft wooden pickaxe' },
    { any: ['cobblestone', 'cobbled_deepslate'], count: 3, label: 'Mine stone' },
    { item: 'stone_pickaxe', count: 1, label: 'Craft stone pickaxe' },
    { any: ['raw_iron', 'iron_ore'], count: 1, label: 'Mine iron ore' },
    { item: 'furnace', count: 1, label: 'Make furnace' },
    { item: 'iron_ingot', count: 1, label: 'Smelt iron' },
    { item: 'iron_pickaxe', count: 1, label: 'Craft iron pickaxe' }
  ]
}

const prettify = (name) => name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

// Collapse an item name into a FAMILY matcher so milestones aren't pinned to an arbitrary recipe
// variant (cherry vs oak planks, cobblestone vs cobbled_deepslate). Anything else matches exactly.
function normalizeMatcher(name) {
  if (/_log$/.test(name)) return { suffix: '_log', label: 'Gather wood' }
  if (/_planks$/.test(name)) return { suffix: '_planks', label: 'Craft planks' }
  if (name === 'cobblestone' || name === 'cobbled_deepslate') return { any: ['cobblestone', 'cobbled_deepslate'], label: 'Mine stone' }
  return { item: name, label: prettify(name) }
}
const matcherKey = (m) => m.suffix || (m.any && m.any.join('|')) || m.item

// ---- auto-derivation from the Minecraft recipe graph --------------------------------------
let _mcData = null
function mcData() {
  if (_mcData !== null) return _mcData || null
  for (const v of ['1.21.11', '1.21.4', '1.21.1', '1.21', '1.20.6', '1.20.4']) {
    try { const d = require('minecraft-data')(v); if (d && d.recipes && d.itemsByName) { _mcData = d; return d } } catch { /* try next */ }
  }
  _mcData = false
  return null
}

// The simplest recipe for an item -> { ingredientName: countNeeded }, or null if the item has no
// crafting recipe (a base resource that is mined or smelted — a natural leaf milestone).
function ingredientsOf(d, name) {
  const it = d.itemsByName[name]
  if (!it) return null
  const recs = d.recipes[it.id]
  if (!recs || !recs.length) return null
  let best = null, bestDistinct = Infinity
  for (const r of recs) {
    let ids = []
    if (r.ingredients) ids = r.ingredients.filter(x => x != null).map(x => (typeof x === 'object' ? x.id : x))
    else if (r.inShape) ids = r.inShape.flat().filter(x => x != null).map(x => (typeof x === 'object' ? x.id : x))
    if (!ids.length) continue
    const distinct = new Set(ids).size
    if (distinct < bestDistinct) { bestDistinct = distinct; best = ids }
  }
  if (!best) return null
  const counts = {}
  for (const id of best) { const n = (d.items[id] && d.items[id].name) || String(id); counts[n] = (counts[n] || 0) + 1 }
  return counts
}

// Walk the goal item's ingredient DAG into ordered milestones. Cycle-guarded (recipes like
// iron_ingot <-> iron_nugget loop) and depth-capped. Returns null if the goal has no recipe.
function deriveFromRecipes(goalName, goalCount) {
  const d = mcData()
  if (!d) return null
  if (!ingredientsOf(d, goalName)) return null   // goal isn't craftable -> nothing to derive

  const depth = new Map()   // item -> deepest distance from goal
  const need = new Map()    // item -> max count required as a direct ingredient
  const MAX_DEPTH = 12

  const visit = (name, dist, path) => {
    if (dist > MAX_DEPTH || path.has(name)) return
    depth.set(name, Math.max(depth.get(name) || 0, dist))
    const ings = ingredientsOf(d, name)
    if (!ings) return
    const nextPath = new Set(path); nextPath.add(name)
    for (const [ing, c] of Object.entries(ings)) {
      need.set(ing, Math.max(need.get(ing) || 0, c))
      visit(ing, dist + 1, nextPath)
    }
  }
  visit(goalName, 0, new Set())

  // Order base-first (deepest), goal (depth 0) last; normalize to family matchers and dedupe,
  // keeping the deepest position and largest required count for each family.
  const ordered = [...depth.entries()].sort((a, b) => b[1] - a[1])
  const out = []
  const seen = new Map()
  for (const [name, dist] of ordered) {
    const m = normalizeMatcher(name)
    const count = name === goalName ? Math.max(1, goalCount | 0) : (need.get(name) || 1)
    const key = matcherKey(m)
    if (seen.has(key)) { const e = seen.get(key); e.count = Math.max(e.count, count); continue }
    const entry = { ...m, count }
    seen.set(key, entry)
    out.push(entry)
  }
  return out.length ? out : null
}

// ---- gather-goal ramp + helpers -----------------------------------------------------------
function countChain(matcher, target) {
  const n = Math.max(1, target | 0)
  const out = []
  for (let k = 1; k <= n; k++) out.push({ ...matcher, count: k, label: `${labelFor(matcher)} ${k}/${n}` })
  return out
}

function labelFor(m) {
  if (m.item) return prettify(m.item)
  if (m.suffix) return prettify(m.suffix.replace(/^_/, ''))
  if (m.any) return prettify(m.any[0])
  return 'item'
}

function pickTarget(spec) {
  const items = Object.keys(spec)
  const known = items.find(i => BUILT_IN[i])
  if (known) return known
  return items.sort((a, b) => (spec[b] || 0) - (spec[a] || 0))[0] || null
}

function normalize(list) {
  return (list || []).map((m, k) => ({ count: 1, label: m.label || labelFor(m) || `step ${k + 1}`, ...m }))
}

// getMilestones(task) -> ordered milestone list. Precedence: explicit override -> built-in chain
// (process-heavy tasks) -> auto-derive from recipe data -> gather count-ramp -> none.
function getMilestones(task) {
  if (Array.isArray(task && task.progress) && task.progress.length) return normalize(task.progress)
  const spec = task && task.success && task.success.inventory
  if (!spec || typeof spec !== 'object') return []
  const target = pickTarget(spec)
  if (!target) return []
  if (BUILT_IN[target]) return normalize(BUILT_IN[target]())
  const derived = deriveFromRecipes(target, spec[target])
  if (derived) return normalize(derived)
  return countChain({ item: target }, spec[target])   // base resource: just a count ramp
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

module.exports = { getMilestones, reachedCount, matchesItem, deriveFromRecipes, BUILT_IN }
