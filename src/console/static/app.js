// Console client. Every agent-written string is set with textContent only:
// nothing here parses data as HTML or markdown.
'use strict';
(function () {
  let csrf = null;
  let selected = null;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  };
  const showError = (msg) => { $('error').textContent = msg || ''; };

  async function api(path, body) {
    const opts = body === undefined
      ? { credentials: 'same-origin' }
      : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) };
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.code) || ('HTTP ' + res.status));
    return data;
  }

  function act(path, body, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    showError('');
    api(path, body || {}).then(refresh).catch((e) => showError(e.message));
  }

  function renderGuards(g) {
    $('guards').textContent =
      'Agent messages last hour: ' + g.messages_last_hour + '/' + g.limits.global_per_hour +
      ' · live threads: ' + g.live_threads + '/' + g.limits.concurrent_threads +
      ' · spend today (est. USD): Claude ' + g.spend_today_usd.claude.toFixed(2) + '/' + g.daily_spend_usd.claude +
      ', Codex ' + g.spend_today_usd.codex.toFixed(2) + '/' + g.daily_spend_usd.codex;
  }

  function renderQuestions(qs) {
    const ul = $('questions');
    ul.replaceChildren();
    if (qs.length === 0) ul.append(el('li', 'muted', 'None.'));
    for (const q of qs) {
      const li = el('li');
      li.append(el('div', 'meta', q.asked_by + ' asks on ' + q.thread_id));
      li.append(el('div', 'body', q.question));
      const form = el('form');
      if (q.options.length) {
        const opts = el('div', 'options');
        for (const o of q.options) {
          const b = el('button', null, o);
          b.type = 'button';
          b.addEventListener('click', () => { form.elements.answer.value = o; });
          opts.append(b);
        }
        form.append(opts);
      }
      const ta = el('textarea');
      ta.name = 'answer';
      ta.rows = 2;
      ta.placeholder = 'Your answer is guidance, not an approval. The thread stays parked until you unpark it.';
      const send = el('button', null, 'Answer');
      send.type = 'submit';
      form.append(ta, send);
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        act('/api/questions/' + encodeURIComponent(q.id) + '/answer', { answer: ta.value });
      });
      li.append(form);
      ul.append(li);
    }
  }

  function renderGuardFlags(flags) {
    const ul = $('guard-flags');
    ul.replaceChildren();
    if (flags.length === 0) ul.append(el('li', 'muted', 'None.'));
    for (const f of flags) {
      const li = el('li');
      li.append(el('div', 'meta', f.created_at + ' ' + f.project + ' ' + f.ref + ' ' + f.commit.slice(0, 12)));
      li.append(el('div', 'body', f.hits.map((h) => h.rule + ': ' + h.path).join(', ')));
      const det = el('details');
      det.append(el('summary', null, 'Diff'), el('pre', 'diff', f.diff));
      li.append(det);
      ul.append(li);
    }
  }

  function renderThreads(threads) {
    const ul = $('threads');
    ul.replaceChildren();
    if (threads.length === 0) ul.append(el('li', 'muted', 'No threads yet.'));
    for (const t of threads) {
      const li = el('li', t.id === selected ? 'selected' : '');
      li.append(el('div', null, t.id));
      const state = el('div', 'state-' + t.state, t.state + (t.park_reason ? ' (' + t.park_reason + ')' : ''));
      li.append(state);
      li.append(el('div', 'meta', 'opened by ' + t.opened_by + ' · turns ' + t.turns + ' · hops ' + t.hops));
      li.addEventListener('click', () => { selected = t.id; refresh(); });
      ul.append(li);
    }
  }

  function renderThread(d) {
    $('empty').hidden = true;
    $('thread').hidden = false;
    const t = d.thread;
    $('thread-title').textContent = t.id;
    $('thread-state').textContent = t.state + (t.park_reason ? ' (' + t.park_reason + ')' : '') +
      ' · ' + t.project_claude + ' ↔ ' + t.project_codex + ' · turns ' + t.turns + ' · hops ' + t.hops +
      (t.close_note ? ' · note: ' + t.close_note : '');
    const tl = $('timeline');
    tl.replaceChildren();
    for (const m of d.messages) {
      const li = el('li', (m.principal === 'human' ? 'human ' : '') + (m.status === 'held' ? 'held' : ''));
      li.append(el('div', 'meta',
        m.from_name + ' (' + m.principal + ') → ' + m.to_name + ' · ' + m.kind + ' · hop ' + m.hop + ' · turn ' + m.turn +
        ' · ' + m.status + (m.park_reason ? ' (' + m.park_reason + ')' : '') + (m.redacted ? ' · secret redacted' : '') +
        ' · ' + m.id));
      li.append(el('div', 'body', m.body));
      for (const r of m.refs) li.append(el('div', 'meta', 'ref: ' + Object.entries(r).map(([k, v]) => k + '=' + v).join(' ')));
      // Agent reactions on this message. A codex-user reaction is the Codex
      // side's outside client, an agent, never the maintainer.
      for (const r of (d.reactions || []).filter((x) => x.message_id === m.id)) {
        const what = r.reaction === 'none' ? 'reaction cleared' : (r.emoji || '') + ' ' + r.reaction;
        li.append(el('div', 'meta reaction', what + ' · from ' + r.from_name + ' (' + r.principal + ', agent) · ' + (r.delivered_at ? 'delivered' : 'pending')));
      }
      tl.append(li);
    }
    const au = $('audit');
    au.replaceChildren();
    for (const a of d.audit) au.append(el('li', null, a.at + ' ' + a.principal + '/' + a.actor + ' ' + a.action + ' ' + a.outcome + (a.code ? ' ' + a.code : '')));
  }

  async function refresh() {
    try {
      const data = await api('/api/threads');
      renderGuards(data.guards);
      renderQuestions(data.questions);
      renderThreads(data.threads);
      renderGuardFlags(data.guard_flags);
      if (selected) renderThread(await api('/api/threads/' + encodeURIComponent(selected)));
    } catch (e) {
      showError(e.message);
    }
  }

  function bindCompose(form, threadIdFn) {
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const body = { to: form.elements.to.value, kind: form.elements.kind.value, body: form.elements.body.value };
      const tid = threadIdFn();
      if (tid) body.thread_id = tid;
      showError('');
      api('/api/messages', body).then((r) => { form.elements.body.value = ''; selected = r.thread_id; refresh(); }).catch((e) => showError(e.message));
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      csrf = (await api('/api/session')).csrf;
    } catch (e) {
      showError('Not signed in. Open the login link printed in the hub terminal.');
      return;
    }
    bindCompose($('compose-new'), () => null);
    bindCompose($('compose'), () => selected);
    $('unpark').addEventListener('click', () => act('/api/threads/' + selected + '/unpark'));
    $('pause').addEventListener('click', () => act('/api/threads/' + selected + '/pause'));
    $('stop').addEventListener('click', () => act('/api/threads/' + selected + '/stop', {}, 'Stop this thread? Undelivered messages are discarded.'));
    $('stop-claude').addEventListener('click', () => act('/api/sides/claude/stop', {}, 'Stop the Claude side? Its sessions are killed and their tokens revoked.'));
    $('stop-codex').addEventListener('click', () => act('/api/sides/codex/stop', {}, 'Stop the Codex side? Its sessions are killed and their tokens revoked.'));
    $('resume-claude').addEventListener('click', () => act('/api/sides/claude/resume', {}, 'Resume the Claude side? It gets new token files; parked threads stay parked until you unpark them.'));
    $('resume-codex').addEventListener('click', () => act('/api/sides/codex/resume', {}, 'Resume the Codex side? It gets new token files; parked threads stay parked until you unpark them.'));
    $('stop-all').addEventListener('click', () => act('/api/stop-all', {}, 'Stop everything?'));
    refresh();
    setInterval(refresh, 3000);
  });
})();
