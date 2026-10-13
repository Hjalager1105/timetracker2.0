'use strict';
const $ = s => document.querySelector(s);
const KILDE = { wopla: 'Wopla', frokostfirmaet: 'Frokostfirmaet', og: 'OG' };
let files = [];        // {name, text}
let analyse = null;    // svar fra /api/analyse

async function api(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error(data.error || 'Log ind igen.'); }
  if (!res.ok) throw new Error(data.error || 'Fejl ' + res.status);
  return data;
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- Login / navigation ----------
function showLogin() {
  $('#login').hidden = false; $('#nav').hidden = true;
  document.querySelectorAll('.view').forEach(v => v.hidden = true);
}
function showView(name) {
  $('#login').hidden = true; $('#nav').hidden = false;
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== name);
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  if (name === 'register') loadRegister();
  if (name === 'indstillinger') loadSettings();
}
document.querySelectorAll('.tab').forEach(t => t.onclick = () => showView(t.dataset.view));
$('#loginForm').onsubmit = async e => {
  e.preventDefault(); $('#loginErr').textContent = '';
  try { await api('/api/login', { body: { password: $('#pw').value } }); $('#pw').value = ''; showView('samling'); }
  catch (err) { $('#loginErr').textContent = err.message; }
};
$('#logout').onclick = async () => { await api('/api/logout', { body: {} }).catch(() => {}); showLogin(); };

// ---------- Filer ----------
function readFile(file) {
  const read = enc => new Promise((ok, fail) => {
    const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsText(file, enc);
  });
  // Filer gemt fra Excel kan være i Windows-1252 i stedet for UTF-8
  return read('utf-8').then(t => t.includes('�') ? read('windows-1252') : t);
}

async function addFiles(list) {
  for (const f of list) {
    const text = await readFile(f);
    files = files.filter(x => x.name !== f.name);
    files.push({ name: f.name, text });
  }
  await runAnalyse();
}

const drop = $('#drop');
$('#fileInput').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => addFiles([...e.dataTransfer.files]));

function detectLocal(text) {
  const h = text.replace(/^﻿/, '').split(/\r?\n/)[0].split(';').map(s => s.trim());
  if (h[0] === 'Dato' && h[1] === 'CaterId') return 'wopla';
  if (h.includes('KøkkenID') && h.includes('Mængde')) return 'frokostfirmaet';
  if (h[0] === 'Customer' && h[2] === 'Route') return 'og';
  return null;
}

function renderFiles() {
  $('#fileList').innerHTML = files.map((f, i) => {
    const t = detectLocal(f.text);
    const linjer = analyse && t && analyse.filer[t] ? ` · ${analyse.filer[t].linjer} linjer` : '';
    return `<li><span>${esc(f.name)}<span class="muted small">${linjer}</span></span>
      <span>${t ? `<span class="tag">${KILDE[t]}</span>` : '<span class="tag bad">Ukendt format</span>'}
      <button title="Fjern" data-i="${i}">×</button></span></li>`;
  }).join('');
  $('#fileList').querySelectorAll('button').forEach(b => b.onclick = () => { files.splice(+b.dataset.i, 1); runAnalyse(); });
}

// ---------- Analyse ----------
const toIso = d => { const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
const fromIso = d => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? `${m[3]}.${m[2]}.${m[1]}` : ''; };

async function runAnalyse() {
  analyse = null; $('#resultat').innerHTML = ''; $('#genErr').textContent = '';
  renderFiles();
  if (!files.length) { $('#step2').hidden = $('#step3').hidden = true; return; }
  try {
    analyse = await api('/api/analyse', { body: { files } });
  } catch (err) {
    $('#step2').hidden = true; $('#step3').hidden = false; $('#generer').disabled = true;
    $('#genErr').textContent = err.message; return;
  }
  renderFiles();
  const harOG = !!analyse.filer.og;
  $('#step2').hidden = false; $('#step3').hidden = false; $('#generer').disabled = false;

  const d = $('#dato');
  d.disabled = !harOG;
  if (analyse.datoer.length === 1) { d.value = toIso(analyse.datoer[0]); $('#datoHint').textContent = `Hentet fra ${analyse.filer.wopla ? 'Wopla' : 'Frokostfirmaet'}-filen.`; }
  else if (analyse.datoer.length > 1) { $('#datoHint').textContent = 'Filerne indeholder flere datoer: ' + analyse.datoer.join(', ') + '. Vælg datoen for OG.'; }
  else { $('#datoHint').textContent = harOG ? 'OG-filen har ingen dato. Vælg leveringsdato.' : ''; }
  if (!harOG) $('#datoHint').textContent = 'Ingen OG-fil uploadet.';

  const nye = [...analyse.nye.Kunde.map(n => ['Kunde', n]), ...analyse.nye.Produkt.map(n => ['Produkt', n])];
  if (!harOG) { $('#nyeWrap').innerHTML = ''; return; }
  if (!nye.length) { $('#nyeWrap').innerHTML = '<div class="ok">Alle OG-kunder og -produkter har allerede faste ID\'er.</div>'; return; }
  const opts = t => '<option value="">Nyt ID</option>' + analyse.eksisterende[t]
    .map(x => `<option value="${x.id}">Samme som: ${esc(x.navn)} (${x.id})</option>`).join('');
  $('#nyeWrap').innerHTML = `<div class="notice"><h3>${nye.length === 1 ? '1 nyt navn' : nye.length + ' nye navne'} i OG-filen</h3>
    <p class="small">Er det en ny kunde eller et nyt produkt, så behold "Nyt ID". Er det et gammelt navn, OG har stavet anderledes, så vælg det eksisterende, så Piranya bevarer relationen.</p>
    ${nye.map(([t, n], i) => `<div class="map"><span><span class="tag">${t}</span> ${esc(n)}</span>
      <select data-type="${t}" data-navn="${esc(n)}">${opts(t)}</select></div>`).join('')}</div>`;
}

