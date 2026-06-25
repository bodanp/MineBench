// ─────────────────────────────────────────────
// SCORER — turns a Task's success spec + a run Trace into a Scorecard.
//
// OWNER: Scoring & Results (Role 2)
//
// Public API:
//   checkSuccess(state, task) -> boolean      (state = { inventory: {item: count} })
//   score(trace, task)        -> scorecard
//
// Success DSL (v1): task.success = { "inventory": { "<item>": <minCount>, ... },
//                                    "killed_player": "<username>" | ["<username>", ...] }
// Multiple keys are AND-ed. Extend here (placed/reach/etc.) as new task types appear — keep it
// declarative so the Tasks owner (Role 5) never has to write engine code.
// ─────────────────────────────────────────────

function checkSuccess(state, task) {
  const spec = task && task.success
  if (!spec || typeof spec !== 'object') return false
  // No criteria (e.g. an ad-hoc goal) can never auto-succeed — there is nothing to verify.
  if (Object.keys(spec).length === 0) return false

  if (spec.inventory) {
    const inv = (state && state.inventory) || {}
    for (const [item, min] of Object.entries(spec.inventory)) {
      if ((inv[item] || 0) < min) return false
    }
  }

  // killed_player: one or more usernames the bot must have killed. The harness records real
  // deaths (from the server's entityDead packet) into state.killed_players — we never trust
  // the model's own claim that it killed someone.
  if (spec.killed_player) {
    const need = Array.isArray(spec.killed_player) ? spec.killed_player : [spec.killed_player]
    const killed = (state && state.killed_players) || []
    if (!need.every(n => killed.includes(n))) return false
  }

  return true
}

const clamp01 = (n) => Math.max(0, Math.min(1, n))

function score(trace, task) {
  const steps = trace.steps.filter(s => s.action).length
  const toolCalls = steps
  const toolErrors = trace.steps.filter(s => s.action && s.ok === false).length

  let repeats = 0
  for (let i = 1; i < trace.steps.length; i++) {
    const a = trace.steps[i].action
    const b = trace.steps[i - 1].action
    if (a && b && JSON.stringify(a) === JSON.stringify(b)) repeats++
  }

  const success = trace.ended_reason === 'success' ||
    checkSuccess(trace.final_state || { inventory: {} }, task)

  const maxSteps = task.max_steps || 60
  // Efficiency-weighted score: success is primary; fewer steps/errors/repeats scores higher.
  const scoreVal = success
    ? +clamp01(1 - 0.3 * (steps / maxSteps) - 0.1 * Math.min(1, toolErrors / 10) - 0.1 * Math.min(1, repeats / 10)).toFixed(3)
    : 0

  return {
    task_id: task.id,
    model: trace.model,
    success,
    steps,
    duration_s: trace.duration_s ?? null,
    tool_calls: toolCalls,
    tool_errors: toolErrors,
    repeated_actions: repeats,
    stuck_events: trace.stuck_events ?? 0,
    ended_reason: trace.ended_reason,
    score: scoreVal
  }
}

module.exports = { checkSuccess, score }
