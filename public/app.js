'use strict';

// ── IST helpers ───────────────────────────────────────────────────────────────

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function nowIST() {
  return new Date(Date.now() + IST_OFFSET_MS);
}

function toISTDate(iso) {
  return new Date(new Date(iso).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function mondayOf(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay(); // 0=Sun
  const diff = (day === 0 ? -6 : 1 - day);
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

function weekDates(monday) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

function todayIST() {
  return nowIST().toISOString().slice(0, 10);
}

function currentISTTime() {
  const n = nowIST();
  return `${String(n.getUTCHours()).padStart(2, '0')}:${String(n.getUTCMinutes()).padStart(2, '0')}`;
}

function formatSeconds(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  if (m) return `${m}m`;
  return '0m';
}

function parseDuration(str) {
  // supports: 2h 30m | 2h30m | 1.5h | 90m | 2h | 30m | 1:30
  const s = str.trim().toLowerCase();
  let sec = 0;
  const hm = s.match(/(\d+\.?\d*)\s*h(?:\s*(\d+\.?\d*)\s*m)?/);
  const mOnly = s.match(/^(\d+\.?\d*)\s*m$/);
  const colonFmt = s.match(/^(\d+):(\d{2})$/);
  if (hm) {
    sec = Math.round(parseFloat(hm[1]) * 3600 + (hm[2] ? parseFloat(hm[2]) * 60 : 0));
  } else if (mOnly) {
    sec = Math.round(parseFloat(mOnly[1]) * 60);
  } else if (colonFmt) {
    sec = parseInt(colonFmt[1], 10) * 3600 + parseInt(colonFmt[2], 10) * 60;
  }
  return sec; // 0 = invalid
}

function secsToJira(sec) {
  // Jira accepts "2h 30m", "90m", "1h"
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function istStarted(date, time) {
  // Returns "2026-09-01T09:00:00.000+0530"
  return `${date}T${time}:00.000+0530`;
}

function shortDate(iso) {
  const [, m, d] = iso.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
}

const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES_FULL  = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dayOfWeek(iso) {
  // iso is a UTC date string — treat as UTC
  const d = new Date(iso + 'T00:00:00Z');
  return d.getUTCDay();
}

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  user: null,           // { accountId, displayName, emailAddress }
  weekMonday: mondayOf(new Date(todayIST() + 'T00:00:00Z')),
  worklogs: {},         // { "2026-09-01": [...] }
  loading: false,
  teamMembers: [],
};

// ── DOM refs ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const els = {
  weekLabel:   $('weekLabel'),
  weekStrip:   $('weekStrip'),
  days:        $('days'),
  prevWeek:    $('prevWeek'),
  nextWeek:    $('nextWeek'),
  todayBtn:    $('todayBtn'),

  userBtn:     $('userBtn'),
  userAvatar:  $('userAvatar'),
  userLabel:   $('userLabel'),
  userDropdown:$('userDropdown'),
  userSearch:  $('userSearch'),
  userList:    $('userList'),

  modalOverlay:$('modalOverlay'),
  modalTitle:  $('modalTitle'),
  modalForm:   $('modalForm'),
  fIssueKey:   $('fIssueKey'),
  fWorklogId:  $('fWorklogId'),
  fDate:       $('fDate'),
  fDate2:      $('fDate2'),
  fTime:       $('fTime'),
  fDuration:   $('fDuration'),
  fComment:    $('fComment'),
  fIssueSearch:$('fIssueSearch'),
  issueSummaryHint: $('issueSummaryHint'),
  issueResults:$('issueResults'),
  modalClose:  $('modalClose'),
  cancelBtn:   $('cancelBtn'),
  saveBtn:     $('saveBtn'),
  deleteBtn:   $('deleteBtn'),

  toastContainer: $('toastContainer'),
};

// ── Toast ─────────────────────────────────────────────────────────────────────

function toast(msg, type = 'default', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  els.toastContainer.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ── API ───────────────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const msg = (() => { try { return JSON.parse(text).error || text; } catch { return text; } })();
    throw new Error(msg);
  }
  return text ? JSON.parse(text) : null;
}

async function loadConfig() {
  try {
    const cfg = await apiFetch('/api/config');
    state.teamMembers = cfg.members || [];
  } catch {}
}

async function loadWorklogs() {
  if (!state.user) return;
  const dates = weekDates(state.weekMonday);
  state.loading = true;
  renderDays();
  try {
    const params = new URLSearchParams({ accountId: state.user.accountId });
    dates.forEach(d => params.append('dates[]', d));
    const data = await apiFetch(`/api/worklogs?${params}`);
    state.worklogs = data;
  } catch (err) {
    toast(`Failed to load worklogs: ${err.message}`, 'error');
    state.worklogs = {};
  } finally {
    state.loading = false;
    renderAll();
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function initials(name) {
  return (name || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function ticketChipClass(key) {
  const prefix = key.split('-')[0].toLowerCase();
  if (prefix === 'ipr') return 'ticket-chip ipr';
  if (prefix === 'isdo') return 'ticket-chip isdo';
  return 'ticket-chip';
}

function renderUserBtn() {
  const u = state.user;
  if (u) {
    els.userAvatar.textContent = initials(u.displayName);
    els.userLabel.textContent = u.displayName;
  } else {
    els.userAvatar.textContent = '?';
    els.userLabel.textContent = 'Select person';
  }
}

function renderWeekLabel() {
  const dates = weekDates(state.weekMonday);
  const first = dates[0], last = dates[6];
  const [fy, fm, fd] = first.split('-').map(Number);
  const [, lm, ld] = last.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const label = fm === lm
    ? `${months[fm - 1]} ${fd}–${ld}, ${fy}`
    : `${months[fm - 1]} ${fd} – ${months[lm - 1]} ${ld}, ${fy}`;
  els.weekLabel.textContent = label;
}

function renderWeekStrip() {
  const dates = weekDates(state.weekMonday);
  const today = todayIST();
  let totalSec = 0;

  const dayHtml = dates.map(date => {
    const entries = state.worklogs[date] || [];
    const sec = entries.reduce((s, e) => s + e.timeSpentSeconds, 0);
    totalSec += sec;
    const dow = dayOfWeek(date);
    const isToday = date === today;
    const hoursLabel = sec ? formatSeconds(sec) : '—';
    return `<div class="strip-day${isToday ? ' is-today' : ''}" data-date="${date}" role="button" tabindex="0" aria-label="${DAY_NAMES_FULL[dow]} ${formatSeconds(sec)}">
      <div class="strip-day-name">${DAY_NAMES_SHORT[dow]}</div>
      <div class="strip-day-hours${sec ? '' : ' zero'}">${hoursLabel}</div>
    </div>`;
  }).join('');

  els.weekStrip.innerHTML = `${dayHtml}
    <div class="strip-total">
      <div class="strip-total-label">Week</div>
      <div class="strip-total-hours">${totalSec ? formatSeconds(totalSec) : '—'}</div>
    </div>`;

  // Scroll to today's strip day on click
  els.weekStrip.querySelectorAll('.strip-day').forEach(el => {
    el.addEventListener('click', () => {
      const card = document.querySelector(`.day-card[data-date="${el.dataset.date}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
    });
  });
}

function renderLoading() {
  const dates = weekDates(state.weekMonday);
  els.days.innerHTML = dates.map(date => {
    const dow = dayOfWeek(date);
    return `<div class="day-card">
      <div class="day-head">
        <div class="day-head-left">
          <span class="day-name">${DAY_NAMES_FULL[dow]}</span>
          <span class="day-date-str">${shortDate(date)}</span>
        </div>
      </div>
      <div class="skeleton-row"><div class="skeleton-bar" style="width:60%"></div></div>
      <div class="skeleton-row"><div class="skeleton-bar" style="width:40%"></div></div>
    </div>`;
  }).join('');
}

function renderDays() {
  if (state.loading) { renderLoading(); return; }

  if (!state.user) {
    els.days.innerHTML = `<div class="no-user">
      <div class="no-user-icon">👤</div>
      <p>Select a team member to view worklogs</p>
      <small>Use the picker in the top-right corner</small>
    </div>`;
    els.weekStrip.innerHTML = '';
    els.weekLabel.textContent = '';
    return;
  }

  const dates = weekDates(state.weekMonday);
  const today = todayIST();

  els.days.innerHTML = dates.map(date => {
    const dow = dayOfWeek(date);
    const entries = state.worklogs[date] || [];
    const totalSec = entries.reduce((s, e) => s + e.timeSpentSeconds, 0);
    const isToday = date === today;
    const isWeekend = dow === 0 || dow === 6;

    const rowsHtml = entries.length
      ? `<table class="worklog-table" role="table">
          ${entries.map(e => `<tr class="worklog-row" data-key="${e.issueKey}" data-wid="${e.worklogId}" data-date="${date}" tabindex="0" role="row" aria-label="Edit ${e.issueKey} worklog">
            <td class="wl-ticket"><span class="${ticketChipClass(e.issueKey)}">${e.issueKey}</span></td>
            <td class="wl-note"><span class="wl-note-text${e.comment ? '' : ' empty'}">${e.comment ? e.comment : e.issueSummary || ''}</span></td>
            <td class="wl-time"><span class="wl-time-val">${e.timeSpent}</span></td>
          </tr>`).join('')}
        </table>`
      : `<div class="day-empty">No logs yet</div>`;

    return `<div class="day-card${isToday ? ' is-today' : ''}${isWeekend ? ' is-weekend' : ''}" data-date="${date}">
      <div class="day-head">
        <div class="day-head-left">
          <span class="day-name">${DAY_NAMES_FULL[dow]}</span>
          <span class="day-date-str">${shortDate(date)}</span>
        </div>
        <div class="day-head-right">
          <span class="day-total${totalSec ? '' : ' zero'}">${totalSec ? formatSeconds(totalSec) : '0h'}</span>
          <button class="add-btn" data-date="${date}" aria-label="Add worklog for ${DAY_NAMES_FULL[dow]}">
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            Add
          </button>
        </div>
      </div>
      ${rowsHtml}
    </div>`;
  }).join('');

  // bind add buttons
  els.days.querySelectorAll('.add-btn').forEach(btn => {
    btn.addEventListener('click', () => openModal({ date: btn.dataset.date }));
  });

  // bind worklog rows for edit
  els.days.querySelectorAll('.worklog-row').forEach(row => {
    const open = () => {
      const date = row.dataset.date;
      const issueKey = row.dataset.key;
      const worklogId = row.dataset.wid;
      const entries = state.worklogs[date] || [];
      const entry = entries.find(e => e.worklogId === worklogId);
      if (entry) openModal({ date, edit: { ...entry, issueKey, worklogId } });
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
  });
}

function renderAll() {
  renderWeekLabel();
  renderWeekStrip();
  renderDays();
}

// ── User picker ───────────────────────────────────────────────────────────────

function renderUserList(members) {
  if (!members.length) {
    els.userList.innerHTML = '<div class="user-list-empty">No results</div>';
    return;
  }
  els.userList.innerHTML = members.map(u => `
    <div class="user-item" data-id="${u.accountId}" tabindex="0" role="option">
      <div class="user-item-avatar">${initials(u.displayName)}</div>
      <div class="user-item-info">
        <span class="user-item-name">${u.displayName}</span>
        <span class="user-item-email">${u.emailAddress || ''}</span>
      </div>
    </div>`).join('');

  els.userList.querySelectorAll('.user-item').forEach(item => {
    const pick = () => {
      const u = members.find(m => m.accountId === item.dataset.id);
      if (!u) return;
      selectUser(u);
      closeUserDropdown();
    };
    item.addEventListener('click', pick);
    item.addEventListener('keydown', e => { if (e.key === 'Enter') pick(); });
  });
}

function openUserDropdown() {
  els.userDropdown.hidden = false;
  els.userBtn.setAttribute('aria-expanded', 'true');
  els.userSearch.value = '';
  renderUserList(state.teamMembers);
  els.userSearch.focus();
}

function closeUserDropdown() {
  els.userDropdown.hidden = true;
  els.userBtn.setAttribute('aria-expanded', 'false');
}

let userSearchTimer = null;
els.userSearch.addEventListener('input', () => {
  clearTimeout(userSearchTimer);
  const q = els.userSearch.value.trim();
  if (!q) { renderUserList(state.teamMembers); return; }
  userSearchTimer = setTimeout(async () => {
    try {
      const results = await apiFetch(`/api/users/search?q=${encodeURIComponent(q)}`);
      renderUserList(results);
    } catch {
      renderUserList([]);
    }
  }, 300);
});

els.userBtn.addEventListener('click', () => {
  if (els.userDropdown.hidden) openUserDropdown(); else closeUserDropdown();
});

document.addEventListener('click', e => {
  if (!$('userPicker').contains(e.target)) closeUserDropdown();
});

function selectUser(u) {
  state.user = u;
  renderUserBtn();
  localStorage.setItem('worklog_user', JSON.stringify(u));
  state.worklogs = {};
  loadWorklogs();
}

// ── Week navigation ───────────────────────────────────────────────────────────

els.prevWeek.addEventListener('click', () => {
  const m = new Date(state.weekMonday);
  m.setUTCDate(m.getUTCDate() - 7);
  state.weekMonday = m;
  state.worklogs = {};
  loadWorklogs().then(renderAll);
  renderAll();
});

els.nextWeek.addEventListener('click', () => {
  const m = new Date(state.weekMonday);
  m.setUTCDate(m.getUTCDate() + 7);
  state.weekMonday = m;
  state.worklogs = {};
  loadWorklogs().then(renderAll);
  renderAll();
});

els.todayBtn.addEventListener('click', () => {
  state.weekMonday = mondayOf(new Date(todayIST() + 'T00:00:00Z'));
  state.worklogs = {};
  loadWorklogs().then(renderAll);
  renderAll();
});

// ── Issue autocomplete ────────────────────────────────────────────────────────

let issueSearchTimer = null;

function setIssueKey(key, summary) {
  els.fIssueKey.value = key;
  els.fIssueSearch.value = key;
  els.issueSummaryHint.textContent = summary || '';
  closeIssueResults();
}

function closeIssueResults() {
  els.issueResults.hidden = true;
  els.issueResults.innerHTML = '';
}

function renderIssueResults(issues) {
  if (!issues.length) { closeIssueResults(); return; }
  els.issueResults.innerHTML = issues.map(i =>
    `<div class="issue-option" data-key="${i.key}" data-sum="${(i.summary || '').replace(/"/g, '&quot;')}" tabindex="0">
      <span class="issue-option-key">${i.key}</span>
      <span class="issue-option-sum">${i.summary || ''}</span>
    </div>`
  ).join('');
  els.issueResults.hidden = false;

  els.issueResults.querySelectorAll('.issue-option').forEach(opt => {
    const pick = () => setIssueKey(opt.dataset.key, opt.dataset.sum);
    opt.addEventListener('click', pick);
    opt.addEventListener('keydown', e => { if (e.key === 'Enter') pick(); });
  });
}

els.fIssueSearch.addEventListener('input', () => {
  clearTimeout(issueSearchTimer);
  const q = els.fIssueSearch.value.trim();
  els.fIssueKey.value = '';
  els.issueSummaryHint.textContent = '';
  if (!q) { closeIssueResults(); return; }

  // Immediate resolution if it looks like a valid key already
  if (/^[A-Za-z]+-\d+$/.test(q)) {
    els.fIssueKey.value = q.toUpperCase();
  }

  issueSearchTimer = setTimeout(async () => {
    try {
      const issues = await apiFetch(`/api/issues/search?q=${encodeURIComponent(q)}`);
      renderIssueResults(issues);
      if (issues.length === 1 && issues[0].key.toUpperCase() === q.toUpperCase()) {
        setIssueKey(issues[0].key, issues[0].summary);
      }
    } catch { closeIssueResults(); }
  }, 280);
});

els.fIssueSearch.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeIssueResults();
  if (e.key === 'ArrowDown') {
    const first = els.issueResults.querySelector('.issue-option');
    if (first) { e.preventDefault(); first.focus(); }
  }
});

document.addEventListener('click', e => {
  if (!els.fIssueSearch.contains(e.target) && !els.issueResults.contains(e.target)) {
    closeIssueResults();
  }
});

// ── Modal ─────────────────────────────────────────────────────────────────────

function openModal({ date, edit }) {
  if (!state.user) { toast('Select a team member first', 'error'); return; }
  closeIssueResults();

  if (edit) {
    els.modalTitle.textContent = 'Edit worklog';
    els.fIssueKey.value = edit.issueKey;
    els.fIssueSearch.value = edit.issueKey;
    els.issueSummaryHint.textContent = edit.issueSummary || '';
    els.fWorklogId.value = edit.worklogId;
    els.fDate.value = date;
    els.fDate2.value = date;
    // Extract IST time from started
    const startedIST = new Date(new Date(edit.started).getTime() + IST_OFFSET_MS);
    const hh = String(startedIST.getUTCHours()).padStart(2, '0');
    const mm = String(startedIST.getUTCMinutes()).padStart(2, '0');
    els.fTime.value = `${hh}:${mm}`;
    els.fDuration.value = edit.timeSpent;
    els.fComment.value = edit.comment || '';
    els.deleteBtn.hidden = false;
  } else {
    els.modalTitle.textContent = 'Log time';
    els.fIssueKey.value = '';
    els.fIssueSearch.value = '';
    els.issueSummaryHint.textContent = '';
    els.fWorklogId.value = '';
    els.fDate.value = date;
    els.fDate2.value = date;
    els.fTime.value = currentISTTime();
    els.fDuration.value = '';
    els.fComment.value = '';
    els.deleteBtn.hidden = true;
  }

  els.modalOverlay.hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => els.fIssueSearch.focus(), 50);
}

function closeModal() {
  els.modalOverlay.hidden = true;
  document.body.style.overflow = '';
  closeIssueResults();
}

els.modalClose.addEventListener('click', closeModal);
els.cancelBtn.addEventListener('click', closeModal);
els.modalOverlay.addEventListener('click', e => {
  if (e.target === els.modalOverlay) closeModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !els.modalOverlay.hidden) closeModal();
});

els.fDate2.addEventListener('change', () => {
  els.fDate.value = els.fDate2.value;
});

function validateForm() {
  const key = els.fIssueKey.value.trim();
  if (!key) {
    els.fIssueSearch.focus();
    toast('Enter an issue key', 'error');
    return false;
  }
  if (!els.fDate.value) {
    toast('Date is required', 'error');
    return false;
  }
  const sec = parseDuration(els.fDuration.value);
  if (!sec) {
    els.fDuration.focus();
    toast('Invalid duration — use "2h 30m", "90m", or "1:30"', 'error');
    return false;
  }
  return { key, sec };
}

els.modalForm.addEventListener('submit', async e => {
  e.preventDefault();
  const valid = validateForm();
  if (!valid) return;

  const { key, sec } = valid;
  const started = istStarted(els.fDate.value, els.fTime.value);
  const timeSpent = secsToJira(sec);
  const comment = els.fComment.value.trim();
  const worklogId = els.fWorklogId.value;

  els.saveBtn.disabled = true;
  els.saveBtn.textContent = 'Saving…';

  try {
    if (worklogId) {
      await apiFetch(`/api/worklogs/${key}/${worklogId}`, {
        method: 'PUT',
        body: { timeSpent, started, comment },
      });
      toast('Worklog updated', 'success');
    } else {
      await apiFetch('/api/worklogs', {
        method: 'POST',
        body: { issueKey: key, timeSpent, started, comment },
      });
      toast('Worklog saved', 'success');
    }
    closeModal();
    await loadWorklogs();
  } catch (err) {
    toast(`Error: ${err.message}`, 'error', 5000);
  } finally {
    els.saveBtn.disabled = false;
    els.saveBtn.textContent = 'Save';
  }
});

els.deleteBtn.addEventListener('click', async () => {
  const key = els.fIssueKey.value;
  const worklogId = els.fWorklogId.value;
  if (!key || !worklogId) return;
  if (!confirm('Delete this worklog entry?')) return;

  els.deleteBtn.disabled = true;
  try {
    await apiFetch(`/api/worklogs/${key}/${worklogId}`, { method: 'DELETE' });
    toast('Worklog deleted', 'success');
    closeModal();
    await loadWorklogs();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error', 5000);
  } finally {
    els.deleteBtn.disabled = false;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  await loadConfig();

  // Restore persisted user
  try {
    const saved = localStorage.getItem('worklog_user');
    if (saved) {
      state.user = JSON.parse(saved);
      renderUserBtn();
    }
  } catch {}

  renderAll();
  if (state.user) loadWorklogs();
}

init();