// ---------- Generer ----------
$('#generer').onclick = async () => {
  $('#genErr').textContent = ''; $('#resultat').innerHTML = '';
  const mappings = [...document.querySelectorAll('#nyeWrap select')]
    .map(s => ({ type: s.dataset.type, navn: s.dataset.navn, id: s.value ? Number(s.value) : null }));
  const btn = $('#generer'); btn.disabled = true;
  try {
    const r = await api('/api/generer', { body: { files, dato: fromIso($('#dato').value), mappings } });
    const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: r.filnavn });
    document.body.appendChild(a); a.click(); a.remove();
    const kilder = Object.entries(r.pr_kilde).map(([k, n]) => `${n} ${KILDE[k]}`).join(', ');
    $('#resultat').innerHTML = `<div class="ok"><strong>${esc(r.filnavn)}</strong> er hentet.<br>
      ${r.kunder} kunder (${kilder}) og ${r.produkter} produkter.
      ${r.nye.length ? `<br><br>Nye ID'er gemt:<br>${r.nye.map(x => `${x.type} ${x.id}: ${esc(x.navn)}${x.koblet ? ' (koblet til eksisterende)' : ''}`).join('<br>')}` : ''}
      <br><br><a href="#" id="igen">Hent filen igen</a></div>`;
    $('#igen').onclick = e => { e.preventDefault(); a.click(); };
    await runAnalyseQuiet();
  } catch (err) { $('#genErr').textContent = err.message; }
  btn.disabled = false;
};
// Opdater listen over nye navne efter de er gemt, uden at fjerne resultatet
async function runAnalyseQuiet() {
  const keep = $('#resultat').innerHTML;
  await runAnalyse();
  $('#resultat').innerHTML = keep;
}

// ---------- Register ----------
let regRows = [];
async function loadRegister() {
  try { regRows = await api('/api/register'); renderRegister(); } catch (e) {}
}
function renderRegister() {
  const q = $('#regSearch').value.trim().toLowerCase();
  for (const t of ['Kunde', 'Produkt']) {
    const byId = new Map();
    regRows.filter(r => r.type === t).forEach(r => { if (!byId.has(r.id)) byId.set(r.id, []); byId.get(r.id).push(r.navn); });
    const rows = [...byId].filter(([id, names]) => !q || String(id).includes(q) || names.some(n => n.toLowerCase().includes(q)));
    $('#reg' + t).innerHTML = '<tr><th>ID</th><th>Navn</th></tr>' + rows.map(([id, names]) =>
      `<tr><td class="id">${id}</td><td>${names.map((n, i) => `<div>${i ? '<span class="alias">også: </span>' : ''}${esc(n)}
        <button class="link small" data-type="${t}" data-navn="${esc(n)}">flyt</button></div>`).join('')}</td></tr>`).join('');
  }
  document.querySelectorAll('#register button[data-navn]').forEach(b => b.onclick = async () => {
    const id = prompt(`Hvilket eksisterende ${b.dataset.type.toLowerCase()}-ID skal "${b.dataset.navn}" pege på?\n\nBrug kun dette til at rette en fejlkobling. Piranya kender navnet under det ID, det har nu.`);
    if (!id) return;
    try { await api('/api/register/flyt', { body: { type: b.dataset.type, navn: b.dataset.navn, id: Number(id) } }); loadRegister(); }
    catch (e) { alert(e.message); }
  });
}
$('#regSearch').oninput = renderRegister;

// ---------- Indstillinger ----------
async function loadSettings() {
  try {
    const s = await api('/api/settings');
    for (const k of ['ogCaterId', 'ogCaterName', 'ffCaterName']) $('#' + k).value = s[k];
    const log = await api('/api/log');
    $('#logTable').innerHTML = '<tr><th>Kørt</th><th>Leveringsdato</th><th>Kilder</th><th>Kunder</th><th>Produkter</th><th>Nye ID\'er</th></tr>' +
      log.map(l => `<tr><td>${new Date(l.koert).toLocaleString('da-DK')}</td><td>${esc(l.dato)}</td><td>${esc(l.kilder)}</td><td>${l.kunder}</td><td>${l.produkter}</td><td>${l.nye_ider}</td></tr>`).join('');
  } catch (e) {}
}
$('#setForm').onsubmit = async e => {
  e.preventDefault();
  try {
    await api('/api/settings', { method: 'PUT', body: Object.fromEntries(['ogCaterId', 'ogCaterName', 'ffCaterName'].map(k => [k, $('#' + k).value])) });
    $('#setMsg').textContent = 'Gemt.';
  } catch (err) { $('#setMsg').textContent = err.message; }
};

// ---------- Start ----------
api('/api/me').then(r => r.loggedIn ? showView('samling') : showLogin()).catch(showLogin);
