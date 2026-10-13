// Fletter bestillinger fra Wopla, Frokostfirmaet og OG til ét Wopla-format.
'use strict';

const DELIM = ';';
const FIXED = ['Dato', 'CaterId', 'CaterName', 'ClientId', 'ClientName', 'Adresse'];

// ---------- CSV ----------
function parseCSV(text) {
  text = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === DELIM) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

function csvField(v) {
  v = v == null ? '' : String(v);
  return /[;"\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

// Navne matches uden hensyn til store/små bogstaver og ekstra mellemrum
function norm(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// ---------- Genkendelse ----------
function detect(rows) {
  if (!rows.length) return null;
  const h = rows[0].map(s => s.trim());
  if (h[0] === 'Dato' && h[1] === 'CaterId' && h[6] === 'ProductId') return 'wopla';
  if (h.includes('KøkkenID') && h.includes('ProduktId') && h.includes('Mængde')) return 'frokostfirmaet';
  if (h[0] === 'Customer' && h[1] === 'Address' && h[2] === 'Route') return 'og';
  return null;
}

const KILDE_NAVN = { wopla: 'Wopla', frokostfirmaet: 'Frokostfirmaet', og: 'OG' };

// ---------- Parsere ----------
// En ordre: { Dato, CaterId, CaterName, ClientId, ClientName, Adresse, items: Map(productId -> {name, qty}) }
function addItem(items, id, name, qty) {
  id = String(id).trim();
  const n = Number(String(qty).trim().replace(',', '.')) || 0;
  const cur = items.get(id);
  if (cur) cur.qty += n; else items.set(id, { name: String(name).trim(), qty: n });
}

function parseWopla(rows) {
  const head = rows[0];
  const orders = [];
  for (const r of rows.slice(1)) {
    const items = new Map();
    for (let i = 6; i + 1 < head.length; i += 2) addItem(items, r[i], head[i + 1], r[i + 1] || 0);
    orders.push({
      Dato: r[0].trim(), CaterId: r[1].trim(), CaterName: r[2].trim(), ClientId: r[3].trim(),
      ClientName: r[4].trim(), Adresse: (r[5] || '').trim(), items, kilde: 'wopla'
    });
  }
  return orders;
}

function parseFrokostfirmaet(rows, settings) {
  const h = {};
  rows[0].forEach((n, i) => { h[n.trim()] = i; });
  const byKey = new Map();
  for (const r of rows.slice(1)) {
    const key = r[h.OrdreDato] + '|' + r[h.KundeID];
    if (!byKey.has(key)) {
      byKey.set(key, {
        Dato: r[h.OrdreDato].trim(), CaterId: r[h['KøkkenID']].trim(), CaterName: settings.ffCaterName,
        ClientId: r[h.KundeID].trim(), ClientName: r[h.Kundenavn].trim(), Adresse: '',
        items: new Map(), kilde: 'frokostfirmaet'
      });
    }
    addItem(byKey.get(key).items, r[h.ProduktId], r[h.Produktnavn], r[h['Mængde']]);
  }
  return [...byKey.values()];
}

// Navne i OG-filen som skal have ID'er
function ogNames(rows) {
  const head = rows[0];
  return {
    Produkt: head.slice(3).map(s => s.trim()).filter(Boolean),
    Kunde: rows.slice(1).map(r => r[0].trim()).filter(Boolean)
  };
}

// lookup(type, navn) -> id (string)
function parseOG(rows, dato, settings, lookup) {
  const head = rows[0];
  const orders = [];
  for (const r of rows.slice(1)) {
    if (!r[0].trim()) continue;
    const items = new Map();
    for (let i = 3; i < head.length; i++) {
      if (!head[i].trim()) continue;
      addItem(items, lookup('Produkt', head[i]), head[i], r[i] || 0);
    }
    orders.push({
      Dato: dato, CaterId: settings.ogCaterId, CaterName: settings.ogCaterName,
      ClientId: lookup('Kunde', r[0]), ClientName: r[0].trim(), Adresse: (r[1] || '').trim(),
      items, kilde: 'og'
    });
  }
  return orders;
}

// ---------- Samlet fil ----------
function buildCSV(orders) {
  const products = new Map(); // id -> {name, kilde}
  const conflicts = [];
  for (const o of orders) {
    for (const [id, it] of o.items) {
      const p = products.get(id);
      if (!p) products.set(id, { name: it.name, kilde: o.kilde });
      else if (p.kilde !== o.kilde) conflicts.push(`ProductId ${id} bruges af både ${KILDE_NAVN[p.kilde]} ("${p.name}") og ${KILDE_NAVN[o.kilde]} ("${it.name}")`);
    }
  }
  if (conflicts.length) {
    const err = new Error('Samme ProductId bruges i flere systemer:\n' + [...new Set(conflicts)].join('\n'));
    err.status = 400;
    throw err;
  }
  const head = [...FIXED];
  for (const [, p] of products) head.push('ProductId', p.name);
  const lines = [head];
  for (const o of orders) {
    const row = FIXED.map(c => o[c]);
    for (const [id] of products) {
      const it = o.items.get(id);
      row.push(id, it ? fmtQty(it.qty) : '0');
    }
    lines.push(row);
  }
  return {
    csv: '﻿' + lines.map(r => r.map(csvField).join(DELIM)).join('\r\n') + '\r\n',
    produkter: products.size
  };
}

function fmtQty(n) {
  return Number.isInteger(n) ? String(n) : String(n).replace('.', ',');
}

module.exports = { parseCSV, detect, norm, parseWopla, parseFrokostfirmaet, ogNames, parseOG, buildCSV, KILDE_NAVN };
