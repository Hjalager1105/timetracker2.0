// One-time migration: reads data.json (the old storage format) and inserts
// everything into Postgres. Safe to run more than once — it skips rows
// that already exist by id.
//
// Usage:
//   DATABASE_URL=<your connection string> node migrate.js
//
// Run this from your own computer with data.json in the same folder
// (download it from Railway first — see README.md), or run it as a
// one-off command inside Railway if data.json is already on that volume.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATA_FILE = path.join(__dirname, 'data.json');

if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL before running this script.');
  process.exit(1);
}

if (!fs.existsSync(DATA_FILE)) {
  console.error(`No data.json found at ${DATA_FILE}. Nothing to migrate.`);
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
});

async function main() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  const data = JSON.parse(raw);

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

  let employeesInserted = 0;
  let employeesSkipped = 0;
  for (const emp of data.employees || []) {
    if (!emp.passwordHash || !emp.passwordSalt) {
      console.warn(`Skipping "${emp.name}" — no password set yet in the old data, add them fresh via Admin instead.`);
      employeesSkipped++;
      continue;
    }
    const result = await pool.query(
      `INSERT INTO employees (id, name, password_salt, password_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [emp.id, emp.name, emp.passwordSalt, emp.passwordHash]
    );
    if (result.rowCount > 0) employeesInserted++;
  }

  let entriesInserted = 0;
  for (const entry of data.entries || []) {
    const result = await pool.query(
      `INSERT INTO entries (id, employee_id, clock_in, clock_out)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [entry.id, entry.employeeId, entry.clockIn, entry.clockOut]
    );
    if (result.rowCount > 0) entriesInserted++;
  }

  console.log(`Done. Employees inserted: ${employeesInserted} (skipped: ${employeesSkipped}). Entries inserted: ${entriesInserted}.`);
  await pool.end();
}

main().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});
