// ─────────────────────────────────────────────
// LIVE FEED — subscribes to the live-server SSE stream and mirrors the active run(s).
// OWNER: Dashboard & Demo (Role 6). Vanilla JS, no framework.
//
// Supports single runs (one lane) and head-to-head (two lanes, A | B) side-by-side, plus an
// interactive "awaiting goal/instruction" standby state. Each step's thought is rendered as a
// chat-style bubble (not raw JSON) with its tool + params + result alongside.
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
      else if (k === 'text') el.textContent = v;          // textContent only — model output is untrusted
      else if (k === 'style') el.setAttribute('style', v);
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
  const toggle = (sel, show) => { const el = $(sel); if (el) el.classList.toggle('hidden', !show); };

  const section = $('#live-section');
  const lanesEl = $('#live-lanes');
  const compareEl = $('#live-compare');
  const verboseEl = $('#live-verbose');
  let historyStale = false;
  let prepMsg = '';   // latest server-prep log line (cold boot is slow — narrate it)

  // ---- live state mirror -----------------------------------------------------
  // Up to two lanes. `mode` decides one panel vs two; `interactive` toggles the goal box.
  let state = { mode: 'single', interactive: false, verbose: false, runs: { A: null, B: null } };
  const laneKeys = () => (state.mode === 'h2h' ? ['A', 'B'] : ['A']);
  const activeRuns = () => laneKeys().map(k => state.runs[k]).filter(Boolean);
  const anyStatus = (...s) => activeRuns().some(r => s.includes(r.status));

  function loadVerbosePref() {
    if (!verboseEl) return;
    let saved = null;
    try { saved = localStorage.getItem('minebench.live.verbose'); } catch (_) {}
    state.verbose = saved === '1';
  }

  function setVerbose(v) {
    state.verbose = !!v;
    try { localStorage.setItem('minebench.live.verbose', state.verbose ? '1' : '0'); } catch (_) {}
    if (verboseEl) verboseEl.checked = state.verbose;
    render();
  }

  function laneStatusText(run) {
    if (!run) return 'waiting…';
    switch (run.status) {
      case 'launching': return 'launching…';
      case 'awaiting': return 'awaiting goal/instruction…';
      case 'running': return 'running';
      case 'ended': return 'finishing…';
      case 'stopped': return 'stopped';
      case 'error': return 'error';
      case 'done': return run.scorecard && run.scorecard.review_required ? 'done · review' : (run.scorecard && run.scorecard.success ? 'done · success' : 'done');
      default: return run.status || '';
    }
  }

  function overallStatus() {
    const rs = activeRuns();
    if (!rs.length) return { text: 'waiting for a run…', cls: '' };
    if (rs.some(r => r.status === 'launching')) {
      const tail = prepMsg ? prepMsg.split('\n').filter(Boolean).pop() : '';
      return { text: tail ? ('starting server… ' + tail.slice(0, 70)) : 'launching…', cls: 's-launching' };
    }
    if (rs.some(r => r.status === 'awaiting')) return { text: 'awaiting goal/instruction…', cls: 's-awaiting' };
    if (rs.some(r => r.status === 'running')) return { text: 'running' + (state.mode === 'h2h' ? ' · head-to-head' : ''), cls: 's-running' };
    if (rs.every(r => r.status === 'done')) return { text: 'done', cls: 's-done' };
    if (rs.some(r => r.status === 'error')) return { text: 'error', cls: 's-error' };
    if (rs.some(r => r.status === 'stopped')) return { text: 'stopped', cls: '' };
    return { text: rs.map(r => r.status).join(' · '), cls: '' };
  }

  // ---- per-lane rendering ----------------------------------------------------
  function stepBubble(s) {
    const action = s.action
      ? h('span', null, h('span', { class: 'tool', text: s.action.tool }), h('span', { class: 'args', text: `(${fmtArgs(s.action.args)})` }))
      : h('span', { class: 'args', text: '— (stop)' });
    const row = h('div', { class: 'step-row' + (s.ok ? '' : ' err') },
      h('div', { class: 'bubble-line' },
        h('span', { class: 'step-i', text: `#${s.i}` }),
        h('div', { class: 'thought-bubble', text: s.thought || '(no thought)' })
      ));
    if (state.verbose) {
      row.appendChild(h('div', { class: 'step-action' },
        action,
        h('span', { class: 'badge ' + (s.ok ? 'ok' : 'err'), text: s.ok ? '✓' : '✗' }),
        (s.result ? h('div', { class: 'step-result', text: s.result }) : null)
      ));
    }
    return row;
  }

  function renderLane(run, laneKey) {
    const showTag = state.mode === 'h2h';
    const lane = h('div', { class: 'lane' + (run ? ' s-' + run.status : '') });

    // Head: optional A/B tag, title (task · model — goal), per-lane status.
    const title = run
      ? `${run.task_id || '—'} · ${run.model || 'model'}` + (run.goal ? `  —  ${run.goal}` : '')
      : 'No active run.';
    lane.appendChild(h('div', { class: 'lane-head' },
      showTag ? h('span', { class: 'lane-tag tag-' + laneKey, text: laneKey }) : null,
      h('span', { class: 'lane-title', text: title }),
      h('span', { class: 'lane-status' + (run ? ' s-' + run.status : ''), text: laneStatusText(run) })
    ));

    const steps = run && run.steps ? run.steps.slice().sort((a, b) => a.i - b.i) : [];
    const max = (run && run.max_steps) || 0;

    // Progress bar.
    lane.appendChild(h('div', { class: 'live-progress' },
      h('div', { class: 'live-bar', style: `width:${max ? Math.min(100, Math.round(steps.length / max * 100)) : 0}%` })));

    // Current line: prep status / awaiting prompt / last step.
    let current;
    if (run && run.status === 'launching') {
      const tail = prepMsg ? prepMsg.split('\n').filter(Boolean).pop() : '';
      current = h('span', { class: 'muted', text: tail ? ('starting server… ' + tail.slice(0, 90)) : 'connecting…' });
    } else if (run && run.status === 'awaiting') {
      current = h('span', { class: 'awaiting-note', text: '⏳ Awaiting goal/instruction — type a goal in-game or use the box above, then the bot starts.' });
    } else {
      const last = steps[steps.length - 1];
      current = last
        ? (state.verbose
          ? h('span', null,
              h('span', { class: 'cur-i', text: `#${last.i} ` }),
              last.thought ? h('span', { class: 'cur-thought', text: last.thought + '  ' }) : null,
              last.action
                ? h('span', null, h('span', { class: 'tool', text: last.action.tool }), h('span', { class: 'args', text: `(${fmtArgs(last.action.args)})` }))
                : h('span', { class: 'args', text: '— (stop)' }))
          : h('span', null,
              h('span', { class: 'cur-i', text: `#${last.i} ` }),
              h('span', { class: 'cur-thought', text: last.thought || '(no thought)' })))
        : h('span', { class: 'muted', text: '—' });
    }
    lane.appendChild(h('div', { class: 'lane-current' }, current));

    // Body: thought/action feed + side (inventory + scorecard).
    const feed = h('div', { class: 'feed' });
    for (const s of steps) feed.appendChild(stepBubble(s));
    if (!steps.length && run && (run.status === 'running' || run.status === 'awaiting')) {
      feed.appendChild(h('div', { class: 'muted feed-empty', text: run.status === 'awaiting' ? 'Standing by…' : 'Thinking…' }));
    }

    const inv = (run && (run.latest_inventory || run.final_inventory)) || {};
    const invEl = h('div', { class: 'inv-chips' });
    const entries = Object.entries(inv);
    if (entries.length) for (const [name, count] of entries) invEl.appendChild(h('span', { class: 'inv-chip', text: `${name} ×${count}` }));
    else invEl.appendChild(h('span', { class: 'muted', text: '—' }));

    const scEl = h('div', { class: 'lane-scorecard' });
    if (run && run.scorecard) {
      const c = run.scorecard;
      scEl.appendChild(h('div', { class: 'sc-grid' },
        h('div', { class: 'item' }, h('div', { class: 'k', text: 'Result' }), h('div', { class: 'v ' + (c.review_required ? 'review' : (c.success ? 'good' : 'bad')), text: c.review_required ? 'review' : (c.success ? 'success' : 'fail') })),
        h('div', { class: 'item' }, h('div', { class: 'k', text: 'Score' }), h('div', { class: 'v', text: score3(c.score) })),
        h('div', { class: 'item' }, h('div', { class: 'k', text: 'Steps' }), h('div', { class: 'v', text: String(c.steps) })),
        h('div', { class: 'item' }, h('div', { class: 'k', text: 'Duration' }), h('div', { class: 'v', text: (c.duration_s != null ? c.duration_s + 's' : '—') })),
        h('div', { class: 'item' }, h('div', { class: 'k', text: 'Ended' }), h('div', { class: 'v', text: c.ended_reason || '—' }))
      ));
    } else if (run && run.ended_reason) {
      scEl.appendChild(h('div', { class: 'muted', text: `Ended: ${run.ended_reason}` }));
    }
    if (run && run.error) scEl.appendChild(h('div', { class: 'run-error', text: run.error }));

    const body = h('div', { class: 'lane-cols' },
      h('div', { class: 'lane-feed-wrap' },
        h('h3', null, 'Thoughts & actions ', h('span', { class: 'muted', text: steps.length + (max ? ` / ${max}` : '') })),
        feed),
      h('div', { class: 'lane-side' },
        h('h3', null, 'Inventory'), invEl, scEl)
    );
    lane.appendChild(body);

    // Auto-scroll the feed while live.
    if (run && (run.status === 'running' || run.status === 'awaiting')) {
      requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
    }
    return lane;
  }

  // ---- head-to-head comparison strip ----------------------------------------
  const COMPARE_ROWS = [
    { key: 'success', label: 'Result', fmt: (v) => (v ? 'success' : 'fail'), better: 'bool' },
    { key: 'score', label: 'Overall score', fmt: (v) => score3(v), better: 'high' },
    { key: 'progress', label: 'Progress', fmt: (v) => score3(v), better: 'high' },
    { key: 'steps', label: 'Steps', fmt: (v) => String(v ?? '—'), better: 'low' },
    { key: 'tool_calls', label: 'Tool calls', fmt: (v) => String(v ?? '—'), better: 'none' },
    { key: 'tool_errors', label: 'Tool errors', fmt: (v) => String(v ?? '—'), better: 'low' },
    { key: 'repeated_actions', label: 'Repeated actions', fmt: (v) => String(v ?? '—'), better: 'low' },
    { key: 'duration_s', label: 'Duration (informational)', fmt: (v) => (v != null ? v + 's' : '—'), better: 'none' },
    { key: 'ended_reason', label: 'Ended', fmt: (v) => v || '—', better: 'none' }
  ];

  function winnerSide(a, b) {
    if (!!a.success !== !!b.success) return a.success ? 'A' : 'B';
    if ((a.score ?? 0) !== (b.score ?? 0)) return (a.score ?? 0) > (b.score ?? 0) ? 'A' : 'B';
    if ((a.progress ?? 0) !== (b.progress ?? 0)) return (a.progress ?? 0) > (b.progress ?? 0) ? 'A' : 'B';
    return null;
  }

  function renderCompare() {
    compareEl.innerHTML = '';
    if (state.mode !== 'h2h') return;
    const a = state.runs.A, b = state.runs.B;
    if (!a || !b || a.status !== 'done' || b.status !== 'done' || !a.scorecard || !b.scorecard) return;
    const ca = a.scorecard, cb = b.scorecard;

    const better = (row) => {
      const va = ca[row.key], vb = cb[row.key];
      if (row.better === 'none' || va == null || vb == null) return null;
      if (row.better === 'bool') { if (!!va === !!vb) return null; return va ? 'A' : 'B'; }
      if (va === vb) return null;
      if (row.better === 'high') return va > vb ? 'A' : 'B';
      if (row.better === 'low') return va < vb ? 'A' : 'B';
      return null;
    };

    const tbody = h('tbody');
    for (const row of COMPARE_ROWS) {
      const win = better(row);
      tbody.appendChild(h('tr', null,
        h('td', { class: 'cmp-k', text: row.label }),
        h('td', { class: 'cmp-v' + (win === 'A' ? ' win' : ''), text: row.fmt(ca[row.key]) }),
        h('td', { class: 'cmp-v' + (win === 'B' ? ' win' : ''), text: row.fmt(cb[row.key]) })
      ));
    }

    const win = winnerSide(ca, cb);
    const winnerText = win
      ? `Winner: ${win} · ${(win === 'A' ? ca : cb).model} (success/progress).`
      : 'Result: tie across success and score.';

    compareEl.appendChild(h('div', { class: 'compare-card' },
      h('h3', null, 'Head-to-head comparison'),
      h('div', { class: 'table-wrap' },
        h('table', { class: 'compare' },
          h('thead', null, h('tr', null,
            h('th', { text: '' }),
            h('th', null, h('span', { class: 'lane-tag tag-A', text: 'A' }), ' ', h('span', { text: ca.model })),
            h('th', null, h('span', { class: 'lane-tag tag-B', text: 'B' }), ' ', h('span', { text: cb.model }))
          )),
          tbody)),
      h('div', { class: 'compare-winner', text: winnerText })
    ));
  }

  function render() {
    section.classList.remove('hidden');
    syncControls();
    section.classList.toggle('compact', !state.verbose);

    const st = overallStatus();
    const statusEl = $('#live-status');
    statusEl.textContent = st.text;
    statusEl.className = 'live-status ' + st.cls;
    section.classList.toggle('idle', !anyStatus('running', 'awaiting', 'launching'));

    lanesEl.className = 'live-lanes' + (state.mode === 'h2h' ? ' h2h' : '');
    lanesEl.innerHTML = '';
    for (const k of laneKeys()) lanesEl.appendChild(renderLane(state.runs[k], k));

    renderCompare();

    if (historyStale) {
      compareEl.appendChild(h('button', { class: 'refresh-btn', onclick: () => location.reload() }, '🔄 New result saved — refresh history'));
    }
  }

  // ---- event application -----------------------------------------------------
  function apply(e) {
    const lane = e.lane || 'A';
    switch (e.type) {
      case 'snapshot':
        state.mode = e.mode || 'single';
        state.interactive = !!e.interactive;
        state.runs = (e.runs && typeof e.runs === 'object') ? { A: e.runs.A || null, B: e.runs.B || null } : { A: null, B: null };
        break;
      case 'run_config':
        state.mode = e.mode || 'single';
        state.interactive = !!e.interactive;
        state.runs = { A: null, B: null };
        prepMsg = '';
        setMsg('', '');
        break;
      case 'run_launching':
        state.runs[lane] = { lane, status: 'launching', task_id: e.task_id, model: e.model, steps: [], latest_inventory: null };
        break;
      case 'prep_log':
        prepMsg = (prepMsg ? prepMsg + '\n' : '') + (e.message || '');
        break;
      case 'run_awaiting':
        state.runs[lane] = { lane, status: 'awaiting', task_id: e.task_id, title: e.title, model: e.model, goal: '', max_steps: e.max_steps, started_at: e.started_at, steps: [], latest_inventory: e.inventory || null };
        break;
      case 'run_start':
        historyStale = false;
        state.runs[lane] = { lane, status: 'running', task_id: e.task_id, title: e.title, model: e.model, goal: e.goal, max_steps: e.max_steps, started_at: e.started_at, steps: [], latest_inventory: (state.runs[lane] && state.runs[lane].latest_inventory) || null };
        break;
      case 'step': {
        let r = state.runs[lane];
        if (!r) { r = state.runs[lane] = { lane, status: 'running', steps: [] }; }
        if (!r.steps) r.steps = [];
        if (!r.steps.some(s => s.i === e.i)) r.steps.push(e);
        if (e.inventory) r.latest_inventory = e.inventory;
        break;
      }
      case 'run_end': {
        const r = state.runs[lane];
        if (r) { if (r.status === 'running' || r.status === 'awaiting') r.status = 'ended'; r.ended_reason = e.ended_reason; r.error = e.error || null; r.duration_s = e.duration_s; r.final_inventory = e.final_inventory; }
        if (e.error) setMsg(e.error, 'error');
        break;
      }
      case 'run_scored': {
        const r = state.runs[lane];
        if (r) { r.status = 'done'; r.scorecard = e.scorecard; }
        break;
      }
      case 'history_updated':
        historyStale = true;
        break;
      case 'launch_error': {
        const r = state.runs[lane];
        if (r) r.status = 'error';
        setMsg((e.message || 'Launch failed') + (e.detail ? '\n' + e.detail : ''), 'error');
        break;
      }
      case 'run_exit': {
        const r = state.runs[lane];
        if (r && r.status !== 'done') r.status = (e.reason === 'stopped') ? 'stopped' : (r.status === 'error' ? 'error' : 'ended');
        if (e.reason === 'stopped') setMsg('Run stopped.', 'info');
        break;
      }
      default: return;
    }
    render();
  }

  // ---- launch controls -------------------------------------------------------
  let defaultModelName = '';

  function setMsg(text, kind) {
    const el = $('#rc-msg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'rc-msg' + (kind ? ' ' + kind : '');
  }

  function updateControlVisibility() {
    const source = $('#rc-source') ? $('#rc-source').value : 'task';
    const mode = $('#rc-mode') ? $('#rc-mode').value : 'single';
    const interactive = source === 'interactive';
    toggle('#rc-task-field', !interactive);
    toggle('#rc-model-field', mode === 'single');
    toggle('#rc-model-a-field', mode === 'h2h');
    toggle('#rc-model-b-field', mode === 'h2h');
    toggle('#rc-world-field', mode === 'h2h');
    toggle('#rc-goal-row', interactive);
  }

  function syncControls() {
    const startBtn = $('#rc-start'), stopBtn = $('#rc-stop'), sendBtn = $('#rc-send'), goalInput = $('#rc-goal');
    if (!startBtn || !stopBtn) return;
    const busy = anyStatus('launching', 'awaiting', 'running', 'ended');
    const awaiting = anyStatus('awaiting');
    startBtn.disabled = busy;
    stopBtn.disabled = !busy;
    for (const id of ['rc-source', 'rc-task', 'rc-mode', 'rc-model', 'rc-model-a', 'rc-model-b', 'rc-world', 'rc-reset']) {
      const el = $('#' + id); if (el) el.disabled = busy;
    }
    if (sendBtn) sendBtn.disabled = !awaiting;
    if (goalInput) goalInput.disabled = !awaiting;
  }

  function readConfig() {
    const source = $('#rc-source').value;
    const mode = $('#rc-mode').value;
    const interactive = source === 'interactive';
    const body = { mode, reset: $('#rc-reset').checked, interactive };
    if (!interactive) body.task = $('#rc-task').value;
    if (mode === 'h2h') {
      body.modelA = $('#rc-model-a').value.trim();
      body.modelB = $('#rc-model-b').value.trim();
      body.world = $('#rc-world').value;
    } else {
      body.model = $('#rc-model').value.trim();
    }
    return body;
  }

  async function initControls() {
    const controls = $('#run-controls');
    const startBtn = $('#rc-start'), stopBtn = $('#rc-stop'), sendBtn = $('#rc-send'), taskSel = $('#rc-task');
    if (!startBtn || !controls) return;

    try {
      const res = await fetch('/tasks');
      const data = await res.json();
      taskSel.innerHTML = '';
      // Categorize tasks into <optgroup>s by difficulty for easier browsing. The /tasks endpoint
      // already sorts by difficulty; tasks without one fall into an "Other" group, shown last.
      const DIFF_LABELS = {
        1: 'Difficulty 1 — Beginner', 2: 'Difficulty 2 — Easy', 3: 'Difficulty 3 — Medium',
        4: 'Difficulty 4 — Hard', 5: 'Difficulty 5 — Expert', 6: 'Difficulty 6 — Master'
      };
      const groups = new Map();
      for (const t of (data.tasks || [])) {
        const key = (typeof t.difficulty === 'number') ? t.difficulty : 'other';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t);
      }
      const keys = [...groups.keys()].sort((a, b) => (a === 'other') - (b === 'other') || a - b);
      for (const key of keys) {
        const label = key === 'other' ? 'Other / uncategorized' : (DIFF_LABELS[key] || `Difficulty ${key}`);
        taskSel.appendChild(h('optgroup', { label },
          ...groups.get(key).map(t => h('option', {
            value: t.id,
            text: t.max_steps ? `${t.title} · ${t.max_steps} steps` : t.title
          }))
        ));
      }
      defaultModelName = data.default_model || '';
      // Model dropdowns are populated from dashboard/models.json (served as model_options),
      // each { label, value }. The default is preselected; if it isn't in the list, prepend it.
      const options = (data.model_options || []).slice();
      if (defaultModelName && !options.some(o => o.value === defaultModelName)) {
        options.unshift({ label: defaultModelName, value: defaultModelName });
      }
      for (const id of ['rc-model', 'rc-model-a', 'rc-model-b']) {
        const sel = $('#' + id);
        if (!sel) continue;
        sel.innerHTML = '';
        for (const opt of options) sel.appendChild(h('option', { value: opt.value, text: opt.label || opt.value }));
        sel.value = defaultModelName || (options[0] && options[0].value) || '';
      }
      controls.classList.remove('hidden');
    } catch (_) {
      return;   // No server/tasks endpoint — leave controls hidden (e.g. opened as a static file).
    }

    for (const id of ['rc-source', 'rc-mode']) { const el = $('#' + id); if (el) el.addEventListener('change', updateControlVisibility); }
    updateControlVisibility();

    startBtn.addEventListener('click', async () => {
      const body = readConfig();
      if (!body.interactive && !body.task) { setMsg('Pick a task first.', 'error'); return; }
      startBtn.disabled = true;
      setMsg('Launching…', 'info');
      try {
        const res = await fetch('/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) { setMsg(out.error || `Launch failed (${res.status}).`, 'error'); startBtn.disabled = false; }
        else setMsg(body.interactive ? 'Standby launching — bot(s) will idle until you send a goal.' : ('Started ' + (body.task || body.mode) + '.'), 'ok');
      } catch (e) {
        setMsg('Could not reach server: ' + e.message, 'error');
        startBtn.disabled = false;
      }
    });

    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      setMsg('Stopping…', 'info');
      try {
        const res = await fetch('/stop', { method: 'POST' });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) setMsg(out.error || 'Stop failed.', 'error');
      } catch (e) {
        setMsg('Could not reach server: ' + e.message, 'error');
      }
    });

    if (sendBtn) sendBtn.addEventListener('click', async () => {
      const goalInput = $('#rc-goal');
      const goal = goalInput ? goalInput.value.trim() : '';
      if (!goal) { setMsg('Type a goal first.', 'error'); return; }
      sendBtn.disabled = true;
      setMsg('Sending goal…', 'info');
      try {
        const res = await fetch('/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal }) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) { setMsg(out.error || 'Send failed.', 'error'); sendBtn.disabled = false; }
        else { setMsg('Goal sent — the bot(s) are on it.', 'ok'); if (goalInput) goalInput.value = ''; }
      } catch (e) {
        setMsg('Could not reach server: ' + e.message, 'error');
        sendBtn.disabled = false;
      }
    });
  }

  function connect() {
    const es = new EventSource('/events');
    es.onmessage = (msg) => { try { apply(JSON.parse(msg.data)); } catch (_) {} };
    es.onerror = () => { /* EventSource auto-reconnects; show waiting if we have nothing */ if (!activeRuns().length) render(); };
  }

  // Show the panel immediately (waiting state) so it's obvious the live view is active.
  loadVerbosePref();
  if (verboseEl) verboseEl.addEventListener('change', () => setVerbose(verboseEl.checked));
  render();
  initControls();
  connect();
})();
