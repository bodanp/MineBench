// ─────────────────────────────────────────────
// STORE — persist a run's scorecard + trace, and aggregate results for comparison.
//
// OWNER: Scoring & Results (Role 2)
//
// Public API:
//   saveResult(scorecard, trace, dir?) -> filepath
//   loadResults(dir?)                  -> [{ scorecard, trace }]
//   comparisonTable(results)           -> rows of { task_id, model, success, score, steps }
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

module.exports = { saveResult, loadResults, comparisonTable, DEFAULT_DIR }
