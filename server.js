const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// Set this in Railway → Variables → ADMIN_PASSWORD. Falls back to a default
// so the app still runs locally, but change it before real use.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

// --- tiny JSON "database" -------------------------------------------------

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { employees: [], entries: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to read data.json, starting fresh:', e.message);
    return { employees: [], entries: [] };
  }
}

function saveData(data) {
  // write to a temp file then rename, so a crash mid-write can't corrupt data.json
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

let data = loadData();

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

// --- password hashing --------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  if (!password || !salt || !hash) return false;
  const attempt = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(attempt, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// --- admin auth middleware ----------------------------------------------

function requireAdmin(req, res, next) {
  const provided = req.get('x-admin-password') || '';
  if (!timingSafeStringEqual(provided, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Incorrect admin password.' });
  }
  next();
}

// --- app -------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Check an admin password without doing anything else (for the login screen)
app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body;
  if (!timingSafeStringEqual(password || '', ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Incorrect admin password.' });
  }
  res.json({ ok: true });
});

// Get everything the frontend needs in one call.
// Employee password hashes never leave the server.
app.get('/api/state', (req, res) => {
  const employees = data.employees.map(({ id, name }) => ({ id, name }));
  res.json({ employees, entries: data.entries });
});

// Add an employee — admin only, sets the employee's clock-in password
app.post('/api/employees', requireAdmin, (req, res) => {
  const name = (req.body.name || '').trim();
  const password = (req.body.password || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (!password) return res.status(400).json({ error: 'A password for this employee is required.' });

  const { salt, hash } = hashPassword(password);
  const employee = { id: uid(), name, passwordSalt: salt, passwordHash: hash };
  data.employees.push(employee);
  saveData(data);
  res.json({ id: employee.id, name: employee.name });
});

// Remove an employee (keeps their past entries for the record) — admin only
app.delete('/api/employees/:id', requireAdmin, (req, res) => {
  data.employees = data.employees.filter(e => e.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

// Reset an employee's password — admin only
app.post('/api/employees/:id/password', requireAdmin, (req, res) => {
  const employee = data.employees.find(e => e.id === req.params.id);
  if (!employee) return res.status(404).json({ error: 'Employee not found.' });
  const password = (req.body.password || '').trim();
  if (!password) return res.status(400).json({ error: 'A new password is required.' });

  const { salt, hash } = hashPassword(password);
  employee.passwordSalt = salt;
  employee.passwordHash = hash;
  saveData(data);
  res.json({ ok: true });
});

// Clock in — requires the employee's own password
app.post('/api/entries/clock-in', (req, res) => {
  const { employeeId, password } = req.body;
  const employee = data.employees.find(e => e.id === employeeId);
  if (!employee) return res.status(404).json({ error: 'Employee not found.' });
  if (!verifyPassword(password, employee.passwordSalt, employee.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  const alreadyActive = data.entries.find(e => e.employeeId === employeeId && !e.clockOut);
  if (alreadyActive) return res.status(400).json({ error: 'Already clocked in.' });

  const entry = { id: uid(), employeeId, clockIn: Date.now(), clockOut: null };
  data.entries.push(entry);
  saveData(data);
  res.json(entry);
});

// Clock out — requires the employee's own password
app.post('/api/entries/clock-out', (req, res) => {
  const { employeeId, password } = req.body;
  const employee = data.employees.find(e => e.id === employeeId);
  if (!employee) return res.status(404).json({ error: 'Employee not found.' });
  if (!verifyPassword(password, employee.passwordSalt, employee.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  const entry = data.entries.find(e => e.employeeId === employeeId && !e.clockOut);
  if (!entry) return res.status(400).json({ error: 'Not currently clocked in.' });

  entry.clockOut = Date.now();
  saveData(data);
  res.json(entry);
});

// Manually edit an entry (admin correction) — admin only
app.put('/api/entries/:id', requireAdmin, (req, res) => {
  const entry = data.entries.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });

  const { clockIn, clockOut } = req.body;
  if (clockIn) entry.clockIn = Number(clockIn);
  if (clockOut !== undefined) entry.clockOut = clockOut ? Number(clockOut) : null;
  saveData(data);
  res.json(entry);
});

// Delete an entry — admin only
app.delete('/api/entries/:id', requireAdmin, (req, res) => {
  data.entries = data.entries.filter(e => e.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Time tracker running at http://localhost:${PORT}`);
});
