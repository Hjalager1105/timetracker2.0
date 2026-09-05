const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;

// Set this in Railway → Variables → ADMIN_PASSWORD. Falls back to a default
// so the app still runs locally, but change it before real use.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add a Postgres database in Railway and connect it — see README.md.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's internal Postgres connection doesn't need SSL; its public
  // connection string does. This works for both.
  ssl: process.env.DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      clock_in BIGINT NOT NULL,
      clock_out BIGINT
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS entries_employee_id_idx ON entries(employee_id);`);
}

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

app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body;
  if (!timingSafeStringEqual(password || '', ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Incorrect admin password.' });
  }
  res.json({ ok: true });
});

// Get everything the frontend needs in one call.
// Employee password hashes never leave the server.
app.get('/api/state', async (req, res) => {
  try {
    const employeesResult = await pool.query('SELECT id, name FROM employees ORDER BY name ASC');
    const entriesResult = await pool.query('SELECT id, employee_id, clock_in, clock_out FROM entries ORDER BY clock_in DESC');
    res.json({
      employees: employeesResult.rows,
      entries: entriesResult.rows.map(rowToEntry),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error.' });
  }
});

function rowToEntry(row) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    clockIn: Number(row.clock_in),
    clockOut: row.clock_out === null ? null : Number(row.clock_out),
  };
}

// Add an employee — admin only, sets the employee's clock-in password
app.post('/api/employees', requireAdmin, async (req, res) => {
  const name = (req.body.name || '').trim();
  const password = (req.body.password || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (!password) return res.status(400).json({ error: 'A password for this employee is required.' });

  try {
    const { salt, hash } = hashPassword(password);
    const id = uid();
    await pool.query(
      'INSERT INTO employees (id, name, password_salt, password_hash) VALUES ($1, $2, $3, $4)',
      [id, name, salt, hash]
    );
    res.json({ id, name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error.' });
  }
});

// Remove an employee (keeps their past entries for the record) — admin only
app.delete('/api/employees/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM employees WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error.' });
  }
});

// Reset an employee's password — admin only
app.post('/api/employees/:id/password', requireAdmin, async (req, res) => {
  const password = (req.body.password || '').trim();
  if (!password) return res.status(400).json({ error: 'A new password is required.' });

  try {
    const { salt, hash } = hashPassword(password);
    const result = await pool.query(
      'UPDATE employees SET password_salt = $1, password_hash = $2 WHERE id = $3',
      [salt, hash, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Employee not found.' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error.' });
  }
});

// Clock in — requires the employee's own password
app.post('/api/entries/clock-in', async (req, res) => {
  const { employeeId, password } = req.body;
  try {
    const empResult = await pool.query('SELECT * FROM employees WHERE id = $1', [employeeId]);
    const employee = empResult.rows[0];
    if (!employee) return res.status(404).json({ error: 'Employee not found.' });
    if (!verifyPassword(password, employee.password_salt, employee.password_hash)) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    const activeResult = await pool.query(
      'SELECT id FROM entries WHERE employee_id = $1 AND clock_out IS NULL',
      [employeeId]
    );
    if (activeResult.rows.length > 0) return res.status(400).json({ error: 'Already clocked in.' });

    const id = uid();
    const clockIn = Date.now();
    await pool.query(
      'INSERT INTO entries (id, employee_id, clock_in, clock_out) VALUES ($1, $2, $3, NULL)',
      [id, employeeId, clockIn]
    );
    res.json({ id, employeeId, clockIn, clockOut: null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error.' });
  }
});

// Clock out — requires the employee's own password
app.post('/api/entries/clock-out', async (req, res) => {
  const { employeeId, password } = req.body;
  try {
    const empResult = await pool.query('SELECT * FROM employees WHERE id = $1', [employeeId]);
    const employee = empResult.rows[0];
    if (!employee) return res.status(404).json({ error: 'Employee not found.' });
    if (!verifyPassword(password, employee.password_salt, employee.password_hash)) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    const activeResult = await pool.query(
      'SELECT id FROM entries WHERE employee_id = $1 AND clock_out IS NULL',
      [employeeId]
    );
    const active = activeResult.rows[0];
    if (!active) return res.status(400).json({ error: 'Not currently clocked in.' });

    const clockOut = Date.now();
    await pool.query('UPDATE entries SET clock_out = $1 WHERE id = $2', [clockOut, active.id]);
    res.json({ ok: true, clockOut });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error.' });
  }
});

// Manually edit an entry (admin correction) — admin only
app.put('/api/entries/:id', requireAdmin, async (req, res) => {
  const { clockIn, clockOut } = req.body;
  try {
    const result = await pool.query('SELECT * FROM entries WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Entry not found.' });

    const newClockIn = clockIn ? Number(clockIn) : result.rows[0].clock_in;
    const newClockOut = clockOut !== undefined ? (clockOut ? Number(clockOut) : null) : result.rows[0].clock_out;

    await pool.query('UPDATE entries SET clock_in = $1, clock_out = $2 WHERE id = $3', [
      newClockIn, newClockOut, req.params.id,
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error.' });
  }
});

// Delete an entry — admin only
app.delete('/api/entries/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM entries WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error.' });
  }
});

// Statistics for a date range — admin only.
// ?start=<ms>&end=<ms> as epoch milliseconds.
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const start = Number(req.query.start);
  const end = Number(req.query.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return res.status(400).json({ error: 'start and end query params (epoch ms) are required.' });
  }

  try {
    // Entries that overlap the requested window at all.
    const result = await pool.query(
      `SELECT e.id, e.employee_id, e.clock_in, e.clock_out, emp.name
       FROM entries e
       LEFT JOIN employees emp ON emp.id = e.employee_id
       WHERE e.clock_in <= $2 AND (e.clock_out IS NULL OR e.clock_out >= $1)`,
      [start, end]
    );

    const now = Date.now();
    const totals = {}; // employeeId -> { name, totalMs, shiftCount }

    for (const row of result.rows) {
      const clockIn = Number(row.clock_in);
      const clockOut = row.clock_out === null ? now : Number(row.clock_out);
      // Clip the shift to the requested window before summing.
      const overlapStart = Math.max(clockIn, start);
      const overlapEnd = Math.min(clockOut, end);
      const overlapMs = Math.max(0, overlapEnd - overlapStart);

      const key = row.employee_id;
      if (!totals[key]) {
        totals[key] = { employeeId: key, name: row.name || 'Removed employee', totalMs: 0, shiftCount: 0 };
      }
      totals[key].totalMs += overlapMs;
      totals[key].shiftCount += 1;
    }

    const stats = Object.values(totals).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ stats });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error.' });
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Time tracker running at http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error('Failed to initialize database:', e);
    process.exit(1);
  });
