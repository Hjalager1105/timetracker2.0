'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const M = require('./lib/merge');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SECRET = process.env.SESSION_SECRET || ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) console.warn('ADVARSEL: ADMIN_PASSWORD er ikke sat — ingen kan logge ind.');

const dbUrl = process.env.DATABASE_URL || '';
const pool = new Pool({
  connectionString: dbUrl,
  ssl: !dbUrl || /localhost|127\.0\.0\.1|\.railway\.internal/.test(dbUrl) ? false : { rejectUnauthorized: false }
});

const START = { Kunde: 910001, Produkt: 920001 };
const DEFAULT_SETTINGS = { ogCaterId: '9000', ogCaterName: 'OG', ffCaterName: 'Frokostfirmaet' };

// ---------- Database ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS og_id_register (
      type     TEXT NOT NULL CHECK (type IN ('Kunde','Produkt')),
      norm     TEXT NOT NULL,
      navn     TEXT NOT NULL,
      id       INTEGER NOT NULL,
      oprettet TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (type, norm)
    );
    CREATE TABLE IF NOT EXISTS ordre_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ordre_log (
      id SERIAL PRIMARY KEY, koert TIMESTAMPTZ NOT NULL DEFAULT now(),
      dato TEXT, kilder TEXT, kunder INTEGER, produkter INTEGER, nye_ider INTEGER
    );`);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM og_id_register');
  if (rows[0].n === 0) {
    const seed = require('./db/og_register_seed.json');
    for (const s of seed) {
      await pool.query('INSERT INTO og_id_register (type, norm, navn, id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [s.type, M.norm(s.navn), s.navn, s.id]);
    }
    console.log(`ID-register oprettet med ${seed.length} faste OG-ID'er.`);
  }
}

async function getSettings(db = pool) {
  const { rows } = await db.query('SELECT key, value FROM ordre_settings');
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in s) s[r.key] = r.value;
  return s;
}

async function loadRegister(db = pool) {
  const { rows } = await db.query('SELECT type, norm, navn, id FROM og_id_register');
  const reg = { Kunde: new Map(), Produkt: new Map() };
  for (const r of rows) reg[r.type].set(r.norm, { id: r.id, navn: r.navn });
  return reg;
}

