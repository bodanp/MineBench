// ─────────────────────────────────────────────
// LIVE FEED — subscribes to the live-server SSE stream and mirrors the active run.
// OWNER: Dashboard & Demo (Role 6). Vanilla JS, no framework.
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
  let historyStale = false;

  function statusText(run) {
    if (!run) return 'waiting for a run…';
    if (run.status === 'running') return 'running';
    if (run.status === 'ended') return 'finishing…';
    if (run.status === 'done') return run.scorecard && run.scorecard.success ? 'done · success' : 'done';
    return run.status || '';
  }

  function render(run) {
    section.classList.remove('hidden');

    const statusEl = $('#live-status');
    statusEl.textContent = statusText(run);
    statusEl.className = 'live-status' + (run ? ' s-' + run.status : '');
    section.classList.toggle('idle', !run || run.status !== 'running');

    if (!run) {
      $('#live-title').textContent = 'No active run. Start one: npm run bench -- --task gather_wood';
      $('#live-bar').style.width = '0%';
      $('#live-current').textContent = '';
      $('#live-steps').innerHTML = '';
      $('#live-stepcount').textContent = '';
      $('#live-inventory').innerHTML = '';
      $('#live-scorecard').innerHTML = '';
      return;
    }

    const steps = (run.steps || []).slice().sort((a, b) => a.i - b.i);
    const max = run.max_steps || 0;

    $('#live-title').textContent = `${run.task_id} · ${run.model}` + (run.goal ? `  —  ${run.goal}` : '');
    $('#live-bar').style.width = max ? `${Math.min(100, Math.round(steps.length / max * 100))}%` : '0%';
    $('#live-stepcount').textContent = steps.length + (max ? ` / ${max}` : '');

    // Current/last step highlight
    const last = steps[steps.length - 1];
    const cur = $('#live-current'); cur.innerHTML = '';
    if (last) {
      cur.appendChild(h('span', { class: 'cur-i', text: `#${last.i} ` }));
      if (last.thought) cur.appendChild(h('span', { class: 'cur-thought', text: last.thought + '  ' }));
      cur.appendChild(last.action
        ? h('span', null, h('span', { class: 'tool', text: last.action.tool }), h('span', { class: 'args', text: `(${fmtArgs(last.action.args)})` }))
        : h('span', { class: 'args', text: '— (stop)' }));
    }

    // Steps table
    const table = $('#live-steps'); table.innerHTML = '';
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

    // Inventory chips (latest known)
    const inv = run.latest_inventory || run.final_inventory || {};
    const invEl = $('#live-inventory'); invEl.innerHTML = '';
    const entries = Object.entries(inv);
    if (entries.length) for (const [name, count] of entries) invEl.appendChild(h('span', { class: 'inv-chip', text: `${name} ×${count}` }));
    else invEl.appendChild(h('span', { class: 'muted', text: '—' }));

    // Scorecard (when finished)
    const sc = $('#live-scorecard'); sc.innerHTML = '';
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
    if (historyStale) {
      sc.appendChild(h('button', { class: 'refresh-btn', onclick: () => location.reload() }, '🔄 New result saved — refresh history'));
    }

    // keep the newest step in view
    const wrap = table.parentElement;
    if (wrap && run.status === 'running') wrap.scrollTop = wrap.scrollHeight;
  }

  // ---- live state mirror -----------------------------------------------------
  let run = null;
  function apply(e) {
    switch (e.type) {
      case 'snapshot': run = e.run; break;
      case 'run_start':
        historyStale = false;
        run = { status: 'running', task_id: e.task_id, model: e.model, goal: e.goal, max_steps: e.max_steps, started_at: e.started_at, steps: [], latest_inventory: null };
        break;
      case 'step':
        if (!run) run = { status: 'running', steps: [] };
        if (!run.steps.some(s => s.i === e.i)) run.steps.push(e);
        if (e.inventory) run.latest_inventory = e.inventory;
        break;
      case 'run_end':
        if (run) { if (run.status === 'running') run.status = 'ended'; run.ended_reason = e.ended_reason; run.duration_s = e.duration_s; run.final_inventory = e.final_inventory; }
        break;
      case 'run_scored':
        if (run) { run.status = 'done'; run.scorecard = e.scorecard; }
        break;
      case 'history_updated':
        historyStale = true;
        break;
      default: return;
    }
    render(run);
  }

  function connect() {
    const es = new EventSource('/events');
    es.onmessage = (msg) => { try { apply(JSON.parse(msg.data)); } catch (_) {} };
    es.onerror = () => { /* EventSource auto-reconnects; show waiting if we have nothing */ if (!run) render(null); };
  }

  // Show the panel immediately (waiting state) so it's obvious the live view is active.
  render(run);
  connect();
})();
