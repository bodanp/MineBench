// ─────────────────────────────────────────────
// SCORER — turns a Task's success spec + a run Trace into a Scorecard.
//
// OWNER: Scoring & Results (Role 2)
//
// PHILOSOPHY (read this before changing the numbers):
//   MineBench is a proxy for GENERAL agentic capability — Minecraft is just the measuring
//   instrument. So we do NOT collapse a run into one "model A beats model B" scalar. We emit a
//   capability PROFILE across six transferable dimensions, each a deterministic function of the
//   trace (no LLM judge — that would be non-deterministic and biased; no elapsed time — that is
//   dominated by LLM latency, not behaviour):
//
//     completion   how far down the task's dependency chain it got (milestone progress)
//     planning     did it pursue prerequisites before dependents (no premature attempts)
//     tool_use     valid actions respecting preconditions (1 - self-inflicted errors)
//     adaptation   after a SELF-caused failure, does the next action differ (not looping)
//     robustness   recovery after an EXTERNAL disturbance (e.g. another bot takes a resource)
//     efficiency   productive-action ratio (NOT duration, NOT raw step count)
//
//   A dimension is `null` when the run never exercised it (e.g. no disturbance happened) so it
//   is excluded from averages rather than scored as 0 — that keeps the benchmark unbiased.
//
//   Errors are DIAGNOSTICS, not blunt penalties. A failed tool call does not mean the model is
//   dumb: it may be exploration, or the environment changing under it (another bot stole the
//   log it was about to craft with). We classify each failure agent-fault vs environmental and
//   only ever penalise *looping* (repeating an action that changed nothing) — never isolated
//   failures, and never legitimate repeats (mining log after log is correct, not a "repeat").
//
// Public API:
//   checkSuccess(state, task) -> boolean      (state = { inventory: {item: count} })
//   score(trace, task)        -> scorecard
// ─────────────────────────────────────────────

const { getMilestones, reachedCount, matchesItem } = require('./milestones')

function checkSuccess(state, task) {
  const spec = task && task.success
  if (!spec || typeof spec !== 'object') return false
  const inv = (state && state.inventory) || {}
  if (spec.inventory) {
    for (const [item, min] of Object.entries(spec.inventory)) {
      if ((inv[item] || 0) < min) return false
    }
    return true
  }
  return false
}

const clamp01 = (n) => Math.max(0, Math.min(1, n))
const r3 = (n) => (n == null ? null : +Number(n).toFixed(3))
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null

// Pure no-op tools: they cannot change the world or move the bot, so the pathfinder never runs
// (no scaffolding placement) and no crafting/placement is in flight. An item count that drops
// while TWO of these run back-to-back has no in-agent explanation left — it is an EXTERNAL
// disturbance (e.g. another bot in a same-world race picked up a resource you were carrying).
// Requiring two consecutive no-ops also defeats the one-tick inventory lag after a craft/place/
// move (which otherwise shows up misattributed to the next action). This is deliberately strict:
// in a normal single-bot run it yields zero disturbances, which is the correct answer.
const NOOP_TOOLS = new Set(['read_data', 'look_around', 'turn', 'jump', 'chat', 'stop'])
const INFO_TOOLS = new Set(['read_data', 'look_around'])
// A craft/smelt failure normally means the agent miscounted its ingredients (its own fault).
// But if a real disturbance just took the ingredient, the same message is NOT the agent's fault.
const INGREDIENT_FAIL_RE = /missing ingredient|not enough ingredient/i

