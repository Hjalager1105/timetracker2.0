const state = { employees: [], entries: [] };
let adminPassword = null; // held in memory only, never persisted
const pendingAction = {}; // employeeId -> 'in' | 'out', while password entry is open

const viewClock = document.getElementById('view-clock');
const viewAdmin = document.getElementById('view-admin');
const tabClock = document.getElementById('tab-clock');
const tabAdmin = document.getElementById('tab-admin');
const statusEl = document.getElementById('status');

tabClock.addEventListener('click', () => switchTab('clock'));
tabAdmin.addEventListener('click', () => switchTab('admin'));

function switchTab(tab) {
  tabClock.classList.toggle('active', tab === 'clock');
  tabAdmin.classList.toggle('active', tab === 'admin');
  viewClock.classList.toggle('hidden', tab !== 'clock');
  viewAdmin.classList.toggle('hidden', tab !== 'admin');
  if (tab === 'admin') renderAdmin();
}

function showError(msg) {
  statusEl.textContent = msg || '';
  if (msg) setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 4000);
}

async function api(path, options, extraHeaders) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Request failed');
  return body;
}

function adminApi(path, options) {
  return api(path, options, { 'x-admin-password': adminPassword });
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const totalMin = Math.floor(ms / 60000);
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

function initials(name) {
  return name.trim().slice(0, 2).toUpperCase();
}

function activeEntryFor(empId) {
  return state.entries.find(e => e.employeeId === empId && !e.clockOut);
}

async function refresh() {
  const data = await api('/state');
  state.employees = data.employees;
  state.entries = data.entries;
  renderClock();
  if (!viewAdmin.classList.contains('hidden')) renderAdmin();
}

// --- Clock in/out view ------------------------------------------------

function renderClock() {
  if (state.employees.length === 0) {
    viewClock.innerHTML = `<p class="empty-state">No employees yet. Ask an admin to add your team from the Admin tab.</p>`;
    return;
  }
  viewClock.innerHTML = `<div class="card-grid">${state.employees.map(emp => {
    const active = activeEntryFor(emp.id);
    const pending = pendingAction[emp.id];
    return `
      <div class="card">
        <div class="employee-header">
          <div class="avatar">${initials(emp.name)}</div>
          <div>
            <p class="emp-name">${escapeHtml(emp.name)}</p>
            <p class="emp-status ${active ? 'active' : 'inactive'}">
              ${active ? `Clocked in at ${formatTime(active.clockIn)}` : 'Not clocked in'}
            </p>
          </div>
        </div>
        ${pending ? `
          <form class="pw-form" data-id="${emp.id}" data-action="${pending}">
            <input type="password" placeholder="Your password" autocomplete="off" autofocus />
            <div class="pw-form-buttons">
              <button type="submit" class="action ${pending === 'out' ? 'out' : 'in'}">
                Confirm ${pending === 'out' ? 'clock out' : 'clock in'}
              </button>
              <button type="button" class="pw-cancel" data-id="${emp.id}">Cancel</button>
            </div>
          </form>
        ` : `
          <button class="action ${active ? 'out' : 'in'}" data-id="${emp.id}" data-action="${active ? 'out' : 'in'}">
            ${active ? 'Clock out' : 'Clock in'}
          </button>
        `}
      </div>
    `;
  }).join('')}</div>`;

  viewClock.querySelectorAll('button.action[data-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingAction[btn.dataset.id] = btn.dataset.action;
      renderClock();
    });
  });

  viewClock.querySelectorAll('.pw-cancel').forEach(btn => {
    btn.addEventListener('click', () => {
      delete pendingAction[btn.dataset.id];
      renderClock();
    });
  });

  viewClock.querySelectorAll('.pw-form').forEach(form => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = form.dataset.id;
      const action = form.dataset.action;
      const password = form.querySelector('input').value;
      try {
        await api(`/entries/clock-${action}`, {
          method: 'POST',
          body: JSON.stringify({ employeeId: id, password }),
        });
        delete pendingAction[id];
        await refresh();
      } catch (err) {
        showError(err.message);
      }
    });
  });
}

