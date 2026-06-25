// ─────────────────────────────────────────────
// LIVE FEED — subscribes to the live-server SSE stream and mirrors the active session.
// OWNER: Dashboard & Demo (Role 6). Vanilla JS, no framework.
//
// A session may hold ONE run (solo) or TWO runs sharing one world (dual mode — slots A & B).
// Each run is rendered as its own panel side-by-side; when both finish, a winner banner is
// shown (success → higher score → fewer steps, mirroring scoring/store.pickWinner).
//
// Inert unless the page is served over http(s) by dashboard/live-server.js — on a plain
// file:// open there is no server, so the Live section stays hidden and only history shows.
// All model text is inserted via textContent (never innerHTML) to avoid markup injection.
// ─────────────────────────────────────────────
(function () {
  'use strict';

  // Only meaningful when served by the live server. file:// has no /events endpoint.
  if (!/^https?:$/.test(location.protocol)) return;
  if (typeof EventSource === 'undefined') return;

  // ---- tiny DOM helper (self-contained; live.js stays independent of app.js) ----
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }
  const $ = (s) => document.querySelector(s);
  const score3 = (n) => (Number(n) || 0).toFixed(3);
  const fmtArgs = (a) => (a && typeof a === 'object') ? Object.entries(a).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ') : '';

  const section = $('#live-section');

  // ---- live state mirror -----------------------------------------------------
  // A Map keyed by runId preserves insertion order (A before B) for rendering.
  let session = null;
  const runs = new Map();
  let historyStale = false;

  function runFor(e) {
    const id = e.runId || 'solo';
    let run = runs.get(id);
    if (!run) { run = { runId: id, slot: e.slot || null, status: 'running', steps: [], latest_inventory: null }; runs.set(id, run); }
    return run;
  }

  function apply(e) {
    switch (e.type) {
      case 'snapshot':
        session = e.session || null;
        runs.clear();
        for (const r of (e.runs || [])) runs.set(r.runId || 'solo', r);
        break;
      case 'run_start':
        if ((e.session || null) !== session) { runs.clear(); session = e.session || null; historyStale = false; }
        runs.set(e.runId || 'solo', {
          runId: e.runId || 'solo', slot: e.slot || null, status: 'running',
          task_id: e.task_id, model: e.model, goal: e.goal, max_steps: e.max_steps,
          started_at: e.started_at, steps: [], latest_inventory: null
        });
        break;
      case 'step': {
        const run = runFor(e);
        if (!run.steps.some(s => s.i === e.i)) run.steps.push(e);
        if (e.inventory) run.latest_inventory = e.inventory;
        break;
      }
      case 'run_end': {
        const run = runFor(e);
        if (run.status === 'running') run.status = 'ended';
        run.ended_reason = e.ended_reason; run.duration_s = e.duration_s; run.final_inventory = e.final_inventory;
        break;
      }
      case 'run_scored': {
        const run = runFor(e);
        run.status = 'done'; run.scorecard = e.scorecard;
        break;
      }
      case 'history_updated':
        historyStale = true;
        break;
      default: return;
    }
    renderAll();
  }

  // ---- winner (mirror of scoring/store.pickWinner) ---------------------------
  function pickWinner(a, b) {
    const ca = a.scorecard, cb = b.scorecard;
    if (!ca || !cb) return undefined;
    if (!!ca.success !== !!cb.success) return ca.success ? a : b;
    if ((ca.score ?? 0) !== (cb.score ?? 0)) return (ca.score ?? 0) > (cb.score ?? 0) ? a : b;
    if ((ca.steps ?? Infinity) !== (cb.steps ?? Infinity)) return (ca.steps ?? Infinity) < (cb.steps ?? Infinity) ? a : b;
    return null;   // tie
  }

  // ---- per-run panel ---------------------------------------------------------
  function panelStatus(run) {
    if (run.status === 'running') return 'running';
    if (run.status === 'ended') return 'finishing…';
    if (run.status === 'done') return run.scorecard && run.scorecard.success ? 'done · success' : 'done';
    return run.status || '';
  }

  function renderPanel(run, isWinner) {
    const steps = (run.steps || []).slice().sort((a, b) => a.i - b.i);
    const max = run.max_steps || 0;

    // Header: optional slot badge + task · model (+ goal), and a per-run status.
    const titleBits = [];
    if (run.slot) titleBits.push(h('span', { class: 'slot-badge slot-' + run.slot, text: run.slot }));
    if (isWinner) titleBits.push(h('span', { class: 'winner-badge', text: '🏆 winner' }));
    titleBits.push(h('span', { class: 'panel-title-text', text: `${run.task_id || '—'} · ${run.model || 'model'}` + (run.goal ? `  —  ${run.goal}` : '') }));
    const header = h('div', { class: 'panel-head' },
      h('div', { class: 'panel-title' }, ...titleBits),
      h('span', { class: 'panel-status s-' + (run.status || '') }, panelStatus(run))
    );

    // Progress
    const bar = h('div', { class: 'live-progress' },
      h('div', { class: 'live-bar', style: 'width:' + (max ? `${Math.min(100, Math.round(steps.length / max * 100))}%` : '0%') }));
    const stepcount = h('span', { class: 'muted', text: steps.length + (max ? ` / ${max}` : '') });

    // Current/last step highlight
    const last = steps[steps.length - 1];
    const cur = h('div', { class: 'live-current' });
    if (last) {
      cur.appendChild(h('span', { class: 'cur-i', text: `#${last.i} ` }));
      if (last.thought) cur.appendChild(h('span', { class: 'cur-thought', text: last.thought + '  ' }));
      cur.appendChild(last.action
        ? h('span', null, h('span', { class: 'tool', text: last.action.tool }), h('span', { class: 'args', text: `(${fmtArgs(last.action.args)})` }))
        : h('span', { class: 'args', text: '— (stop)' }));
    }

    // Steps table
    const table = h('table', { class: 'steps' });
    table.appendChild(h('thead', null, h('tr', null,
      h('th', { class: 'i', text: '#' }), h('th', { text: 'Thought' }), h('th', { text: 'Action' }), h('th', { text: 'Result' }), h('th', { class: 'num', text: 'OK' })
    )));
    const tbody = h('tbody');
    for (const s of steps) {
      const action = s.action
        ? h('span', null, h('span', { class: 'tool', text: s.action.tool }), h('span', { class: 'args', text: `(${fmtArgs(s.action.args)})` }))
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
    const tableWrap = h('div', { class: 'table-wrap' }, table);

    // Inventory chips (latest known)
    const inv = run.latest_inventory || run.final_inventory || {};
    const invEl = h('div', { class: 'inv-chips' });
    const entries = Object.entries(inv);
    if (entries.length) for (const [name, count] of entries) invEl.appendChild(h('span', { class: 'inv-chip', text: `${name} ×${count}` }));
    else invEl.appendChild(h('span', { class: 'muted', text: '—' }));

    // Scorecard (when finished)
    const sc = h('div', { class: 'live-scorecard' });
    if (run.scorecard) {
      const c = run.scorecard;
      sc.appendChild(h('div', { class: 'sc-grid' },
        h('div', { class: 'item' }, h('div', { class: 'k', text: 'Result' }), h('div', { class: 'v ' + (c.success ? 'good' : 'bad'), text: c.success ? 'success' : 'fail' })),
        h('div', { class: 'item' }, h('div', { class: 'k', text: 'Score' }), h('div', { class: 'v', text: score3(c.score) })),
        h('div', { class: 'item' }, h('div', { class: 'k', text: 'Steps' }), h('div', { class: 'v', text: String(c.steps) })),
        h('div', { class: 'item' }, h('div', { class: 'k', text: 'Duration' }), h('div', { class: 'v', text: (c.duration_s != null ? c.duration_s + 's' : '—') })),
        h('div', { class: 'item' }, h('div', { class: 'k', text: 'Ended' }), h('div', { class: 'v', text: c.ended_reason || '—' }))
      ));
    } else if (run.ended_reason) {
      sc.appendChild(h('div', { class: 'muted', text: `Ended: ${run.ended_reason}` }));
    }

    const cols = h('div', { class: 'live-cols' },
      h('div', { class: 'live-steps-wrap' }, h('h3', null, 'Steps ', stepcount), tableWrap),
      h('div', { class: 'live-side' }, h('h3', null, 'Inventory'), invEl, sc)
    );

    const panel = h('div', { class: 'live-panel' + (isWinner ? ' winner' : '') }, header, bar, cur, cols);
    // keep the newest step in view while running
    if (run.status === 'running') requestAnimationFrame(() => { tableWrap.scrollTop = tableWrap.scrollHeight; });
    return panel;
  }

  // ---- whole live section ----------------------------------------------------
  function aggregateStatus(arr) {
    if (!arr.length) return { text: 'waiting for a run…', cls: '', running: false };
    if (arr.some(r => r.status === 'running')) return { text: 'running', cls: 's-running', running: true };
    if (arr.some(r => r.status === 'ended')) return { text: 'finishing…', cls: 's-ended', running: false };
    // all done
    const allSuccess = arr.every(r => r.scorecard && r.scorecard.success);
    return { text: arr.length > 1 ? 'done · comparison ready' : (allSuccess ? 'done · success' : 'done'), cls: 's-done', running: false };
  }

  function renderAll() {
    section.classList.remove('hidden');

    // Order: slotted runs A→B first (alpha), then any solo.
    const arr = Array.from(runs.values()).sort((a, b) => (a.slot || '~').localeCompare(b.slot || '~'));

    const status = aggregateStatus(arr);
    const statusEl = $('#live-status');
    statusEl.textContent = status.text;
    statusEl.className = 'live-status ' + status.cls;
    section.classList.toggle('idle', !status.running);

    const panelsEl = $('#live-panels');
    const compareEl = $('#live-compare');
    const footEl = $('#live-foot');
    panelsEl.innerHTML = '';
    compareEl.innerHTML = '';
    compareEl.classList.add('hidden');
    footEl.innerHTML = '';

    if (!arr.length) {
      panelsEl.className = 'live-panels one';
      panelsEl.appendChild(h('div', { class: 'live-waiting muted', text: 'No active run. Start one:  npm run bench -- --task gather_wood   (or a dual run with --model-a / --model-b)' }));
      return;
    }

    // Winner banner once a 2-up comparison has finished.
    let winner;
    if (arr.length >= 2 && arr.every(r => r.status === 'done')) {
      winner = pickWinner(arr[0], arr[1]);
      if (winner !== undefined) {
        compareEl.classList.remove('hidden');
        if (winner === null) {
          compareEl.appendChild(h('span', { class: 'compare-tie', text: '🤝 Tie — both models scored identically.' }));
        } else {
          compareEl.appendChild(h('span', { class: 'compare-win', text: `🏆 Winner: ${winner.model}` }));
          compareEl.appendChild(h('span', { class: 'compare-note', text: '  (same-world race — bots shared one world and may have competed for blocks)' }));
        }
      }
    }

    panelsEl.className = 'live-panels ' + (arr.length > 1 ? 'two' : 'one');
    for (const run of arr) panelsEl.appendChild(renderPanel(run, !!(winner && winner.runId === run.runId)));

    if (historyStale) {
      footEl.appendChild(h('button', { class: 'refresh-btn', onclick: () => location.reload() }, '🔄 New result saved — refresh history'));
    }
  }

  function connect() {
    const es = new EventSource('/events');
    es.onmessage = (msg) => { try { apply(JSON.parse(msg.data)); } catch (_) {} };
    es.onerror = () => { /* EventSource auto-reconnects; show waiting if we have nothing */ if (!runs.size) renderAll(); };
  }

  // Show the panel immediately (waiting state) so it's obvious the live view is active.
  renderAll();
  connect();
})();
