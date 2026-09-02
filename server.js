const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

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

// --- app -------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Get everything the frontend needs in one call
app.get('/api/state', (req, res) => {
  res.json({ employees: data.employees, entries: data.entries });
});

// Add an employee
app.post('/api/employees', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const employee = { id: uid(), name };
  data.employees.push(employee);
  saveData(data);
  res.json(employee);
});

// Remove an employee (keeps their past entries for the record)
app.delete('/api/employees/:id', (req, res) => {
  data.employees = data.employees.filter(e => e.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

// Clock in
app.post('/api/entries/clock-in', (req, res) => {
  const { employeeId } = req.body;
  const employee = data.employees.find(e => e.id === employeeId);
  if (!employee) return res.status(404).json({ error: 'Employee not found.' });

  const alreadyActive = data.entries.find(e => e.employeeId === employeeId && !e.clockOut);
  if (alreadyActive) return res.status(400).json({ error: 'Already clocked in.' });

  const entry = { id: uid(), employeeId, clockIn: Date.now(), clockOut: null };
  data.entries.push(entry);
  saveData(data);
  res.json(entry);
});

// Clock out
app.post('/api/entries/clock-out', (req, res) => {
  const { employeeId } = req.body;
  const entry = data.entries.find(e => e.employeeId === employeeId && !e.clockOut);
  if (!entry) return res.status(400).json({ error: 'Not currently clocked in.' });

  entry.clockOut = Date.now();
  saveData(data);
  res.json(entry);
});

// Manually edit an entry (admin correction)
app.put('/api/entries/:id', (req, res) => {
  const entry = data.entries.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });

  const { clockIn, clockOut } = req.body;
  if (clockIn) entry.clockIn = Number(clockIn);
  if (clockOut !== undefined) entry.clockOut = clockOut ? Number(clockOut) : null;
  saveData(data);
  res.json(entry);
});

// Delete an entry
app.delete('/api/entries/:id', (req, res) => {
  data.entries = data.entries.filter(e => e.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Time tracker running at http://localhost:${PORT}`);
});
