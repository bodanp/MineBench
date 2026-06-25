#!/usr/bin/env node
// ─────────────────────────────────────────────
// DASHBOARD BUILD — bake results/*.json into a self-contained dashboard.
//
// OWNER: Dashboard & Demo (Role 6)
//
// Reads every run via the existing scoring/store.loadResults() contract, computes the
// aggregates the UI needs (overview, leaderboard, task×model matrix) plus a trimmed
// per-run list (with step traces for drill-down), and writes them to dashboard/data.js as
//   window.__DATA__ = { ... };
// index.html loads that file with a <script> tag (works under file:// — no server, no CORS).
//
// Usage:
//   npm run dashboard                # generate dashboard/data.js
//   node dashboard/build.js --open   # also open index.html (Windows: `start`)
// ─────────────────────────────────────────────
const fs = require('fs')
const path = require('path')
const { loadResults } = require('../scoring/store')
const { score } = require('../scoring/scorer')

const TASKS_DIR = path.join(__dirname, '..', 'tasks')
const TASK_CACHE = {}
// Re-derive the task spec a trace was run against so we can RE-SCORE from the raw trace. Scoring
// is a pure function of (trace, task), so re-scoring at build time means the dashboard always
// reflects the CURRENT scoring logic instead of whatever scorer version wrote the file. Ad-hoc
// goals have no task file -> score against an empty success spec (progress n/a, behaviour dims
// still computed).
function taskFor(taskId) {
  if (taskId in TASK_CACHE) return TASK_CACHE[taskId]
  let task = { id: taskId, success: {} }
  try {
    const f = path.join(TASKS_DIR, `${taskId}.json`)
    if (fs.existsSync(f)) task = JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch { /* fall back to empty spec */ }
  return (TASK_CACHE[taskId] = task)
}

const round = (n, d = 3) => {
  const f = Math.pow(10, d)
  return Math.round((Number(n) || 0) * f) / f
}

// Keep the per-step trace small: drop the bulky surroundings/nearby radar, keep what the
// drill-down view actually shows (thought, action, result, ok) plus a compact inventory.
function trimStep(s) {
  return {
    i: s.i,
    thought: s.thought || '',
    action: s.action || null,
    result: s.result != null ? String(s.result) : '',
    ok: !!s.ok,
    pos: s.pos || null,
    inv: (s.observation && s.observation.inventory) || null
  }
}

function toRun(entry) {
  const tr = entry.trace || {}
  const taskId = (entry.scorecard && entry.scorecard.task_id) || tr.task_id || 'unknown'
  // Re-score from the trace with the current scorer when the trace is present; only fall back to
  // the stored scorecard if there is no trace to score (keeps the dashboard self-consistent).
  const sc = (tr && Array.isArray(tr.steps))
    ? score({ ...tr, model: (entry.scorecard && entry.scorecard.model) || tr.model }, taskFor(taskId))
    : (entry.scorecard || {})
  const started = tr.started_at || null
  const safeModel = String(sc.model || tr.model || 'model')
  return {
    id: `${taskId}__${safeModel}__${started || 'na'}`,
    task_id: taskId,
    model: safeModel,
    success: !!sc.success,
    score: round(sc.score, 3),
    progress: sc.progress != null ? round(sc.progress, 3) : null,
    capabilities: sc.capabilities || null,
    milestones: sc.milestones || null,
    diagnostics: sc.diagnostics || null,
    steps: sc.steps != null ? sc.steps : (tr.steps || []).filter(s => s.action).length,
    duration_s: sc.duration_s != null ? sc.duration_s : (tr.duration_s ?? null),
    tool_calls: sc.tool_calls ?? null,
    tool_errors: sc.tool_errors ?? null,
    repeated_actions: sc.repeated_actions ?? null,
    stuck_events: sc.stuck_events ?? 0,
    ended_reason: sc.ended_reason || tr.ended_reason || null,
    started_at: started,
    final_inventory: (tr.final_state && tr.final_state.inventory) || {},
    trace: (tr.steps || []).map(trimStep)
  }
}

// The six capability dimensions tracked across the dashboard.
const CAP_KEYS = ['completion', 'planning', 'tool_use', 'adaptation', 'robustness', 'efficiency']

function uniq(arr) { return [...new Set(arr)] }

function buildLeaderboard(runs) {
  const byModel = {}
  for (const r of runs) {
    const m = (byModel[r.model] ||= { model: r.model, runs: 0, successes: 0, scoreSum: 0, progSum: 0, caps: {} })
    m.runs++
    if (r.success) m.successes++
    m.scoreSum += Number(r.score) || 0
    m.progSum += Number(r.progress) || 0
    // Average each capability over the runs that actually exercised it (skip nulls — unbiased).
    for (const k of CAP_KEYS) {
      const v = r.capabilities && r.capabilities[k]
      if (v != null) { const c = (m.caps[k] ||= { sum: 0, n: 0 }); c.sum += v; c.n++ }
    }
  }
  return Object.values(byModel).map(m => {
    const capabilities = {}
    for (const k of CAP_KEYS) capabilities[k] = m.caps[k] ? round(m.caps[k].sum / m.caps[k].n, 3) : null
    return {
      model: m.model,
      runs: m.runs,
      successes: m.successes,
      success_rate: round(m.successes / m.runs, 3),
      avg_score: round(m.scoreSum / m.runs, 3),
      avg_progress: round(m.progSum / m.runs, 3),
      capabilities
    }
  }).sort((a, b) => b.avg_score - a.avg_score || b.success_rate - a.success_rate)
}

function buildMatrix(runs) {
  const tasks = uniq(runs.map(r => r.task_id)).sort()
  const models = uniq(runs.map(r => r.model)).sort()
  const cells = {}
  for (const r of runs) {
    const key = `${r.task_id}|${r.model}`
    const cell = (cells[key] ||= { runs: 0, success: false, score: 0, runId: null, started_at: null })
    cell.runs++
    // Prefer the latest run (by started_at) as the cell's representative.
    if (!cell.started_at || (r.started_at && r.started_at > cell.started_at)) {
      cell.started_at = r.started_at
      cell.success = r.success
      cell.score = r.score
      cell.runId = r.id
    }
  }
  return { tasks, models, cells }
}

function build() {
  const raw = loadResults()
  const runs = raw.map(toRun)
    .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')))

  const successes = runs.filter(r => r.success).length
  const data = {
    generated_at: new Date().toISOString(),
    capability_labels: {
      completion: 'Goal completion', planning: 'Long-horizon planning',
      tool_use: 'Tool-use proficiency', adaptation: 'Error recovery',
      robustness: 'Robustness to disturbance', efficiency: 'Efficiency'
    },
    overview: {
      runs: runs.length,
      models: uniq(runs.map(r => r.model)).length,
      tasks: uniq(runs.map(r => r.task_id)).length,
      success_rate: runs.length ? round(successes / runs.length, 3) : 0
    },
    leaderboard: buildLeaderboard(runs),
    matrix: buildMatrix(runs),
    runs
  }

  const outFile = path.join(__dirname, 'data.js')
  const body = `// AUTO-GENERATED by dashboard/build.js — do not edit. Regenerate: npm run dashboard:build\n` +
    `window.__DATA__ = ${JSON.stringify(data, null, 2)};\n`
  fs.writeFileSync(outFile, body)
  return { outFile, count: runs.length }
}

function main() {
  const { outFile, count } = build()
  const htmlFile = path.join(__dirname, 'index.html')
  console.log(`\u2713 Wrote ${path.relative(process.cwd(), outFile)} (${count} run${count === 1 ? '' : 's'}).`)
  console.log(`  Static file: ${htmlFile}`)
  console.log(`  Tip: for the live, auto-updating dashboard run \`npm run dashboard\` instead.`)
  if (count === 0) {
    console.log('  (No results found yet — run e.g. `node bench.js --task gather_wood` first.)')
  }
  if (process.argv.includes('--open')) {
    try {
      const { spawn } = require('child_process')
      if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', htmlFile], { detached: true, stdio: 'ignore' }).unref()
      else if (process.platform === 'darwin') spawn('open', [htmlFile], { detached: true, stdio: 'ignore' }).unref()
      else spawn('xdg-open', [htmlFile], { detached: true, stdio: 'ignore' }).unref()
    } catch (e) { console.log('  (Could not auto-open:', e.message, ')') }
  }
}

if (require.main === module) main()
module.exports = { build, buildLeaderboard, buildMatrix, toRun }
