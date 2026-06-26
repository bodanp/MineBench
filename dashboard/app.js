// ─────────────────────────────────────────────
// DASHBOARD APP — renders window.__DATA__ (from data.js) into the page.
// OWNER: Dashboard & Demo (Role 6). Vanilla JS, no framework.
//
// All model-authored text (thoughts, results) is inserted via textContent, never innerHTML,
// so arbitrary trace content can never inject markup.
// ─────────────────────────────────────────────
(function () {
  'use strict';

  const DATA = window.__DATA__ || { overview: { runs: 0 }, leaderboard: [], matrix: { tasks: [], models: [], cells: {} }, runs: [] };
  const RUN_BY_ID = Object.fromEntries((DATA.runs || []).map(r => [r.id, r]));

  // ---- tiny DOM helper -------------------------------------------------------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;          // only used with our own static strings
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else el.setAttribute(k, v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }
  const $ = (sel) => document.querySelector(sel);
  const pct = (n) => `${Math.round((Number(n) || 0) * 100)}%`;
  const score3 = (n) => (Number(n) || 0).toFixed(3);
  const fmtDur = (s) => (s == null ? '—' : `${s}s`);
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString();
  };
  const fmtArgs = (args) => {
    if (!args || typeof args !== 'object') return '';
    const parts = Object.entries(args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
    return parts.join(', ');
  };

  // ---- header + empty state --------------------------------------------------
  function renderHeader() {
    const n = (DATA.runs || []).length;
    $('#header-meta').textContent =
      n ? `${n} run${n === 1 ? '' : 's'} · generated ${fmtDate(DATA.generated_at)}` : '';
  }

  function showEmpty() {
    $('#empty').classList.remove('hidden');
    for (const id of ['#overview', '#leaderboard-section', '#matrix-section', '#runs-section']) {
      const node = $(id); if (node) node.classList.add('hidden');
    }
  }

  // ---- overview cards --------------------------------------------------------
  function renderOverview() {
    const o = DATA.overview || {};
    const cards = [
      { label: 'Runs', value: o.runs ?? 0 },
      { label: 'Models', value: o.models ?? 0 },
      { label: 'Tasks', value: o.tasks ?? 0 },
      { label: 'Success rate', value: pct(o.success_rate), accent: true }
    ];
    const root = $('#overview');
    root.innerHTML = '';
    for (const c of cards) {
      root.appendChild(h('div', { class: 'card' + (c.accent ? ' accent' : '') },
        h('div', { class: 'value', text: String(c.value) }),
        h('div', { class: 'label', text: c.label })
      ));
    }
  }

  // ---- leaderboard -----------------------------------------------------------
  function renderLeaderboard() {
    const rows = DATA.leaderboard || [];
    const table = $('#leaderboard');
    table.innerHTML = '';
    table.appendChild(h('thead', null, h('tr', null,
      h('th', { text: 'Model' }),
      h('th', { class: 'num', text: 'Runs' }),
      h('th', { class: 'num', text: 'Success' }),
      h('th', { class: 'num', text: 'Avg score' }),
      h('th', { class: 'num', text: 'Avg progress' })
    )));
    const tbody = h('tbody');
    for (const r of rows) {
      tbody.appendChild(h('tr', null,
        h('td', { class: 'model-cell', text: r.model }),
        h('td', { class: 'num', text: String(r.runs) }),
        h('td', { class: 'num' },
          h('div', { text: `${pct(r.success_rate)} (${r.successes}/${r.runs})` }),
          h('div', { class: 'bar' }, h('span', { style: `width:${Math.round((r.success_rate || 0) * 100)}%` }))
        ),
        h('td', { class: 'num', text: score3(r.avg_score) }),
        h('td', { class: 'num', text: score3(r.avg_progress) })
      ));
    }
    table.appendChild(tbody);
  }

  // ---- capability profile (model × dimension) --------------------------------
  const CAP_KEYS = ['completion', 'planning', 'tool_use', 'adaptation', 'robustness', 'efficiency'];
  const capLabel = (k) => (DATA.capability_labels && DATA.capability_labels[k]) || k;
  const capVal = (v) => (v == null ? '—' : (Number(v) || 0).toFixed(2));

  function renderCapabilities() {
    const rows = DATA.leaderboard || [];
    const table = $('#capabilities');
    if (!table) return;
    table.innerHTML = '';
    table.appendChild(h('thead', null, h('tr', null,
      h('th', { text: 'Model' }),
      ...CAP_KEYS.map(k => h('th', { class: 'num', text: capLabel(k) }))
    )));
    // Best (max) value per column, to highlight where each model leads.
    const best = {};
    for (const k of CAP_KEYS) {
      const vals = rows.map(r => r.capabilities && r.capabilities[k]).filter(v => v != null);
      best[k] = vals.length ? Math.max(...vals) : null;
    }
    const tbody = h('tbody');
    for (const r of rows) {
      const tr = h('tr', null, h('td', { class: 'model-cell', text: r.model }));
      for (const k of CAP_KEYS) {
        const v = r.capabilities && r.capabilities[k];
        const isBest = v != null && best[k] != null && Math.abs(v - best[k]) < 1e-9;
        tr.appendChild(h('td', { class: 'num' + (isBest ? ' cap-best' : ''), text: capVal(v) }));
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  // ---- matrix ----------------------------------------------------------------
  function renderMatrix() {
    const m = DATA.matrix || { tasks: [], models: [], cells: {} };
    const table = $('#matrix');
    table.innerHTML = '';
    table.appendChild(h('thead', null, h('tr', null,
      h('th', { class: 'row-head', text: 'Task \\ Model' }),
      ...m.models.map(mod => h('th', { class: 'num', text: mod }))
    )));
    const tbody = h('tbody');
    for (const task of m.tasks) {
      const tr = h('tr', null, h('th', { class: 'row-head', text: task }));
      for (const mod of m.models) {
        const cell = m.cells[`${task}|${mod}`];
        if (!cell) {
          tr.appendChild(h('td', { class: 'empty-cell', text: '—' }));
          continue;
        }
        const td = h('td', { class: 'cell ' + (cell.success ? 'success' : 'fail'), onclick: () => openRun(cell.runId) },
          h('span', { class: 'cell-mark ' + (cell.success ? 'ok' : 'err'), text: cell.success ? '✓ ' : '✗ ' }),
          h('span', { class: 'cell-score', text: score3(cell.score) }),
          cell.runs > 1 ? h('span', { class: 'pill-count', text: `×${cell.runs}` }) : null
        );
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  // ---- runs list (sortable) --------------------------------------------------
  const RUN_COLS = [
    { key: 'task_id', label: 'Task' },
    { key: 'model', label: 'Model' },
    { key: 'success', label: 'Result', num: true },
    { key: 'score', label: 'Score', num: true },
    { key: 'progress', label: 'Progress', num: true },
    { key: 'steps', label: 'Steps', num: true },
    { key: 'tool_errors', label: 'Errors', num: true },
    { key: 'ended_reason', label: 'Ended' },
    { key: 'started_at', label: 'Started', num: true }
  ];
  let sortState = { key: 'started_at', dir: -1 };
  let historyApiReady = false;
  let historyDeleting = false;

  function setHistoryMsg(text) {
    const el = $('#history-msg');
    if (!el) return;
    el.textContent = text || '';
  }

  function syncHistoryActions() {
    const bar = $('#history-actions');
    const delAll = $('#delete-all-runs');
    if (!bar || !delAll) return;
    bar.classList.toggle('hidden', !historyApiReady);
    delAll.disabled = !historyApiReady || historyDeleting || !(DATA.runs || []).length;
  }

  async function detectHistoryApi() {
    try {
      const res = await fetch('/state', { cache: 'no-store' });
      historyApiReady = !!res.ok;
    } catch (_) {
      historyApiReady = false;
    }
    syncHistoryActions();
    renderRuns();
  }

  async function deleteHistoryRun(runId, label) {
    if (!historyApiReady || historyDeleting) return;
    if (!confirm(`Delete run ${label || runId}?`)) return;
    historyDeleting = true;
    syncHistoryActions();
    setHistoryMsg('Deleting run...');
    try {
      const res = await fetch('/runs/' + encodeURIComponent(runId), { method: 'DELETE' });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `Delete failed (${res.status}).`);
      setHistoryMsg('Run deleted. Reloading...');
      location.reload();
    } catch (e) {
      setHistoryMsg(e.message);
      historyDeleting = false;
      syncHistoryActions();
    }
  }

  async function deleteAllHistory() {
    if (!historyApiReady || historyDeleting) return;
    if (!confirm('Delete all previous runs?')) return;
    historyDeleting = true;
    syncHistoryActions();
    setHistoryMsg('Deleting all runs...');
    try {
      const res = await fetch('/runs', { method: 'DELETE' });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `Delete failed (${res.status}).`);
      setHistoryMsg('All runs deleted. Reloading...');
      location.reload();
    } catch (e) {
      setHistoryMsg(e.message);
      historyDeleting = false;
      syncHistoryActions();
    }
  }

  function sortedRuns() {
    const runs = (DATA.runs || []).slice();
    const { key, dir } = sortState;
    runs.sort((a, b) => {
      let av = a[key], bv = b[key];
      if (typeof av === 'boolean') { av = av ? 1 : 0; bv = bv ? 1 : 0; }
      if (av == null) av = -Infinity; if (bv == null) bv = -Infinity;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return runs;
  }

  function renderRuns() {
    const table = $('#runs');
    table.innerHTML = '';
    const cols = historyApiReady ? RUN_COLS.concat({ key: 'actions', label: 'Actions', sortable: false }) : RUN_COLS;
    const headRow = h('tr');
    for (const col of cols) {
      const sortable = col.sortable !== false;
      const isSorted = sortState.key === col.key;
      const arrow = isSorted ? h('span', { class: 'arrow', text: sortState.dir < 0 ? ' ▼' : ' ▲' }) : null;
      const attrs = {
        class: (sortable ? 'sortable' : '') + (col.num ? ' num' : '')
      };
      if (sortable) {
        attrs.onclick = () => {
          if (sortState.key === col.key) sortState.dir *= -1;
          else sortState = { key: col.key, dir: col.num ? -1 : 1 };
          renderRuns();
        };
      }
      headRow.appendChild(h('th', attrs, col.label, sortable ? arrow : null));
    }
    table.appendChild(h('thead', null, headRow));

    const tbody = h('tbody');
    for (const r of sortedRuns()) {
      const tr = h('tr', { class: 'clickable', onclick: () => openRun(r.id) },
        h('td', { text: r.task_id }),
        h('td', { class: 'model-cell', text: r.model }),
        h('td', { class: 'num' }, h('span', { class: 'badge ' + (r.success ? 'ok' : 'err'), text: r.success ? 'success' : 'fail' })),
        h('td', { class: 'num', text: score3(r.score) }),
        h('td', { class: 'num', text: r.progress == null ? '—' : score3(r.progress) }),
        h('td', { class: 'num', text: String(r.steps) }),
        h('td', { class: 'num', text: r.tool_errors == null ? '—' : String(r.tool_errors) }),
        h('td', { text: r.ended_reason || '—' }),
        h('td', { class: 'num', text: fmtDate(r.started_at) })
      );
      if (historyApiReady) {
        const actions = h('td', { class: 'run-delete-cell' },
          h('button', {
            class: 'btn-linklike',
            type: 'button',
            onclick: (e) => { e.stopPropagation(); deleteHistoryRun(r.id, `${r.task_id} · ${r.model}`); }
          }, 'Delete')
        );
        tr.appendChild(actions);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    syncHistoryActions();
  }

  // ---- drill-down modal ------------------------------------------------------
  function invChips(inv) {
    const entries = Object.entries(inv || {});
    if (!entries.length) return null;
    return h('div', { class: 'inv-chips' },
      ...entries.map(([name, count]) => h('span', { class: 'inv-chip', text: `${name} ×${count}` })));
  }

  function renderModalBody(run) {
    const body = $('#modal-body');
    body.innerHTML = '';

    body.appendChild(h('h3', { text: run.task_id }));
    body.appendChild(h('div', { class: 'sub', text: `${run.model} · started ${fmtDate(run.started_at)}` }));

    const summary = [
      ['Result', run.success ? 'success' : 'fail'],
      ['Score', score3(run.score)],
      ['Progress', run.progress == null ? '—' : score3(run.progress)],
      ['Steps', String(run.steps)],
      ['Agent errors', (run.diagnostics && run.diagnostics.agent_errors != null) ? String(run.diagnostics.agent_errors) : '—'],
      ['Env errors', (run.diagnostics && run.diagnostics.env_errors != null) ? String(run.diagnostics.env_errors) : '—'],
      ['Loops', run.repeated_actions == null ? '—' : String(run.repeated_actions)],
      ['Duration (info)', fmtDur(run.duration_s)],
      ['Ended', run.ended_reason || '—']
    ];
    body.appendChild(h('div', { class: 'summary-grid' },
      ...summary.map(([k, v]) => h('div', { class: 'item' },
        h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v })))
    ));

    // Capability profile for this run.
    if (run.capabilities) {
      body.appendChild(h('div', { class: 'k', text: 'Capability profile', style: 'color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.4px;margin-top:14px;' }));
      const wrap = h('div', { class: 'cap-bars' });
      for (const k of CAP_KEYS) {
        const v = run.capabilities[k];
        wrap.appendChild(h('div', { class: 'cap-row' },
          h('div', { class: 'cap-name', text: capLabel(k) }),
          h('div', { class: 'cap-track' }, h('span', { class: 'cap-fill', style: `width:${v == null ? 0 : Math.round(v * 100)}%` })),
          h('div', { class: 'cap-val', text: capVal(v) })
        ));
      }
      body.appendChild(wrap);
    }

    // Milestones reached (partial-credit breakdown).
    if (run.milestones && Array.isArray(run.milestones.list) && run.milestones.list.length) {
      body.appendChild(h('div', { class: 'k', text: `Milestones (${run.milestones.reached}/${run.milestones.total})`, style: 'color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.4px;margin-top:14px;' }));
      body.appendChild(h('div', { class: 'inv-chips' },
        ...run.milestones.list.map(m => h('span', { class: 'inv-chip ' + (m.reached ? 'ms-done' : 'ms-todo'), text: `${m.reached ? '✓' : '○'} ${m.label}` }))));
    }

    if (run.final_inventory && Object.keys(run.final_inventory).length) {
      body.appendChild(h('div', { class: 'k', text: 'Final inventory', style: 'color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.4px;' }));
      body.appendChild(invChips(run.final_inventory) || h('div'));
    }

    // step table
    const table = h('table', { class: 'steps' });
    table.appendChild(h('thead', null, h('tr', null,
      h('th', { class: 'i', text: '#' }),
      h('th', { text: 'Thought' }),
      h('th', { text: 'Action' }),
      h('th', { text: 'Result' }),
      h('th', { class: 'num', text: 'OK' })
    )));
    const tbody = h('tbody');
    for (const s of (run.trace || [])) {
      const action = s.action
        ? h('span', null, h('span', { class: 'tool', text: s.action.tool }),
            h('span', { class: 'args', text: `(${fmtArgs(s.action.args)})` }))
        : h('span', { class: 'args', text: '— (stop)' });
      tbody.appendChild(h('tr', { class: s.ok ? '' : 'err' },
        h('td', { class: 'i', text: String(s.i) }),
        h('td', { class: 'thought', text: s.thought || '' }),
        h('td', null, action),
        h('td', { class: 'result', text: s.result || '' }),
        h('td', { class: 'num' }, h('span', { class: 'badge ' + (s.ok ? 'ok' : 'err'), text: s.ok ? '✓' : '✗' }))
      ));
    }
    table.appendChild(tbody);
    body.appendChild(h('h3', { text: 'Steps', style: 'margin-top:20px;font-size:15px;' }));
    body.appendChild(h('div', { class: 'table-wrap' }, table));
  }

  function openRun(runId) {
    const run = RUN_BY_ID[runId];
    if (!run) return;
    renderModalBody(run);
    $('#modal').classList.remove('hidden');
  }
  function closeModal() { $('#modal').classList.add('hidden'); }

  function wireModal() {
    document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeModal));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  }

  // ---- init ------------------------------------------------------------------
  function init() {
    renderHeader();
    if (!DATA.runs || DATA.runs.length === 0) { showEmpty(); return; }
    renderOverview();
    renderLeaderboard();
    renderCapabilities();
    renderMatrix();
    renderRuns();
    wireModal();
    const delAll = $('#delete-all-runs');
    if (delAll) delAll.addEventListener('click', deleteAllHistory);
    detectHistoryApi();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
