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
    task_id: s.task_id, model: s.model, success: s.success, score: s.score, steps: s.steps
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

// Pick the better of two scorecards: success first, then higher score, then fewer steps.
// Returns the winning scorecard, or null on an exact tie.
function pickWinner(a, b) {
  if (!!a.success !== !!b.success) return a.success ? a : b
  if ((a.score ?? 0) !== (b.score ?? 0)) return (a.score ?? 0) > (b.score ?? 0) ? a : b
  if ((a.steps ?? Infinity) !== (b.steps ?? Infinity)) return (a.steps ?? Infinity) < (b.steps ?? Infinity) ? a : b
  return null
}

// Print a side-by-side comparison of two scorecards (model A vs model B) + the winner.
function printComparison(cards, log = console.log) {
  const [a, b] = cards
  const rows = ['success', 'score', 'steps', 'duration_s', 'tool_calls', 'tool_errors', 'repeated_actions', 'ended_reason']
  const col = (v) => String(v ?? '—')
  const wA = Math.max(a.model.length, ...rows.map(r => col(a[r]).length), 10)
  const wB = Math.max(b.model.length, ...rows.map(r => col(b[r]).length), 10)
  const label = Math.max(...rows.map(r => r.length), 6)
  const pad = (s, w) => String(s).padEnd(w)

  log('\n📊 ── Comparison ──')
  log(`   ${pad('metric', label)}   ${pad(a.model, wA)}   ${pad(b.model, wB)}`)
  log(`   ${'─'.repeat(label)}   ${'─'.repeat(wA)}   ${'─'.repeat(wB)}`)
  for (const r of rows) log(`   ${pad(r, label)}   ${pad(col(a[r]), wA)}   ${pad(col(b[r]), wB)}`)

  const winner = pickWinner(a, b)
  log('')
  if (!winner) log('   🤝 Tie — both models scored identically.')
  else log(`   🏆 Winner: ${winner.model}`)
  log('   Note: same-world race — bots shared one world and may have competed for blocks.')
}

module.exports = { saveResult, loadResults, comparisonTable, resultFilesForTask, pickWinner, printComparison, DEFAULT_DIR }