// ---------- Login ----------
function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('hex'); }
function makeToken() { const exp = String(Date.now() + 12 * 3600 * 1000); return exp + '.' + sign(exp); }
function validToken(t) {
  if (!t || !SECRET) return false;
  const [exp, sig] = t.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function requireAuth(req, res, next) {
  if (validToken(cookies(req).gt)) return next();
  res.status(401).json({ error: 'Log ind igen.' });
}

// ---------- Fletning ----------
function readFiles(files) {
  const found = {}, ukendte = [];
  for (const f of files || []) {
    const rows = M.parseCSV(f.text);
    const type = M.detect(rows);
    if (!type) { ukendte.push(f.name); continue; }
    if (found[type]) throw httpErr(`Der er uploadet to ${M.KILDE_NAVN[type]}-filer (${found[type].name} og ${f.name}).`);
    found[type] = { name: f.name, rows };
  }
  if (ukendte.length) throw httpErr('Filen kunne ikke genkendes som Wopla, Frokostfirmaet eller OG: ' + ukendte.join(', '));
  if (!Object.keys(found).length) throw httpErr('Upload mindst én fil.');
  return found;
}

function httpErr(msg) { const e = new Error(msg); e.status = 400; return e; }

// dd.mm.åååå fra Wopla/Frokostfirmaet, så OG får samme leveringsdato
function datesIn(found) {
  const d = new Set();
  if (found.wopla) found.wopla.rows.slice(1).forEach(r => d.add(r[0].trim()));
  if (found.frokostfirmaet) {
    const i = found.frokostfirmaet.rows[0].map(s => s.trim()).indexOf('OrdreDato');
    found.frokostfirmaet.rows.slice(1).forEach(r => d.add(r[i].trim()));
  }
  return [...d].filter(Boolean);
}

function unknownNames(found, reg) {
  const out = { Kunde: [], Produkt: [] };
  if (!found.og) return out;
  const names = M.ogNames(found.og.rows);
  for (const t of ['Kunde', 'Produkt']) {
    const seen = new Set();
    for (const n of names[t]) {
      const k = M.norm(n);
      if (!reg[t].has(k) && !seen.has(k)) { seen.add(k); out[t].push(n); }
    }
  }
  return out;
}

function summary(found) {
  const s = {};
  for (const [t, f] of Object.entries(found)) s[t] = { fil: f.name, linjer: f.rows.length - 1 };
  return s;
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', (req, res) => {
  const pw = String((req.body && req.body.password) || '');
  const ok = ADMIN_PASSWORD && pw.length === ADMIN_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(ADMIN_PASSWORD));
  if (!ok) return res.status(401).json({ error: 'Forkert adgangskode.' });
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `gt=${makeToken()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'gt=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ loggedIn: validToken(cookies(req).gt) }));

// Trin 1: læs filerne og find nye OG-navne, uden at gemme noget
app.post('/api/analyse', requireAuth, async (req, res, next) => {
  try {
    const found = readFiles(req.body.files);
    const reg = await loadRegister();
    const ids = { Kunde: [], Produkt: [] };
    for (const t of ['Kunde', 'Produkt']) {
      const byId = new Map();
      for (const v of reg[t].values()) if (!byId.has(v.id)) byId.set(v.id, v.navn);
      ids[t] = [...byId].map(([id, navn]) => ({ id, navn })).sort((a, b) => a.navn.localeCompare(b.navn, 'da'));
    }
    res.json({ filer: summary(found), datoer: datesIn(found), nye: unknownNames(found, reg), eksisterende: ids });
  } catch (e) { next(e); }
});

// Trin 2: tildel ID'er til nye navne og byg den samlede fil
app.post('/api/generer', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const found = readFiles(req.body.files);
    const datoer = datesIn(found);
    let dato = String(req.body.dato || '').trim();
    if (!dato) {
      if (datoer.length === 1) dato = datoer[0];
      else if (found.og) throw httpErr('Vælg leveringsdato for OG-bestillingerne.');
    }
    if (dato && !/^\d{2}\.\d{2}\.\d{4}$/.test(dato)) throw httpErr('Datoen skal være på formen dd.mm.åååå.');

    await client.query('BEGIN');
    await client.query('LOCK TABLE og_id_register IN EXCLUSIVE MODE');
    const settings = await getSettings(client);
    const reg = await loadRegister(client);
    const mappings = Array.isArray(req.body.mappings) ? req.body.mappings : [];
    const nye = [];

    const unknown = unknownNames(found, reg);
    for (const t of ['Kunde', 'Produkt']) {
      for (const navn of unknown[t]) {
        const m = mappings.find(x => x.type === t && M.norm(x.navn) === M.norm(navn));
        let id;
        if (m && m.id) {
          id = Number(m.id);
          const exists = [...reg[t].values()].some(v => v.id === id);
          if (!exists) throw httpErr(`${t}-ID ${m.id} findes ikke i registret.`);
        } else {
          const { rows } = await client.query('SELECT COALESCE(MAX(id), $2 - 1) + 1 AS id FROM og_id_register WHERE type = $1', [t, START[t]]);
          id = rows[0].id;
        }
        await client.query('INSERT INTO og_id_register (type, norm, navn, id) VALUES ($1,$2,$3,$4)', [t, M.norm(navn), navn.trim(), id]);
        reg[t].set(M.norm(navn), { id, navn: navn.trim() });
        nye.push({ type: t, navn: navn.trim(), id, koblet: !!(m && m.id) });
      }
    }

    const lookup = (t, n) => String(reg[t].get(M.norm(n)).id);
    let orders = [];
    if (found.wopla) orders = orders.concat(M.parseWopla(found.wopla.rows));
    if (found.frokostfirmaet) orders = orders.concat(M.parseFrokostfirmaet(found.frokostfirmaet.rows, settings));
    if (found.og) orders = orders.concat(M.parseOG(found.og.rows, dato, settings, lookup));
    const { csv, produkter } = M.buildCSV(orders);

    await client.query('INSERT INTO ordre_log (dato, kilder, kunder, produkter, nye_ider) VALUES ($1,$2,$3,$4,$5)',
      [dato || datoer.join(','), Object.keys(found).map(k => M.KILDE_NAVN[k]).join(', '), orders.length, produkter, nye.length]);
    await client.query('COMMIT');

    const tal = {};
    for (const o of orders) tal[o.kilde] = (tal[o.kilde] || 0) + 1;
    const fil = 'Samlet_bestillinger_' + (dato || datoer[0] || 'ukendt').replace(/\./g, '-') + '.csv';
    res.json({ csv, filnavn: fil, kunder: orders.length, produkter, pr_kilde: tal, nye });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally { client.release(); }
});

app.get('/api/register', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT type, navn, id, oprettet FROM og_id_register ORDER BY type, id, oprettet');
    res.json(rows);
  } catch (e) { next(e); }
});

// Peg et navn på et andet (eksisterende) ID, fx hvis OG har ændret stavemåde
app.post('/api/register/flyt', requireAuth, async (req, res, next) => {
  try {
    const { type, navn, id } = req.body || {};
    if (!['Kunde', 'Produkt'].includes(type)) throw httpErr('Ukendt type.');
    const ex = await pool.query('SELECT 1 FROM og_id_register WHERE type=$1 AND id=$2 AND norm<>$3 LIMIT 1', [type, Number(id), M.norm(navn)]);
    if (!ex.rowCount) throw httpErr(`Der er intet andet navn med ${type}-ID ${id}.`);
    const r = await pool.query('UPDATE og_id_register SET id=$3 WHERE type=$1 AND norm=$2', [type, M.norm(navn), Number(id)]);
    if (!r.rowCount) throw httpErr('Navnet findes ikke i registret.');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get('/api/register.csv', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT type, id, navn FROM og_id_register ORDER BY type, id, navn');
    const body = '﻿Type;ID;Navn\r\n' + rows.map(r => [r.type, r.id, /[;"]/.test(r.navn) ? `"${r.navn.replace(/"/g, '""')}"` : r.navn].join(';')).join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="OG_ID_register.csv"');
    res.send(body);
  } catch (e) { next(e); }
});

app.get('/api/settings', requireAuth, async (req, res, next) => {
  try { res.json(await getSettings()); } catch (e) { next(e); }
});
app.put('/api/settings', requireAuth, async (req, res, next) => {
  try {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (req.body && typeof req.body[k] === 'string' && req.body[k].trim()) {
        await pool.query('INSERT INTO ordre_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, req.body[k].trim()]);
      }
    }
    res.json(await getSettings());
  } catch (e) { next(e); }
});

app.get('/api/log', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT koert, dato, kilder, kunder, produkter, nye_ider FROM ordre_log ORDER BY koert DESC LIMIT 30');
    res.json(rows);
  } catch (e) { next(e); }
});

app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Serverfejl: ' + err.message });
});

initDb()
  .then(() => app.listen(PORT, () => console.log('Gastrotid ordresamler kører på port ' + PORT)))
  .catch(e => { console.error('Kunne ikke forbinde til databasen:', e.message); process.exit(1); });
