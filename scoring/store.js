// ─────────────────────────────────────────────
// STORE — persist a run's scorecard + trace, and aggregate results for comparison.
//
// OWNER: Scoring & Results (Role 2)
//
// Public API:
//   saveResult(scorecard, trace, dir?) -> filepath
//   loadResults(dir?)                  -> [{ scorecard, trace }]
//   comparisonTable(results)           -> rows of { task_id, model, success, score, steps }
//   resultFilesForTask(taskId, sinceMs, dir?) -> [filepath]   (newest first)
//   printComparison(cards, log?)       -> void   (side-by-side two-model table + winner)
// ─────────────────────────────────────────────
const fs = require('fs')
const path = require('path')

const DEFAULT_DIR = path.join(__dirname, '..', 'results')

function saveResult(scorecard, trace, dir = DEFAULT_DIR) {
  fs.mkdirSync(dir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const safeModel = String(scorecard.model || 'model').replace(/[^\w.-]/g, '_')
  const base = `${scorecard.task_id}__${safeModel}__${ts}.json`
  const file = path.join(dir, base)
  fs.writeFileSync(file, JSON.stringify({ scorecard, trace }, null, 2))
  return file
}

function loadResults(dir = DEFAULT_DIR) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }
      catch { return null }
    })
    .filter(Boolean)
}

function comparisonTable(results) {
  return results.map(({ scorecard: s }) => ({
    task_id: s.task_id, model: s.model, success: s.success, score: s.score,
    progress: s.progress, capabilities: s.capabilities, steps: s.steps
  }))
}

// Result files this task produced (optionally only those written at/after `sinceMs`), newest
// first. Used by the dual-bot orchestrator to wait for both child runs to finish writing.
function resultFilesForTask(taskId, sinceMs = 0, dir = DEFAULT_DIR) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && f.startsWith(`${taskId}__`))
    .map(f => path.join(dir, f))
    .filter(p => fs.statSync(p).mtimeMs >= sinceMs)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
}

// Pick the better of two scorecards: success first, then higher roll-up score, then further
// progress. Elapsed time is deliberately NOT a tiebreaker — it is dominated by LLM latency
// (a model that reasons longer is not "worse"), so it must never decide a winner.
function pickWinner(a, b) {
  if (!!a.success !== !!b.success) return a.success ? a : b
  if ((a.score ?? 0) !== (b.score ?? 0)) return (a.score ?? 0) > (b.score ?? 0) ? a : b
  if ((a.progress ?? 0) !== (b.progress ?? 0)) return (a.progress ?? 0) > (b.progress ?? 0) ? a : b
  return null
}

// The six capability dimensions, in display order, with human-friendly labels. These are
// general agentic skills (Minecraft is just the instrument), so the comparison reads as a claim
// about the AGENTS, not about Minecraft.
const CAP_LABELS = [
  ['completion', 'Goal completion'],
  ['planning', 'Long-horizon planning'],
  ['tool_use', 'Tool-use proficiency'],
  ['adaptation', 'Error recovery'],
  ['robustness', 'Robustness to disturbance'],
  ['efficiency', 'Efficiency']
]

// Print a per-dimension head-to-head of two scorecards. Instead of one "A beats B" verdict, it
// shows WHERE each model is stronger — a capability profile — plus a plain-English summary.
function printComparison(cards, log = console.log) {
  const [a, b] = cards
  const capA = a.capabilities || {}, capB = b.capabilities || {}
  const fmt = (v) => (v == null ? 'n/a' : Number(v).toFixed(2))
  const wA = Math.max(a.model.length, 12)
  const wB = Math.max(b.model.length, 12)
  const label = Math.max(...CAP_LABELS.map(([, l]) => l.length), 'Goal completion'.length)
  const pad = (s, w) => String(s).padEnd(w)

  log('\n📊 ── Capability profile (deterministic; higher = better) ──')
  log(`   ${pad('dimension', label)}   ${pad(a.model, wA)}   ${pad(b.model, wB)}   edge`)
  log(`   ${'─'.repeat(label)}   ${'─'.repeat(wA)}   ${'─'.repeat(wB)}   ────`)

  const aWins = [], bWins = []
  for (const [key, lbl] of CAP_LABELS) {
    const va = capA[key], vb = capB[key]
    let edge = '—'
    if (va != null && vb != null && Math.abs(va - vb) > 0.05) {
      if (va > vb) { edge = '◀ ' + a.model; aWins.push(lbl) }
      else { edge = '▶ ' + b.model; bWins.push(lbl) }
    }
    log(`   ${pad(lbl, label)}   ${pad(fmt(va), wA)}   ${pad(fmt(vb), wB)}   ${edge}`)
  }

  // Roll-up + outcome (a digest, not the headline).
  log('')
  log(`   ${pad('outcome', label)}   ${pad((a.success ? 'success' : 'fail') + ` (${fmt(a.progress)})`, wA)}   ${pad((b.success ? 'success' : 'fail') + ` (${fmt(b.progress)})`, wB)}`)
  log(`   ${pad('overall score', label)}   ${pad(fmt(a.score), wA)}   ${pad(fmt(b.score), wB)}`)

  // Plain-English profile summary ("A is stronger at …; B is stronger at …").
  log('')
  if (aWins.length) log(`   ${a.model} is stronger at: ${aWins.join(', ')}.`)
  if (bWins.length) log(`   ${b.model} is stronger at: ${bWins.join(', ')}.`)
  if (!aWins.length && !bWins.length) log('   The two models are evenly matched across all measured dimensions.')

  const winner = pickWinner(a, b)
  if (winner) log(`   On THIS task overall: ${winner.model} (success/progress).`)
  else log('   On THIS task overall: tie.')

  // Diagnostics + the explicitly non-scored elapsed time.
  log('')
  log('   Diagnostics (not scored): ' +
    `${a.model} steps=${a.steps} loops=${a.repeated_actions} agentErr=${(a.diagnostics || {}).agent_errors ?? '?'} envErr=${(a.diagnostics || {}).env_errors ?? '?'} time=${a.duration_s}s · ` +
    `${b.model} steps=${b.steps} loops=${b.repeated_actions} agentErr=${(b.diagnostics || {}).agent_errors ?? '?'} envErr=${(b.diagnostics || {}).env_errors ?? '?'} time=${b.duration_s}s`)
  log('   Note: elapsed time is informational only — never part of the score. Same-world race: bots may have competed for blocks.')
}

module.exports = { saveResult, loadResults, comparisonTable, resultFilesForTask, pickWinner, printComparison, DEFAULT_DIR }
