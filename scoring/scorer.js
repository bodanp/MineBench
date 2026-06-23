// ─────────────────────────────────────────────
// SCORER — turns a Task's success spec + a run Trace into a Scorecard.
//
// OWNER: Scoring & Results (Role 2)
//
// Public API:
//   checkSuccess(state, task) -> boolean      (state = { inventory: {item: count} })
//   score(trace, task)        -> scorecard
//
// Success DSL (v1): task.success = { "inventory": { "<item>": <minCount>, ... } }
// Extend here (placed/reach/etc.) as new task types appear — keep it declarative so the
// Tasks owner (Role 5) never has to write engine code.
// ─────────────────────────────────────────────

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

  // success is primary. Trust the harness's in-loop detection, or re-derive from final state —
  // EXCEPT when the run was aborted because setup didn't reset the world (setup_failed): a
  // leftover item must never be scored as a win.
  const success = trace.ended_reason === 'success' ||
    (trace.ended_reason !== 'setup_failed' && checkSuccess(trace.final_state || { inventory: {} }, task))

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