// --- Admin view ---------------------------------------------------------

function renderAdmin() {
  if (!adminPassword) {
    viewAdmin.innerHTML = `
      <div class="card" style="max-width: 320px;">
        <h2 style="margin-bottom: 12px;">Admin sign-in</h2>
        <form id="admin-login-form">
          <input type="password" id="admin-password-input" placeholder="Admin password" autocomplete="off" style="width: 100%; margin-bottom: 10px;" />
          <button type="submit" class="action in" style="width: 100%;">Sign in</button>
        </form>
      </div>
    `;
    document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = document.getElementById('admin-password-input').value;
      try {
        await api('/admin/verify', { method: 'POST', body: JSON.stringify({ password: value }) });
        adminPassword = value;
        renderAdmin();
      } catch (err) {
        showError(err.message);
      }
    });
    return;
  }

  const totals = {};
  for (const emp of state.employees) totals[emp.id] = 0;
  for (const e of state.entries) {
    const end = e.clockOut || Date.now();
    totals[e.employeeId] = (totals[e.employeeId] || 0) + (end - e.clockIn);
  }

  const sortedEntries = [...state.entries].sort((a, b) => b.clockIn - a.clockIn);

  viewAdmin.innerHTML = `
    <div class="add-row">
      <input id="new-emp-name" type="text" placeholder="New employee name" />
      <input id="new-emp-password" type="password" placeholder="Set their password" autocomplete="off" />
      <button id="add-emp-btn">Add</button>
    </div>
    <div class="totals-grid">
      ${state.employees.map(emp => `
        <div class="total-card">
          <button class="remove-btn" data-id="${emp.id}" aria-label="Remove ${escapeHtml(emp.name)}">&times;</button>
          <p class="name">${escapeHtml(emp.name)}</p>
          <p class="hours">${formatDuration(totals[emp.id] || 0)}</p>
          <p class="label">total logged</p>
        </div>
      `).join('')}
    </div>
    <h2>Timesheet</h2>
    ${sortedEntries.length === 0 ? '<p class="empty-state">No entries yet.</p>' : `
      <table class="timesheet">
        <thead>
          <tr><th>Employee</th><th>Date</th><th>Clock in</th><th>Clock out</th><th>Duration</th><th></th></tr>
        </thead>
        <tbody>
          ${sortedEntries.map(e => {
            const emp = state.employees.find(x => x.id === e.employeeId);
            const end = e.clockOut || Date.now();
            return `
              <tr>
                <td>${emp ? escapeHtml(emp.name) : 'Removed employee'}</td>
                <td>${formatDate(e.clockIn)}</td>
                <td>${formatTime(e.clockIn)}</td>
                <td>${e.clockOut ? formatTime(e.clockOut) : 'active'}</td>
                <td>${formatDuration(end - e.clockIn)}</td>
                <td><button class="del-btn" data-id="${e.id}">Delete</button></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `}
  `;

  document.getElementById('add-emp-btn').addEventListener('click', addEmployee);
  document.getElementById('new-emp-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addEmployee();
  });

  viewAdmin.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await adminApi(`/employees/${btn.dataset.id}`, { method: 'DELETE' });
        await refresh();
      } catch (e) {
        showError(e.message);
      }
    });
  });

  viewAdmin.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await adminApi(`/entries/${btn.dataset.id}`, { method: 'DELETE' });
        await refresh();
      } catch (e) {
        showError(e.message);
      }
    });
  });
}

async function addEmployee() {
  const nameInput = document.getElementById('new-emp-name');
  const passwordInput = document.getElementById('new-emp-password');
  const name = nameInput.value.trim();
  const password = passwordInput.value.trim();
  if (!name || !password) {
    showError('Enter both a name and a password.');
    return;
  }
  try {
    await adminApi('/employees', { method: 'POST', body: JSON.stringify({ name, password }) });
    nameInput.value = '';
    passwordInput.value = '';
    await refresh();
  } catch (e) {
    showError(e.message);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

refresh().catch(e => showError(e.message));
setInterval(() => refresh().catch(() => {}), 15000); // keep clocked-in durations and team state fresh