// Environmental / not-the-agent's-fault failure signatures (physical world state, pathfinding,
// timeouts). Everything else that failed is treated as a self-inflicted (agent) error.
const ENV_ERROR_RE = /(no open spot|no path|couldn'?t reach|could not reach|too long|timed out|timeout|stuck|goalchanged|unreachable|no .*nearby|none nearby|not found nearby)/i

function key(action) {
  return action ? JSON.stringify({ t: action.tool, a: action.args || {} }) : null
}

// Running max-ever-held, fed snapshot by snapshot. Items consumed by crafting still count toward
// the milestone that produced them, which is what makes partial credit fair.
function mergeMax(into, snap) {
  for (const [name, count] of Object.entries(snap || {})) {
    if ((count || 0) > (into[name] || 0)) into[name] = count
  }
  return into
}

// The milestone NODE an action is trying to ACHIEVE (craft/smelt of a chain item), or null.
function targetMilestoneNode(action, milestones) {
  if (!action) return null
  let item = null
  if (action.tool === 'craft') item = action.args && action.args.item
  else if (action.tool === 'smelt') item = (action.args && (action.args.output || action.args.result)) || 'iron_ingot'
  if (!item) return null
  return milestones.find(m => matchesItem(item, m)) || null
}

// BACKWARD ENTAILMENT: reaching a node entails all of its prerequisites (you cannot hold a stone
// pickaxe without having had sticks, cobblestone and table access). Seed `achieved` from possession
// (max-ever-held >= count), then propagate each achieved node's credit up to its transitive deps.
// This is what makes credit independent of which valid path the run took, and what lets a tool node
// (crafting_table / furnace) score even though the agent satisfied it with a world block.
function achievedSet(milestones, held) {
  const byId = new Map(milestones.map(m => [m.id, m]))
  const achieved = new Set(milestones.filter(m => reachedCount(held, m) >= m.count).map(m => m.id))
  let changed = true
  while (changed) {
    changed = false
    for (const id of [...achieved]) {
      for (const dep of (byId.get(id).deps || [])) {
        if (byId.has(dep) && !achieved.has(dep)) { achieved.add(dep); changed = true }
      }
    }
  }
  return achieved
}

function score(trace, task) {
  const steps = (trace && trace.steps) || []
  const milestones = getMilestones(task)

  // ---- inventory timeline -------------------------------------------------------------------
  // snapshots[p] = inventory BEFORE step p's action (step.observation.inventory).
  // snapshots[last] = final inventory. after-state of step p = snapshots[p+1].
  const snapshots = steps.map(s => (s.observation && s.observation.inventory) || {})
  snapshots.push((trace && trace.final_state && trace.final_state.inventory) || {})
  const maxHeld = {}
  for (const snap of snapshots) mergeMax(maxHeld, snap)

  // ---- milestone progress (completion) — graph achievement with backward entailment ---------
  const milestoneById = new Map(milestones.map(m => [m.id, m]))
  const achievedFinal = achievedSet(milestones, maxHeld)
  const mList = milestones.map(m => ({ label: m.label, reached: achievedFinal.has(m.id) }))
  const reached = mList.filter(m => m.reached).length
  const total = milestones.length || 1
  const completion = milestones.length ? reached / total : null
  // Goal = the node nothing depends on (last in topo order); achieved only by really holding it.
  const goalNode = milestones.length ? milestones[milestones.length - 1] : null
  const goalReached = goalNode ? reachedCount(maxHeld, goalNode) >= goalNode.count : false

  const success = trace.ended_reason === 'success' ||
    checkSuccess(trace.final_state || { inventory: {} }, task) || goalReached

  // ---- walk the action steps once, gathering every signal -----------------------------------
  const actSteps = steps.filter(s => s.action)
  const totalActions = actSteps.length

  let agentErrors = 0, envErrors = 0
  let disturbances = 0, disturbancesRecovered = 0
  let planAttempts = 0, prematureAttempts = 0
  let agentFailures = 0, recoveredFailures = 0
  let unproductiveLoops = 0, wasted = 0

  const seenActions = new Set()       // for loop / redundant-info detection
  const runMax = {}                   // running max-ever-held up to (and incl.) the current before-state
  let prevTool = null                 // tool of the previous action step (for strict disturbance gating)
  let lastDisturbanceN = -99          // index of the most recent real disturbance (for error re-class)

  // Map each action step to its position in the full `steps` array so we can read before/after.
  const stepIndex = []
  steps.forEach((s, p) => { if (s.action) stepIndex.push(p) })

  for (let n = 0; n < stepIndex.length; n++) {
    const p = stepIndex[n]
    const s = steps[p]
    const before = snapshots[p] || {}
    const after = snapshots[p + 1] || {}
    mergeMax(runMax, before)

    const tool = s.action.tool
    const k = key(s.action)
    const isRepeat = seenActions.has(k)
    const failed = s.ok === false

    // gain = did this action raise the count of ANY milestone item? (productive resource change)
    // For free-form goals with no milestone chain, fall back to "acquired any item at all" so a
    // legitimate repeated gather (log after log) is never mistaken for an idle loop.
    let gained = false
    if (milestones.length) {
      for (const m of milestones) {
        if (reachedCount(after, m) > reachedCount(before, m)) { gained = true; break }
      }
    } else {
      for (const [name, cnt] of Object.entries(after)) {
        if ((cnt || 0) > (before[name] || 0)) { gained = true; break }
      }
    }
    const firstInfo = INFO_TOOLS.has(tool) && !isRepeat

    // ----- disturbance: an external item loss during two consecutive no-op actions -----
    // (computed first so the error classifier below can see a fresh disturbance.)
    if (NOOP_TOOLS.has(tool) && (n === 0 || NOOP_TOOLS.has(prevTool))) {
      let lostHere = false
      for (const [name, cnt] of Object.entries(before)) {
        const now = after[name] || 0
        if (now < (cnt || 0)) {
          disturbances++
          lostHere = true
          // recovered if the lost item is later regained to its pre-loss level...
          const regained = snapshots.slice(p + 1).some(sn => (sn[name] || 0) >= cnt)
          // ...or the milestone that needs it is ultimately reached.
          const milestoneOk = milestones.some(m => matchesItem(name, m) && reachedCount(maxHeld, m) >= m.count)
          if (regained || milestoneOk) disturbancesRecovered++
        }
      }
      if (lostHere) lastDisturbanceN = n
    }

    // ----- error classification (diagnostic; only looping is ever penalised) -----
    // A real disturbance in the last few steps that stole an ingredient turns the resulting
    // "missing ingredient" craft failure from an agent fault into an environmental one.
    const stolenIngredient = INGREDIENT_FAIL_RE.test(String(s.result)) && (n - lastDisturbanceN) <= 3
    const isEnvFail = failed && (ENV_ERROR_RE.test(String(s.result)) || stolenIngredient)
    if (failed) {
      if (isEnvFail) envErrors++
      else { agentErrors++; agentFailures++ }
    }

    // ----- planning: attempting a chain milestone before its ACTUAL prerequisites are met -----
    // We check the node's direct DAG parents (not "every earlier step"), so legal reorderings are
    // not punished. Tool parents (crafting_table / furnace) are excluded — their availability is
    // proven by whether the dependent action succeeds, not by an inventory snapshot.
    const targetNode = targetMilestoneNode(s.action, milestones)
    if (targetNode) {
      planAttempts++
      const prereqsMet = (targetNode.deps || []).every(did => {
        const dep = milestoneById.get(did)
        return !dep || dep.tool || reachedCount(runMax, dep) >= dep.count
      })
      if (!prereqsMet) prematureAttempts++
    }

    // ----- adaptation: after a self-caused failure, does the NEXT action differ? -----
    if (failed && !isEnvFail) {
      const next = actSteps[n + 1]
      if (next && key(next.action) !== k && next.action.tool !== 'stop') recoveredFailures++
    }

    // ----- loops & waste (efficiency) -----
    const unproductive = isRepeat && !gained && !firstInfo   // a repeat that changed nothing
    if (unproductive) unproductiveLoops++
    // A step is "wasted" if it looped to no effect, or failed by the agent's own reasoning.
    if (unproductive || (failed && !isEnvFail)) wasted++

    seenActions.add(k)
    prevTool = tool
  }

  // ---- the six capability dimensions (null = not exercised -> excluded from averages) -------
  const planning = planAttempts > 0 ? clamp01(1 - prematureAttempts / planAttempts) : null
  const tool_use = totalActions > 0 ? clamp01(1 - agentErrors / totalActions) : null
  const adaptation = agentFailures > 0 ? clamp01(recoveredFailures / agentFailures) : null
  const robustness = disturbances > 0 ? clamp01(disturbancesRecovered / disturbances) : null
  const efficiency = totalActions > 0 ? clamp01(1 - wasted / totalActions) : null

  const capabilities = {
    completion: r3(completion),
    planning: r3(planning),
    tool_use: r3(tool_use),
    adaptation: r3(adaptation),
    robustness: r3(robustness),
    efficiency: r3(efficiency)
  }

  // ---- roll-up summary score (the profile is the headline; this is just a sortable digest) ---
  // Completion is half the weight; the available behaviour dimensions share the other half.
  const behaviour = [planning, tool_use, adaptation, robustness, efficiency].filter(v => v != null)
  const behaviourAvg = mean(behaviour)
  const comp = completion == null ? 0 : completion
  const scoreVal = behaviourAvg == null ? r3(clamp01(comp)) : r3(clamp01(0.5 * comp + 0.5 * behaviourAvg))

  return {
    task_id: task.id,
    model: trace.model,
    success,
    score: scoreVal,
    progress: r3(completion),
    milestones: { reached, total: milestones.length, list: mList },
    capabilities,
    diagnostics: {
      actions: totalActions,
      productive_actions: totalActions - wasted,
      unproductive_loops: unproductiveLoops,
      agent_errors: agentErrors,
      env_errors: envErrors,
      disturbance_events: disturbances,
      disturbances_recovered: disturbancesRecovered,
      premature_attempts: prematureAttempts
    },
    // ---- legacy / compatibility fields (dashboard + older tooling still read these) ----
    steps: totalActions,
    tool_calls: totalActions,
    tool_errors: agentErrors + envErrors,
    repeated_actions: unproductiveLoops,
    stuck_events: trace.stuck_events ?? 0,
    duration_s: trace.duration_s ?? null,   // INFORMATIONAL ONLY — never part of the score
    ended_reason: trace.ended_reason
  }
}

module.exports = { checkSuccess, score, ENV_ERROR_RE }
