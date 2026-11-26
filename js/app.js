// MyScanner — logica dell'app
import { db, uid } from './db.js';
import { FILTERS, applyFilter, adjust, defaultCorners, orderCorners, makeImage } from './imgproc.js';
import { detectQuad, intersect, lineThrough, bestLineNear } from './detect.js';
import { detectML, warmUp, mlAvailable } from './ml.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Impostazioni ----------
const settings = {
  defaultFilter: 'magic', quality: 'high', autoShot: false, ocrLang: 'ita', folders: [], signatures: [],
};
async function loadSettings() {
  for (const k of Object.keys(settings)) {
    const v = await db.getSetting(k).catch(() => undefined);
    if (v !== undefined) settings[k] = v;
  }
}
const saveSetting = (k, v) => { settings[k] = v; return db.setSetting(k, v); };
const maxSide = () => settings.quality === 'high' ? 2400 : 1700;

// ---------- Worker ----------
let worker = null, wseq = 0;
const wpending = new Map();
try {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = e => {
    const p = wpending.get(e.data.id); if (!p) return;
    wpending.delete(e.data.id);
    if (e.data.error) p.reject(new Error(e.data.error));
    else p.resolve(e.data.img ? { data: new Uint8ClampedArray(e.data.img.data.buffer), width: e.data.img.width, height: e.data.img.height } : e.data.result);
  };
  worker.onerror = () => { worker = null; };
} catch { worker = null; }

// richiesta al worker senza immagine (usa quelle già in memoria nel worker)
function workKey(op, opts = {}) {
  if (!worker) return Promise.reject(new Error('worker non disponibile'));
  const id = ++wseq;
  return new Promise((resolve, reject) => { wpending.set(id, { resolve, reject }); worker.postMessage({ id, op, opts }); });
}

async function work(op, img, opts = {}) {
  const copy = { data: img.data.slice(), width: img.width, height: img.height };
  if (worker) {
    const id = ++wseq;
    return new Promise((resolve, reject) => {
      wpending.set(id, { resolve, reject });
      worker.postMessage({ id, op, img: { data: copy.data.buffer, width: copy.width, height: copy.height }, opts }, [copy.data.buffer]);
    });
  }
  // ripiego senza worker
  const P = await import('./imgproc.js');
  if (op === 'detect') { const D = await import('./detect.js'); const r = D.detectQuad(copy); return r ? r.corners : null; }
  if (op === 'snap') { const D = await import('./detect.js'); return D.snapData(copy); }
  if (op === 'fuse') { const D = await import('./detect.js'); return D.fuse(copy, opts.ml || null); }
  if (op === 'rotate') return P.rotate90(copy, opts.times);
  let out = copy;
  if (op === 'warp' || op === 'process') out = P.rotate90(P.warpPerspective(copy, opts.corners, opts.maxSide), opts.rotation || 0);
  if (op === 'filter' || op === 'process') out = P.adjust(P.applyFilter(out, opts.filter), opts.adj);
  return out;
}

// ---------- Tempi (per capire dove l'app rallenta; visibili nelle Impostazioni) ----------
const timings = {};
let camInfo = '';
const tmark = () => performance.now();
const tset = (k, t0) => { timings[k] = Math.round(performance.now() - t0); };

// ---------- Utilità immagini ----------
async function blobToBitmap(blob) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { /* ripiego */ }
  }
  return new Promise((res, rej) => {
    const im = new Image(); const url = URL.createObjectURL(blob);
    im.onload = () => { URL.revokeObjectURL(url); res(im); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Immagine non leggibile')); };
    im.src = url;
  });
}
function srcSize(src) { return [src.naturalWidth || src.videoWidth || src.width, src.naturalHeight || src.videoHeight || src.height]; }

function drawToImage(src, limit) {
  const [w, h] = srcSize(src);
  const s = Math.min(1, limit / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { data: d.data, width: d.width, height: d.height };
}
async function decodeBlob(blob, limit) { const bm = await blobToBitmap(blob); const img = drawToImage(bm, limit); bm.close?.(); return img; }

function imageToCanvas(img) {
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}
const canvasToBlob = (c, type = 'image/jpeg', q = 0.9) => new Promise(r => c.toBlob(r, type, q));
const imageToBlob = (img, type, q) => canvasToBlob(imageToCanvas(img), type, q);

async function thumbFrom(canvasOrBitmap, size = 360) {
  const [w, h] = srcSize(canvasOrBitmap);
  const s = Math.min(1, size / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(canvasOrBitmap, 0, 0, c.width, c.height);
  return canvasToBlob(c, 'image/jpeg', 0.8);
}

// URL degli oggetti: un registro per poterli liberare
const urls = new Set();
function objURL(blob) { const u = URL.createObjectURL(blob); urls.add(u); return u; }
function freeURLs() { for (const u of urls) URL.revokeObjectURL(u); urls.clear(); }

// ---------- Icone ----------
const ICONS = {
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  gallery: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 9"/>',
  edit: '<path d="m15 5 4 4L8 20H4v-4L15 5Z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m21 16-5-5-9 9"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  first: '<path d="M6 5v14M18 6l-7 6 7 6"/>', prev: '<path d="m15 6-6 6 6 6"/>',
  next: '<path d="m9 6 6 6-6 6"/>', last: '<path d="M18 5v14M6 6l7 6-7 6"/>',
};
const ic = n => `<svg viewBox="0 0 24 24">${ICONS[n]}</svg>`;

// ---------- Interfaccia generica ----------
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function openSheet(html, onMount) {
  const s = $('#sheet'); s.innerHTML = html; s.classList.remove('hidden'); $('#sheet-back').classList.remove('hidden');
  onMount?.(s);
  return s;
}
function closeSheet() { $('#sheet').classList.add('hidden'); $('#sheet-back').classList.add('hidden'); $('#sheet').innerHTML = ''; }
$('#sheet-back').onclick = closeSheet;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function askText(title, value = '', placeholder = '') {
  return new Promise(resolve => {
    openSheet(`<h3>${esc(title)}</h3><input type="text" id="ask-in" value="${esc(value)}" placeholder="${esc(placeholder)}">
      <div class="row"><button class="btn" id="ask-no">Annulla</button><button class="btn primary" id="ask-ok">OK</button></div>`, s => {
      const inp = s.querySelector('#ask-in'); setTimeout(() => { inp.focus(); inp.select(); }, 50);
      s.querySelector('#ask-no').onclick = () => { closeSheet(); resolve(null); };
      s.querySelector('#ask-ok').onclick = () => { const v = inp.value.trim(); closeSheet(); resolve(v || null); };
      inp.onkeydown = e => { if (e.key === 'Enter') s.querySelector('#ask-ok').click(); };
    });
  });
}
function confirmSheet(title, text, okLabel = 'Conferma', danger = true) {
  return new Promise(resolve => {
    openSheet(`<h3>${esc(title)}</h3><p class="muted">${esc(text)}</p>
      <div class="row"><button class="btn" id="c-no">Annulla</button><button class="btn primary" id="c-ok" style="${danger ? 'background:#c62828;border-color:#c62828' : ''}">${esc(okLabel)}</button></div>`, s => {
      s.querySelector('#c-no').onclick = () => { closeSheet(); resolve(false); };
      s.querySelector('#c-ok').onclick = () => { closeSheet(); resolve(true); };
    });
  });
}
function progressSheet(title) {
  const s = openSheet(`<h3>${esc(title)}</h3><div class="progress"><i id="pg-bar"></i></div><p class="muted" id="pg-msg">Avvio…</p>`);
  $('#sheet-back').onclick = null;
  return {
    set(frac, msg) { const b = s.querySelector('#pg-bar'); if (b) b.style.width = Math.round(frac * 100) + '%'; if (msg) s.querySelector('#pg-msg').textContent = msg; },
    done() { $('#sheet-back').onclick = closeSheet; closeSheet(); },
  };
}

// ---------- App Android (Capacitor) ----------
const Cap = window.Capacitor;
const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const plug = n => Cap && Cap.Plugins && Cap.Plugins[n];
const blobToBase64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
async function nativeWrite(blob, filename, directory, sub) {
  const path = sub ? `${sub}/${filename}` : filename;
  const r = await plug('Filesystem').writeFile({ path, data: await blobToBase64(blob), directory, recursive: true });
  return r.uri;
}
async function nativeShare(files, title) {
  const uris = [];
  for (const f of files) uris.push(await nativeWrite(f.blob, f.name, 'CACHE', 'condivisi'));
  try { await plug('Share').share({ title, files: uris, dialogTitle: 'Condividi' }); }
  catch (e) { if (!/cancel/i.test(String(e && e.message))) throw e; }
}

async function shareOrDownload(blob, filename, mode) {
  if (isNative) {
    if (mode === 'download') {
      try { await nativeWrite(blob, filename, 'DOCUMENTS', 'MyScanner'); toast('Salvato in Documenti › MyScanner'); return; }
      catch { /* se non si può salvare, si apre la condivisione */ }
    }
    await nativeShare([{ blob, name: filename }], filename);
    return;
  }
  const file = new File([blob], filename, { type: blob.type });
  if (mode !== 'download' && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const safeName = n => (n || 'Documento').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
const relDate = t => {
  const d = new Date(t), now = new Date();
  const day = 864e5, diff = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / day);
  const hm = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  if (diff === 0) return 'Oggi, ' + hm;
  if (diff === 1) return 'Ieri, ' + hm;
  if (diff < 7) return d.toLocaleDateString('it-IT', { weekday: 'long' });
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: diff > 300 ? 'numeric' : undefined });
};
const fmtDate = t => new Date(t).toLocaleString('it-IT', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const defaultDocName = () => 'Scansione ' + new Date().toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');

// ---------- Navigazione (con tasto Indietro di Android) ----------
const screens = {};
let stack = ['home'];
let popCallback = null;
function show(id) {
  const prev = $('.screen.active');
  const prevId = prev?.id.slice(2);
  if (prevId && prevId !== id) screens[prevId]?.leave?.();
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === 's-' + id));
  screens[id]?.enter?.();
}
function go(id) { stack.push(id); history.pushState({ depth: stack.length - 1 }, ''); show(id); }
function back() { history.back(); }
function backTo(depth, then) {
  const steps = stack.length - 1 - depth;
  if (steps <= 0) { then?.(); return; }
  popCallback = then; history.go(-steps);
}
window.addEventListener('popstate', e => {
  if (!$('#sheet').classList.contains('hidden')) closeSheet();
  const depth = e.state?.depth ?? 0;
  stack.length = Math.max(1, depth + 1);
  const cb = popCallback; popCallback = null;
  show(stack[stack.length - 1]);
  cb?.();
});
history.replaceState({ depth: 0 }, '');

// ---------- Stato ----------
let currentDoc = null;      // documento aperto
let currentPageIdx = 0;     // pagina aperta
let session = null;         // scansione in corso: {items, idx, docId, editPageId, baseDepth}
let homeFolder = null;      // filtro cartella

function newItem(raw, w, h) {
  return { raw, w, h, rawRot: 0, corners: null, rotation: 0, filter: settings.defaultFilter, adj: { brightness: 0, contrast: 0, sharpness: 0 } };
}

// ==========================================================
// ARCHIVIO
// ==========================================================
screens.home = { enter: renderHome };
async function renderHome() {
  freeURLs();
  const q = $('#search').value.trim().toLowerCase();
  const docs = await db.listDocs();
  const folders = [...new Set([...settings.folders, ...docs.map(d => d.folder).filter(Boolean)])].sort();
  const chips = $('#folder-chips');
  chips.innerHTML = '';
  const mk = (label, val) => {
    const b = document.createElement('button'); b.className = 'chip' + (homeFolder === val ? ' on' : ''); b.textContent = label;
    b.onclick = () => { homeFolder = val; renderHome(); }; chips.appendChild(b);
  };
  mk('Tutti', null); folders.forEach(f => mk(f, f));
  const add = document.createElement('button'); add.className = 'chip add'; add.textContent = '+ Nuova cartella';
  add.onclick = async () => { const n = await askText('Nuova cartella', '', 'Es. Fatture, Contratti'); if (n) { await saveSetting('folders', [...new Set([...settings.folders, n])]); homeFolder = n; renderHome(); } };
  chips.appendChild(add);

  const list = $('#doc-list'); list.innerHTML = '';
  let shown = docs.filter(d => !homeFolder || d.folder === homeFolder);
  if (q) shown = shown.filter(d => d.name.toLowerCase().includes(q) || (d.text || '').toLowerCase().includes(q));
  $('#empty').classList.toggle('hidden', docs.length > 0);
  $('#doc-count').textContent = docs.length ? `${docs.length} ${docs.length === 1 ? 'documento' : 'documenti'}` : '';
  $('#list-label').classList.toggle('hidden', docs.length === 0);
  $('#list-label').textContent = q ? 'Risultati' : homeFolder ? homeFolder : 'Recenti';
  const hr = new Date().getHours();
  $('#greet').textContent = hr < 13 ? 'Buongiorno' : hr < 18 ? 'Buon pomeriggio' : 'Buonasera';
  list.classList.toggle('hidden', docs.length === 0);
  if (docs.length && !shown.length) list.innerHTML = '<p class="muted" style="text-align:center;padding:30px">Nessun risultato</p>';
  for (const d of shown) {
    const el = document.createElement('button'); el.className = 'doc-card';
    let snip = '';
    if (q && d.text && !d.name.toLowerCase().includes(q)) {
      const i = d.text.toLowerCase().indexOf(q);
      const a = Math.max(0, i - 18);
      snip = `<div class="snip">…${esc(d.text.slice(a, i))}<mark>${esc(d.text.slice(i, i + q.length))}</mark>${esc(d.text.slice(i + q.length, i + q.length + 24))}</div>`;
    }
    el.innerHTML = `<div class="paper"><img alt="">${d.pages.length > 1 ? `<span class="pages">${d.pages.length}</span>` : ''}</div>
      <div class="name">${esc(d.name)}</div>
      <div class="sub">${relDate(d.updated)}${d.folder ? ` · ${esc(d.folder)}` : ''}</div>${snip}`;
    el.onclick = () => openDoc(d.id);
    list.appendChild(el);
    if (d.pages[0]) db.getPage(d.pages[0]).then(p => { if (p?.thumb) el.querySelector('img').src = objURL(p.thumb); });
  }
}
let searchT; $('#search').oninput = () => { clearTimeout(searchT); searchT = setTimeout(renderHome, 200); };
$('#btn-scan').onclick = () => startScan(null);
$('#btn-import').onclick = () => { importTarget = null; $('#file-import').click(); };
$('#btn-settings').onclick = openSettings;

let importTarget = null; // docId a cui aggiungere, o null
$('#file-import').onchange = async e => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  const fromCamera = $('#s-camera').classList.contains('active');
  if (!fromCamera) beginSession(importTarget);
  const pr = progressSheet('Importazione');
  for (let i = 0; i < files.length; i++) {
    pr.set(i / files.length, `Immagine ${i + 1} di ${files.length}`);
    try { await addCapture(files[i]); } catch (err) { toast('Impossibile leggere ' + files[i].name); }
  }
  pr.done();
  if (session.items.length) { session.idx = 0; go('crop'); }
};

// ==========================================================
// FOTOCAMERA
// ==========================================================
let stream = null, liveTimer = null, camMode = 'single', torchOn = false, lastQuad = null, stableCount = 0, autoCooldown = 0;

function beginSession(docId, editPageId = null) {
  session = { items: [], idx: 0, docId, editPageId, baseDepth: stack.length - 1 };
}
function startScan(docId) { beginSession(docId); go('camera'); }

screens.camera = {
  enter() { updateQueueUI(); startCamera(); $('#cam-shutter').classList.toggle('auto', settings.autoShot); },
  leave: stopCamera,
};
async function startCamera() {
  $('#cam-hint').textContent = 'Inquadra il documento'; $('#cam-hint').classList.remove('ok');
  if (!navigator.mediaDevices?.getUserMedia) { cameraFallback('Fotocamera non disponibile in questo browser'); return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 }, aspectRatio: { ideal: 4 / 3 }, resizeMode: { ideal: 'none' } } });
    const v = $('#video'); v.srcObject = stream; await v.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.() || {};
    $('#cam-torch').classList.toggle('hidden', !caps.torch);
    if (caps.focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    // nessuno zoom: inquadratura più ampia possibile
    if (caps.zoom && caps.zoom.min != null) track.applyConstraints({ advanced: [{ zoom: Math.max(caps.zoom.min, 1) }] }).catch(() => {});
    liveTimer = setInterval(liveDetect, 300);
  } catch (err) {
    cameraFallback(err.name === 'NotAllowedError' ? 'Permesso fotocamera negato' : 'Fotocamera non disponibile');
  }
}
function cameraFallback(msg) {
  $('#cam-hint').textContent = msg + ' — uso la fotocamera del sistema';
  // ripiego: input file con acquisizione dalla fotocamera
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment';
  inp.onchange = async () => { if (inp.files[0]) { await addCapture(inp.files[0]); afterShot(); } };
  $('#cam-shutter').onclick = () => inp.click();
}
function stopCamera() {
  liveML = null;
  clearInterval(liveTimer); liveTimer = null;
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  torchOn = false; $('#cam-torch').classList.remove('on');
  const c = $('#cam-overlay'); c.getContext('2d').clearRect(0, 0, c.width, c.height);
  $('#cam-shutter').onclick = shoot;
}

const liveCanvas = document.createElement('canvas');
let liveML = null, liveMLk = 1, liveBusy = false, liveMLok = true;
// Rilevamento dal vivo: un solo calcolo alla volta, così il telefono non si satura.
// Se l'IA è disponibile si usa solo lei (su un fotogramma piccolo); altrimenti il metodo geometrico.
function liveDetect() {
  const v = $('#video'); if (!v.videoWidth || liveBusy) return;
  const s = 260 / Math.max(v.videoWidth, v.videoHeight);
  liveCanvas.width = Math.round(v.videoWidth * s); liveCanvas.height = Math.round(v.videoHeight * s);
  const ctx = liveCanvas.getContext('2d', { willReadFrequently: !liveMLok });
  ctx.drawImage(v, 0, 0, liveCanvas.width, liveCanvas.height);
  if (liveMLok) {
    liveBusy = true;
    detectML(liveCanvas).then(r => {
      if (!r) { if (!mlAvailable()) liveMLok = false; return; }
      liveML = r; liveMLk = 1; drawLive(v, s, r.corners && r.score > 0.6 ? r.corners : null);
    }).finally(() => { liveBusy = false; });
    return;
  }
  const id = ctx.getImageData(0, 0, liveCanvas.width, liveCanvas.height);
  const found = detectQuad({ data: id.data, width: id.width, height: id.height });
  drawLive(v, s, found && found.confidence > 0.55 ? found.corners : null);
}
function drawLive(v, s, quad) {
  if (!stream) return;
  const ov = $('#cam-overlay'), dpr = devicePixelRatio || 1;
  const W = ov.clientWidth, H = ov.clientHeight;
  if (ov.width !== W * dpr) { ov.width = W * dpr; ov.height = H * dpr; }
  const g = ov.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const hint = $('#cam-hint');
  if (!quad) { lastQuad = null; stableCount = 0; hint.textContent = 'Inquadra il documento'; hint.classList.remove('ok'); return; }
  // da coordinate ridotte a schermo
  // l'inquadratura è mostrata intera (object-fit: contain), uguale alla foto che verrà scattata
  const sc = Math.min(W / v.videoWidth, H / v.videoHeight);
  const ox = (W - v.videoWidth * sc) / 2, oy = (H - v.videoHeight * sc) / 2;
  const pts = quad.map(([x, y]) => [x / s * sc + ox, y / s * sc + oy]);
  g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(...p) : g.moveTo(...p)); g.closePath();
  g.fillStyle = 'rgba(212,245,60,.16)'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#d4f53c'; g.stroke();
  pts.forEach(p => { g.beginPath(); g.arc(p[0], p[1], 6, 0, 7); g.fillStyle = '#fff'; g.fill(); });
  // stabilità per lo scatto automatico
  const norm = quad.map(([x, y]) => [x / liveCanvas.width, y / liveCanvas.height]);
  if (lastQuad) {
    const move = norm.reduce((m, p, i) => m + Math.hypot(p[0] - lastQuad[i][0], p[1] - lastQuad[i][1]), 0) / 4;
    stableCount = move < 0.012 ? stableCount + 1 : 0;
  }
  lastQuad = norm;
  hint.classList.add('ok');
  if (settings.autoShot) {
    hint.textContent = stableCount >= 2 ? 'Tieni fermo…' : 'Documento trovato';
    if (stableCount >= 6 && Date.now() > autoCooldown) { autoCooldown = Date.now() + 2500; stableCount = 0; shoot(); }
  } else hint.textContent = 'Documento trovato';
}

let shooting = false;
async function shoot() {
  const v = $('#video'); if (!stream || !v.videoWidth || shooting) return;
  shooting = true;
  try { await shootInner(v); } finally { shooting = false; $('#cam-busy').classList.add('hidden'); }
}
async function shootInner(v) {
  // l'inquadratura si "congela" subito e compare l'avviso, così si capisce che lo scatto è partito
  clearInterval(liveTimer); liveTimer = null;
  const fr = $('#cam-freeze'); fr.width = v.videoWidth; fr.height = v.videoHeight; fr.getContext('2d').drawImage(v, 0, 0);
  $('#cam-busy').classList.remove('hidden');
  const t0 = tmark();
  const fx = $('#flash-fx'); fx.classList.add('go'); setTimeout(() => fx.classList.remove('go'), 60);
  navigator.vibrate?.(30);
  // la foto è il fotogramma dell'inquadratura: quello che vedi è esattamente quello che ottieni
  // (la foto "piena" del sensore su molti telefoni ha un campo diverso dall'anteprima)
  const kk = Math.min(1, maxSide() / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * kk); c.height = Math.round(v.videoHeight * kk);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  camInfo = `${v.videoWidth}×${v.videoHeight}`;
  tset('scatto', t0);
  await addCapture(c);
  afterShot();
  if (stream && !liveTimer) liveTimer = setInterval(liveDetect, 300); // modalità multipla: si continua a inquadrare
}
$('#cam-shutter').onclick = shoot;

function afterShot() {
  updateQueueUI();
  if (camMode === 'single') { session.idx = session.items.length - 1; go('crop'); }
}

// Trova la pagina: prima l'intelligenza artificiale (distingue il foglio dal tavolo),
// poi la geometria rifinisce i bordi al pixel
// img va passata già ridotta (circa 1000 px): il rilevamento non ha bisogno di più dettaglio
async function findPage(img, canvas) {
  let ml = null;
  try { ml = await detectML(canvas || imageToCanvas(img)); } catch { ml = null; }
  const mlCorners = ml && ml.corners && ml.score > 0.4 ? ml.corners : null;
  return work('fuse', img, { ml: mlCorners }).catch(() => mlCorners);
}
// versione ridotta di un'immagine (canvas + pixel) per rilevamento e bordi magnetici
function smallCopy(src, limit) {
  const [w, h] = srcSize(src); const k = Math.min(1, limit / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(src, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height);
  return { canvas: c, img: { data: d.data, width: d.width, height: d.height } };
}
// immagine ruotata di r quarti di giro in senso antiorario, ridotta entro "limit" pixel
function rotatedCanvas(src, r, limit = Infinity) {
  r = ((r % 4) + 4) % 4;
  const [w, h] = srcSize(src); const s = Math.min(1, limit / Math.max(w, h));
  const sw = Math.round(w * s), sh = Math.round(h * s);
  const c = document.createElement('canvas'); c.width = r % 2 ? sh : sw; c.height = r % 2 ? sw : sh;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.translate(c.width / 2, c.height / 2); g.rotate(-r * Math.PI / 2); g.drawImage(src, -sw / 2, -sh / 2, sw, sh);
  return c;
}
// foto originale di una scansione, già ruotata come nel ritaglio
async function decodeRaw(it, limit) {
  const bm = await blobToBitmap(it.raw);
  const c = rotatedCanvas(bm, it.rawRot || 0, limit); bm.close?.();
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  return { data: d.data, width: d.width, height: d.height, canvas: c };
}
async function detectOnItem(it) {
  const r = await decodeRaw(it, 1000);
  const sm = { canvas: r.canvas, img: { data: r.data, width: r.width, height: r.height } };
  const q = await findPage(sm.img, sm.canvas);
  const k = it.w / sm.img.width;
  return q ? q.map(([x, y]) => [x * k, y * k]) : null;
}
async function detectOnBlob(blob, fullW) {
  const bm = await blobToBitmap(blob);
  const sm = smallCopy(bm, 1000); bm.close?.();
  const q = await findPage(sm.img, sm.canvas);
  const k = fullW / sm.img.width;
  return q ? q.map(([x, y]) => [x * k, y * k]) : null;
}

async function addCapture(blob) {
  let t0 = tmark();
  const bm = blob instanceof Blob ? await blobToBitmap(blob) : blob; // foto da file, oppure fotogramma già pronto
  const [w0, h0] = srcSize(bm); const k = Math.min(1, maxSide() / Math.max(w0, h0));
  const full = document.createElement('canvas'); full.width = Math.round(w0 * k); full.height = Math.round(h0 * k);
  full.getContext('2d').drawImage(bm, 0, 0, full.width, full.height);
  const sm = smallCopy(full, 1000); if (bm.close) bm.close();
  tset('lettura foto', t0);
  // la compressione dell'originale e il rilevamento della pagina procedono insieme
  const rawP = canvasToBlob(full, 'image/jpeg', 0.92);
  t0 = tmark();
  const q = await findPage(sm.img, sm.canvas).catch(() => null);
  tset('rilevamento pagina', t0);
  const ks = full.width / sm.img.width;
  const det = q ? q.map(([x, y]) => [x * ks, y * ks]) : null;
  const it = newItem(await rawP, full.width, full.height);
  it.corners = det || defaultCorners(full.width, full.height, 0.03);
  it.autoCorners = det;
  session.items.push(it);
  return it;
}
function updateQueueUI() {
  const n = session?.items.length || 0;
  $('#cam-count').textContent = n;
  $('#cam-done').classList.toggle('show', n > 0 && camMode === 'batch');
  if (n) { const u = URL.createObjectURL(session.items[n - 1].raw); const im = $('#cam-thumb'); if (im.dataset.u) URL.revokeObjectURL(im.dataset.u); im.src = u; im.dataset.u = u; }
}
$('#cam-close').onclick = back;
$('#cam-done').onclick = () => { if (session.items.length) { session.idx = 0; go('crop'); } };
$('#cam-gallery').onclick = () => $('#file-import').click();
$$('#cam-mode button').forEach(b => b.onclick = () => {
  camMode = b.dataset.mode; $$('#cam-mode button').forEach(x => x.classList.toggle('on', x === b)); updateQueueUI();
  toast(camMode === 'batch' ? 'Modalità multipla: scatta tutte le pagine, poi tocca la miniatura' : 'Modalità singola');
});
$('#cam-torch').onclick = async () => {
  const track = stream?.getVideoTracks()[0]; if (!track) return;
  torchOn = !torchOn;
  try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); $('#cam-torch').classList.toggle('on', torchOn); }
  catch { torchOn = false; toast('Flash non supportato'); }
};

// ==========================================================
// RITAGLIO
// ==========================================================
let cropBitmap = null, cropView = null, cropDrag = null;
screens.crop = { enter: renderCrop, leave() { cropBitmap?.close?.(); cropBitmap = null; } };

async function renderCrop() {
  const it = session?.items[session.idx]; if (!it) return;
  $('#crop-title').textContent = session.items.length > 1 ? `Ritaglia ${session.idx + 1}/${session.items.length}` : 'Ritaglia';
  $('#crop-next').textContent = session.editPageId ? 'Fatto' : (session.idx < session.items.length - 1 ? 'Avanti' : 'Avanti');
  cropBitmap?.close?.();
  const bm = await blobToBitmap(it.raw);
  cropBitmap = it.rawRot ? rotatedCanvas(bm, it.rawRot) : bm;
  layoutCrop();
  if (!it.snap) {
    decodeRaw(it, 1400).then(img => work('snap', img).then(d => {
      const k = it.w / img.width;
      it.snap = { lines: d.lines.map(l => ({ ...l, rho: l.rho * k })), corners: d.corners.map(([x, y]) => [x * k, y * k]) };
    })).catch(() => { it.snap = { lines: [], corners: [] }; });
  }
}

// --- Bordi magnetici ---
function snapCorner(it, p) {
  const sd = it.snap; if (!sd) return { pt: p, snapped: false };
  const Rc = 24 / cropView.s, Rl = 14 / cropView.s;
  let best = null, bd = Rc;
  // gli angoli trovati dal rilevamento automatico hanno la precedenza (attrazione doppia)
  for (const c of it.autoCorners || []) { const d = Math.hypot(c[0] - p[0], c[1] - p[1]) * 0.5; if (d < bd) { bd = d; best = c; } }
  for (const c of sd.corners) { const d = Math.hypot(c[0] - p[0], c[1] - p[1]); if (d < bd) { bd = d; best = c; } }
  if (best) return { pt: best.slice(), snapped: 'corner' };
  let bl = null, ld = Rl;
  for (const l of sd.lines) { const d = Math.abs(p[0] * Math.cos(l.theta) + p[1] * Math.sin(l.theta) - l.rho); if (d < ld) { ld = d; bl = l; } }
  if (bl) {
    const d = p[0] * Math.cos(bl.theta) + p[1] * Math.sin(bl.theta) - bl.rho;
    return { pt: [p[0] - d * Math.cos(bl.theta), p[1] - d * Math.sin(bl.theta)], snapped: 'line' };
  }
  return { pt: p, snapped: false };
}
function snapEdge(it, i, a, b, orig) {
  const sd = it.snap; if (!sd) return null;
  const l = bestLineNear(sd.lines, a, b, 18 / cropView.s);
  if (!l) return null;
  const j = (i + 1) % 4;
  const prev = lineThrough(orig[(i + 3) % 4], orig[i]), next = lineThrough(orig[j], orig[(j + 1) % 4]);
  const pa = intersect(prev, l), pb = intersect(next, l);
  return pa && pb ? [pa, pb] : null;
}
let lastSnap = false;
function markSnap(kind, idxs) {
  $$('#crop-stage .handle').forEach((h, k) => h.classList.toggle('snapped', !!kind && idxs.includes(k)));
  if (kind && !lastSnap) navigator.vibrate?.(12);
  lastSnap = !!kind;
}
function layoutCrop() {
  const it = session.items[session.idx]; const st = $('#crop-stage');
  const W = st.clientWidth, H = st.clientHeight, pad = 26;
  const s = Math.min((W - pad * 2) / it.w, (H - pad * 2) / it.h);
  const dw = it.w * s, dh = it.h * s, ox = (W - dw) / 2, oy = (H - dh) / 2;
  cropView = { s, ox, oy };
  const c = $('#crop-canvas'), dpr = devicePixelRatio || 1;
  c.width = dw * dpr; c.height = dh * dpr; c.style.width = dw + 'px'; c.style.height = dh + 'px'; c.style.left = ox + 'px'; c.style.top = oy + 'px';
  c.getContext('2d').drawImage(cropBitmap, 0, 0, c.width, c.height);
  drawCropOverlay();
}
const toScreen = ([x, y]) => [x * cropView.s + cropView.ox, y * cropView.s + cropView.oy];
const toImage = ([x, y]) => [(x - cropView.ox) / cropView.s, (y - cropView.oy) / cropView.s];
function drawCropOverlay() {
  const it = session.items[session.idx]; const pts = it.corners.map(toScreen);
  const st = $('#crop-stage'); const W = st.clientWidth, H = st.clientHeight;
  const poly = pts.map(p => p.join(',')).join(' ');
  $('#crop-svg').setAttribute('viewBox', `0 0 ${W} ${H}`);
  $('#crop-svg').innerHTML = `<defs><mask id="m"><rect width="${W}" height="${H}" fill="#fff"/><polygon points="${poly}" fill="#000"/></mask></defs>
    <rect width="${W}" height="${H}" fill="rgba(0,0,0,.55)" mask="url(#m)"/>
    <polygon points="${poly}" fill="none" stroke="#e4572e" stroke-width="2.5"/>`;
  $$('#crop-stage .handle').forEach((h, i) => { h.style.left = pts[i][0] + 'px'; h.style.top = pts[i][1] + 'px'; });
  $$('#crop-stage .mid').forEach((m, i) => {
    const a = pts[i], b = pts[(i + 1) % 4];
    m.style.left = (a[0] + b[0]) / 2 + 'px'; m.style.top = (a[1] + b[1]) / 2 + 'px';
    m.classList.toggle('v', Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]));
  });
}
function clampPt(it, [x, y]) { return [Math.max(0, Math.min(it.w, x)), Math.max(0, Math.min(it.h, y))]; }
function showLoupe(pt) {
  const L = $('#loupe'), g = L.getContext('2d');
  const sp = toScreen(pt);
  L.style.display = 'block';
  L.style.left = Math.max(0, Math.min($('#crop-stage').clientWidth - 120, sp[0] - 60)) + 'px';
  L.style.top = (sp[1] - 150 < 0 ? sp[1] + 40 : sp[1] - 150) + 'px';
  const half = 60 / (cropView.s * 2.2); // ingrandimento 2,2x rispetto alla vista
  g.clearRect(0, 0, 120, 120);
  g.drawImage(cropBitmap, pt[0] - half, pt[1] - half, half * 2, half * 2, 0, 0, 120, 120);
  g.strokeStyle = '#e4572e'; g.lineWidth = 2; g.beginPath(); g.moveTo(60, 48); g.lineTo(60, 72); g.moveTo(48, 60); g.lineTo(72, 60); g.stroke();
}
$('#crop-stage').addEventListener('pointerdown', e => {
  const t = e.target; if (!t.classList.contains('handle') && !t.classList.contains('mid')) return;
  e.preventDefault(); t.setPointerCapture(e.pointerId);
  const it = session.items[session.idx];
  cropDrag = { type: t.classList.contains('handle') ? 'corner' : 'edge', i: +t.dataset.i, start: [e.clientX, e.clientY], orig: it.corners.map(p => p.slice()) };
});
$('#crop-stage').addEventListener('pointermove', e => {
  if (!cropDrag) return;
  const it = session.items[session.idx];
  const dx = (e.clientX - cropDrag.start[0]) / cropView.s, dy = (e.clientY - cropDrag.start[1]) / cropView.s;
  if (cropDrag.type === 'corner') {
    const raw = clampPt(it, [cropDrag.orig[cropDrag.i][0] + dx, cropDrag.orig[cropDrag.i][1] + dy]);
    const sn = snapCorner(it, raw);
    it.corners[cropDrag.i] = clampPt(it, sn.pt);
    markSnap(sn.snapped, [cropDrag.i]);
    showLoupe(it.corners[cropDrag.i]);
  } else {
    const i = cropDrag.i, j = (i + 1) % 4; const a = cropDrag.orig[i], b = cropDrag.orig[j];
    let nx = -(b[1] - a[1]), ny = b[0] - a[0]; const L = Math.hypot(nx, ny) || 1; nx /= L; ny /= L;
    const d = dx * nx + dy * ny;
    const na = [a[0] + nx * d, a[1] + ny * d], nb = [b[0] + nx * d, b[1] + ny * d];
    const sn = snapEdge(it, i, na, nb, cropDrag.orig);
    it.corners[i] = clampPt(it, sn ? sn[0] : na);
    it.corners[j] = clampPt(it, sn ? sn[1] : nb);
    markSnap(sn ? 'edge' : false, [i, j]);
  }
  drawCropOverlay();
});
const endCropDrag = () => { cropDrag = null; $('#loupe').style.display = 'none'; markSnap(false, []); };
$('#crop-stage').addEventListener('pointerup', endCropDrag);
$('#crop-stage').addEventListener('pointercancel', endCropDrag);
window.addEventListener('resize', () => { if ($('#s-crop').classList.contains('active') && cropBitmap) layoutCrop(); });

$('#crop-back').onclick = () => {
  // tornando alla fotocamera per rifare la foto, lo scatto scartato non deve restare in coda
  if (session && !session.editPageId && !session.fromFilter && camMode === 'single' && stack[stack.length - 2] === 'camera') {
    session.items.splice(session.idx, 1);
    session.idx = Math.max(0, session.items.length - 1);
  }
  session && (session.fromFilter = false);
  back();
};
$('#crop-auto').onclick = async () => {
  const it = session.items[session.idx];
  if (!it.autoCorners) { const q = await detectOnItem(it); if (q) it.autoCorners = q; }
  if (it.autoCorners) { it.corners = it.autoCorners.map(p => p.slice()); drawCropOverlay(); } else toast('Bordi non trovati: regolali a mano');
};
$('#crop-full').onclick = () => { const it = session.items[session.idx]; it.corners = [[0, 0], [it.w, 0], [it.w, it.h], [0, it.h]]; drawCropOverlay(); };
// Rotazione nel ritaglio: immediata. La foto originale non viene ricalcolata:
// si ruotano solo l'immagine a schermo e gli angoli, e la rotazione si applica al salvataggio.
function rotLine(l, W) {
  // (x, y) -> (y, W - x): la retta x·cosθ + y·sinθ = ρ diventa X·sinθ − Y·cosθ = ρ − W·cosθ
  let theta = l.theta - Math.PI / 2, rho = l.rho - W * Math.cos(l.theta);
  if (theta < 0) { theta += Math.PI; rho = -rho; }
  return { ...l, theta, rho };
}
$('#crop-rotl').onclick = () => {
  const it = session.items[session.idx]; if (!cropBitmap) return;
  const W = it.w, rot = ([x, y]) => [y, W - x];
  it.rawRot = ((it.rawRot || 0) + 1) % 4;
  it.corners = orderCorners(it.corners.map(rot));
  if (it.autoCorners) it.autoCorners = orderCorners(it.autoCorners.map(rot));
  if (it.snap) it.snap = { lines: it.snap.lines.map(l => rotLine(l, W)), corners: it.snap.corners.map(rot) };
  [it.w, it.h] = [it.h, it.w];
  it.preview = null;
  cropBitmap = rotatedCanvas(cropBitmap, 1);
  layoutCrop();
};
$('#crop-del').onclick = async () => {
  session.items.splice(session.idx, 1);
  if (!session.items.length) { backTo(session.baseDepth); return; }
  session.idx = Math.min(session.idx, session.items.length - 1); renderCrop();
};
$('#crop-next').onclick = () => {
  const it = session.items[session.idx]; it.preview = null;
  if (session.editPageId || session.fromFilter) { session.fromFilter = false; back(); return; }
  if (session.idx < session.items.length - 1) { session.idx++; renderCrop(); return; }
  session.idx = 0; go('filter');
};

// ==========================================================
// FILTRI E REGOLAZIONI
// ==========================================================
screens.filter = { enter: renderFilter };
let filterReq = 0;

async function getPreview(it) {
  // immagine raddrizzata a risoluzione ridotta, riutilizzata per le anteprime
  const key = JSON.stringify([it.corners, it.rotation]);
  if (it.preview && it.previewKey === key) return it.preview;
  const t0 = tmark();
  const raw = await decodeRaw(it, 1600);
  const k = raw.width / it.w;
  it.preview = await work('warp', raw, { corners: it.corners.map(([x, y]) => [x * k, y * k]), rotation: it.rotation, maxSide: 900 });
  if (it.fcache) Object.values(it.fcache).forEach(b => b.close && b.close());
  it.previewId = uid(); it.fcache = {};
  if (worker) await work('cacheImg', it.preview, { key: it.previewId }).catch(() => { it.previewId = null; });
  tset('anteprima', t0);
  it.previewKey = key; it.thumbs = null;
  return it.preview;
}
async function renderFilter() {
  const it = session.items[session.idx]; if (!it) return;
  $('#filter-title').textContent = session.editPageId ? 'Modifica pagina' : 'Migliora';
  $('#filter-pager').classList.toggle('hidden', session.items.length < 2);
  $('#fp-label').textContent = `${session.idx + 1}/${session.items.length}`;
  $('#adj-b').value = it.adj.brightness; $('#adj-c').value = it.adj.contrast; $('#adj-s').value = it.adj.sharpness;
  $('#filter-busy').classList.remove('hidden');
  const prev = await getPreview(it);
  renderStrip(it, prev);
  await updateFilterPreview();
}
function renderStrip(it, prev) {
  const strip = $('#filter-strip'); strip.innerHTML = '';
  // base piccola per le miniature
  const s = 130 / Math.max(prev.width, prev.height);
  const c0 = imageToCanvas(prev); const tc = document.createElement('canvas');
  tc.width = Math.round(prev.width * s); tc.height = Math.round(prev.height * s);
  tc.getContext('2d').drawImage(c0, 0, 0, tc.width, tc.height);
  const base = tc.getContext('2d').getImageData(0, 0, tc.width, tc.height);
  for (const f of FILTERS) {
    const el = document.createElement('button'); el.className = 'fthumb' + (it.filter === f.id ? ' on' : '');
    const cv = document.createElement('canvas'); cv.width = tc.width; cv.height = tc.height;
    const out = applyFilter({ data: new Uint8ClampedArray(base.data), width: base.width, height: base.height }, f.id);
    cv.getContext('2d').putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
    el.appendChild(cv); el.appendChild(document.createTextNode(f.label));
    el.onclick = () => { it.filter = f.id; $$('.fthumb').forEach(x => x.classList.toggle('on', x === el)); saveSetting('defaultFilter', f.id); updateFilterPreview(); };
    strip.appendChild(el);
  }
}
const fkey = it => `${it.filter}|${it.adj.brightness}|${it.adj.contrast}|${it.adj.sharpness}`;
async function filteredURL(it, filter, adj) {
  const key = `${filter}|${adj.brightness}|${adj.contrast}|${adj.sharpness}`;
  if (it.fcache && it.fcache[key]) return it.fcache[key];
  const t0 = tmark();
  let out;
  if (it.previewId) out = await workKey('filterKey', { key: it.previewId, filter, adj }).catch(() => null);
  if (!out) out = await work('filter', it.preview, { filter, adj });
  // niente compressione JPEG: l'immagine filtrata va dritta sullo schermo
  const bmp = await createImageBitmap(new ImageData(out.data, out.width, out.height));
  (it.fcache ||= {})[key] = bmp;
  tset('calcolo filtro', t0);
  return bmp;
}
function showFiltered(bmp) {
  const c = $('#filter-img');
  if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height; }
  c.getContext('2d').drawImage(bmp, 0, 0);
}
let userFilterReq = 0;
async function updateFilterPreview() {
  const it = session.items[session.idx]; const req = ++filterReq;
  const tTap = tmark();
  await getPreview(it);
  const key = fkey(it);
  const cached = it.fcache && it.fcache[key];
  if (!cached) $('#filter-busy').classList.remove('hidden');
  userFilterReq++;
  const bmp = cached || await filteredURL(it, it.filter, { ...it.adj });
  userFilterReq--;
  if (req !== filterReq) return;
  showFiltered(bmp);
  $('#filter-busy').classList.add('hidden');
  tset('cambio filtro (tocco → immagine)', tTap);
  setTimeout(() => prefetchFilters(it, req), 400);
}
// dopo aver mostrato il filtro scelto, prepara in sottofondo gli altri, uno alla volta,
// fermandosi appena tocchi qualcosa: la tua scelta ha sempre la precedenza
async function prefetchFilters(it, req) {
  const adj = { ...it.adj };
  for (const f of FILTERS) {
    if (req !== filterReq || userFilterReq > 0 || session?.items[session.idx] !== it) return;
    try { await filteredURL(it, f.id, adj); } catch { return; }
  }
}
let adjT;
['b', 'c', 's'].forEach(k => $('#adj-' + k).oninput = () => {
  const it = session.items[session.idx];
  it.adj = { brightness: +$('#adj-b').value, contrast: +$('#adj-c').value, sharpness: +$('#adj-s').value };
  clearTimeout(adjT); adjT = setTimeout(updateFilterPreview, 120);
});
$('#f-adj').onclick = () => { $('#sliders').classList.toggle('hidden'); $('#f-adj').classList.toggle('on'); };
// Rotazione nei filtri: l'immagine gira subito, il ricalcolo parte una volta sola dopo l'ultimo tocco
let fRotPending = 0, fRotTimer = null;
$('#f-rot').onclick = () => {
  fRotPending++;
  const im = $('#filter-img'); im.style.transition = 'transform .15s'; im.style.transform = `rotate(${90 * fRotPending}deg)`;
  clearTimeout(fRotTimer);
  fRotTimer = setTimeout(async () => {
    const it = session.items[session.idx];
    it.rotation = (it.rotation + fRotPending) % 4; fRotPending = 0;
    await renderFilter();
    im.style.transition = ''; im.style.transform = '';
  }, 450);
};
$('#f-all').onclick = () => {
  const it = session.items[session.idx];
  session.items.forEach(x => { x.filter = it.filter; x.adj = { ...it.adj }; });
  toast(`Filtro applicato a ${session.items.length} ${session.items.length === 1 ? 'pagina' : 'pagine'}`);
};
$('#f-recrop').onclick = () => { session.fromFilter = true; go('crop'); };
$('#fp-prev').onclick = () => { if (session.idx > 0) { session.idx--; renderFilter(); } };
$('#fp-next').onclick = () => { if (session.idx < session.items.length - 1) { session.idx++; renderFilter(); } };
$('#filter-back').onclick = back;
$('#filter-save').onclick = saveSession;

async function processItemFull(it) {
  const t0 = tmark();
  const raw = await decodeRaw(it, 99999);
  const out = await work('process', raw, { corners: it.corners, rotation: it.rotation, filter: it.filter, adj: it.adj, maxSide: maxSide() });
  const canvas = imageToCanvas(out);
  tset('elaborazione pagina', t0);
  return { canvas, w: out.width, h: out.height };
}

async function composeFinal(baseCanvas, annotBlob) {
  if (!annotBlob) return canvasToBlob(baseCanvas, 'image/jpeg', 0.9);
  const c = document.createElement('canvas'); c.width = baseCanvas.width; c.height = baseCanvas.height;
  const g = c.getContext('2d'); g.drawImage(baseCanvas, 0, 0);
  const a = await blobToBitmap(annotBlob); g.drawImage(a, 0, 0, c.width, c.height); a.close?.();
  return canvasToBlob(c, 'image/jpeg', 0.9);
}

async function saveSession() {
  const tSave = tmark();
  const n = session.items.length;
  const pr = progressSheet(n > 1 ? `Salvataggio di ${n} pagine` : 'Salvataggio');
  try {
    let doc;
    if (session.docId) doc = await db.getDoc(session.docId);
    if (!doc) doc = { id: uid(), name: defaultDocName(), folder: homeFolder || '', created: Date.now(), pages: [], text: '' };
    for (let i = 0; i < n; i++) {
      pr.set(i / n, `Pagina ${i + 1} di ${n}: raddrizzamento e filtro…`);
      const it = session.items[i];
      const { canvas, w, h } = await processItemFull(it);
      let page = session.editPageId ? await db.getPage(session.editPageId) : null;
      const base = await canvasToBlob(canvas, 'image/jpeg', 0.9);
      const annot = page?.annot || null;
      const final = annot ? await composeFinal(canvas, annot) : base;
      const thumb = await thumbFrom(annot ? await blobToBitmap(final) : canvas);
      const rec = {
        ...(page || { id: uid(), docId: doc.id, ocr: null }),
        raw: it.raw, rawRot: it.rawRot || 0, corners: it.corners, rotation: it.rotation, filter: it.filter, adj: it.adj, rw: it.w, rh: it.h,
        base, annot, final, thumb, w, h,
      };
      if (page && (page.w !== w || page.h !== h)) rec.ocr = null; // l'OCR non corrisponde più
      await db.putPage(rec);
      if (!page) doc.pages.push(rec.id);
      await sleep(0);
    }
    doc.text = await docText(doc);
    await db.putDoc(doc);
    db.persist();
    tset('salvataggio totale', tSave);
    pr.done();
    currentDoc = doc;
    const edit = !!session.editPageId; const base = session.baseDepth;
    session = null;
    backTo(base, () => { if (!edit && stack[stack.length - 1] !== 'doc') go('doc'); else screens[stack[stack.length - 1]]?.enter?.(); });
  } catch (err) {
    pr.done(); console.error(err); toast('Errore nel salvataggio: ' + err.message, 4000);
  }
}

async function docText(doc) {
  const pages = await db.getPages(doc);
  return pages.map(p => p.ocr?.text || '').join('\n').trim();
}

// ==========================================================
// DOCUMENTO
// ==========================================================
screens.doc = { enter: renderDoc };
async function openDoc(id) { currentDoc = await db.getDoc(id); go('doc'); }
async function renderDoc() {
  if (!currentDoc) return;
  currentDoc = await db.getDoc(currentDoc.id) || currentDoc;
  freeURLs();
  $('#doc-title').textContent = currentDoc.name;
  const pages = await db.getPages(currentDoc);
  const size = pages.reduce((s, p) => s + (p.final?.size || 0), 0);
  $('#doc-meta').textContent = `${pages.length} ${pages.length === 1 ? 'pagina' : 'pagine'} · ${(size / 1048576).toFixed(1)} MB${currentDoc.folder ? ' · ' + currentDoc.folder : ''}`;
  const grid = $('#page-grid'); grid.innerHTML = '';
  pages.forEach((p, i) => {
    const el = document.createElement('button'); el.className = 'pcard';
    el.innerHTML = `<img alt="Pagina ${i + 1}"><span class="num">${i + 1}</span>${p.ocr ? '<span class="ocr">OCR</span>' : ''}`;
    el.querySelector('img').src = objURL(p.thumb || p.final);
    el.onclick = () => { currentPageIdx = i; go('page'); };
    grid.appendChild(el);
  });
}
$('#doc-back').onclick = back;
$('#doc-title').onclick = renameDoc;
async function renameDoc() {
  const n = await askText('Rinomina documento', currentDoc.name);
  if (n) { currentDoc.name = n; await db.putDoc(currentDoc); renderDoc(); }
}
$('#act-add').onclick = () => openSheet(`<h3>Aggiungi pagine</h3><div class="menu">
  <button id="ad-cam">${ic('camera')}Scatta con la fotocamera</button><button id="ad-gal">${ic('gallery')}Importa dalla galleria</button></div>`, s => {
  s.querySelector('#ad-cam').onclick = () => { closeSheet(); startScan(currentDoc.id); };
  s.querySelector('#ad-gal').onclick = () => { closeSheet(); importTarget = currentDoc.id; $('#file-import').click(); };
});
$('#act-pdf').onclick = () => pdfSheet(currentDoc);
$('#act-ocr').onclick = () => ocrDoc(currentDoc);
$('#act-sign').onclick = async () => {
  const pages = currentDoc.pages;
  if (pages.length === 1) { currentPageIdx = 0; annotStartTool = 'sign'; go('annot'); return; }
  openSheet(`<h3>Su quale pagina vuoi firmare?</h3><div class="opts">${pages.map((_, i) => `<button data-i="${i}">Pagina ${i + 1}</button>`).join('')}</div>`, s => {
    s.querySelectorAll('button[data-i]').forEach(b => b.onclick = () => { closeSheet(); currentPageIdx = +b.dataset.i; annotStartTool = 'sign'; go('annot'); });
  });
};
$('#doc-more').onclick = () => openSheet(`<h3>${esc(currentDoc.name)}</h3><div class="menu">
  <button id="m-ren">${ic('edit')}Rinomina</button>
  <button id="m-fold">${ic('folder')}Sposta in cartella</button>
  <button id="m-jpg">${ic('image')}Esporta pagine come JPG</button>
  <button id="m-txt">${ic('text')}Esporta testo (.txt)</button>
  <button id="m-dup">${ic('copy')}Duplica documento</button>
  <button id="m-del" class="danger">${ic('trash')}Elimina documento</button></div>`, s => {
  s.querySelector('#m-ren').onclick = () => { closeSheet(); renameDoc(); };
  s.querySelector('#m-fold').onclick = () => { closeSheet(); chooseFolder(); };
  s.querySelector('#m-jpg').onclick = () => { closeSheet(); exportJPGs(currentDoc); };
  s.querySelector('#m-txt').onclick = async () => {
    closeSheet(); const t = await docText(currentDoc);
    if (!t) { toast('Nessun testo: usa prima "Testo" per il riconoscimento'); return; }
    shareOrDownload(new Blob([t], { type: 'text/plain' }), safeName(currentDoc.name) + '.txt');
  };
  s.querySelector('#m-dup').onclick = async () => { closeSheet(); await duplicateDoc(currentDoc); };
  s.querySelector('#m-del').onclick = async () => {
    closeSheet();
    if (await confirmSheet('Eliminare il documento?', `"${currentDoc.name}" e tutte le sue pagine verranno eliminati da questo telefono.`, 'Elimina')) {
      await db.deleteDoc(currentDoc); currentDoc = null; back(); toast('Documento eliminato');
    }
  };
});
async function chooseFolder() {
  const docs = await db.listDocs();
  const folders = [...new Set([...settings.folders, ...docs.map(d => d.folder).filter(Boolean)])].sort();
  openSheet(`<h3>Sposta in cartella</h3><div class="opts">
    <button data-f="" class="${!currentDoc.folder ? 'on' : ''}">Nessuna</button>
    ${folders.map(f => `<button data-f="${esc(f)}" class="${currentDoc.folder === f ? 'on' : ''}">${esc(f)}</button>`).join('')}
    <button id="f-new">+ Nuova</button></div>`, s => {
    s.querySelectorAll('button[data-f]').forEach(b => b.onclick = async () => { currentDoc.folder = b.dataset.f; await db.putDoc(currentDoc); closeSheet(); renderDoc(); });
    s.querySelector('#f-new').onclick = async () => {
      closeSheet(); const n = await askText('Nuova cartella');
      if (n) { await saveSetting('folders', [...new Set([...settings.folders, n])]); currentDoc.folder = n; await db.putDoc(currentDoc); renderDoc(); }
    };
  });
}
async function duplicateDoc(doc) {
  const pages = await db.getPages(doc);
  const nd = { ...doc, id: uid(), name: doc.name + ' (copia)', created: Date.now(), pages: [] };
  for (const p of pages) { const np = { ...p, id: uid(), docId: nd.id }; await db.putPage(np); nd.pages.push(np.id); }
  await db.putDoc(nd); toast('Copia creata');
}
async function exportJPGs(doc) {
  const pages = await db.getPages(doc);
  if (isNative) { await nativeShare(pages.map((p, i) => ({ blob: p.final, name: `${safeName(doc.name)}_${i + 1}.jpg` })), doc.name); return; }
  const files = pages.map((p, i) => new File([p.final], `${safeName(doc.name)}_${i + 1}.jpg`, { type: 'image/jpeg' }));
  if (navigator.canShare?.({ files })) { try { await navigator.share({ files, title: doc.name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  for (const f of files) { await shareOrDownload(f, f.name, 'download'); await sleep(300); }
}

// ==========================================================
// PAGINA
// ==========================================================
screens.page = { enter: renderPageView };
let pageZoom = 1;
async function currentPage() { return db.getPage(currentDoc.pages[currentPageIdx]); }
async function renderPageView() {
  if (!currentDoc) return;
  currentDoc = await db.getDoc(currentDoc.id);
  if (!currentDoc || !currentDoc.pages.length) { back(); return; }
  currentPageIdx = Math.min(currentPageIdx, currentDoc.pages.length - 1);
  const p = await currentPage();
  $('#page-title').textContent = `Pagina ${currentPageIdx + 1} di ${currentDoc.pages.length}`;
  const im = $('#page-img'); if (im.dataset.u) URL.revokeObjectURL(im.dataset.u);
  const u = URL.createObjectURL(p.final); im.src = u; im.dataset.u = u;
  pageZoom = 1; im.style.transform = '';
}
$('#page-img').ondblclick = () => { pageZoom = pageZoom > 1 ? 1 : 2.2; $('#page-img').style.transform = `scale(${pageZoom})`; };
// scorrimento tra pagine con uno swipe
let swipeX = null;
$('#page-view').addEventListener('touchstart', e => { swipeX = pageZoom === 1 && e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
$('#page-view').addEventListener('touchend', e => {
  if (swipeX == null) return; const dx = e.changedTouches[0].clientX - swipeX; swipeX = null;
  if (Math.abs(dx) < 60) return;
  const ni = currentPageIdx + (dx < 0 ? 1 : -1);
  if (ni >= 0 && ni < currentDoc.pages.length) { currentPageIdx = ni; renderPageView(); }
});
$('#page-back').onclick = back;
$('#page-share').onclick = async () => { const p = await currentPage(); shareOrDownload(p.final, `${safeName(currentDoc.name)}_${currentPageIdx + 1}.jpg`); };
$('#pg-edit').onclick = async () => {
  const p = await currentPage();
  beginSession(currentDoc.id, p.id);
  const it = newItem(p.raw, p.rw, p.rh);
  Object.assign(it, { rawRot: p.rawRot || 0, corners: p.corners.map(c => c.slice()), rotation: p.rotation, filter: p.filter, adj: { ...p.adj } });
  session.items.push(it);
  go('filter');
};
$('#pg-annot').onclick = () => { annotStartTool = 'pen'; go('annot'); };
$('#pg-ocr').onclick = async () => {
  const p = await currentPage();
  if (p.ocr) { showOcrText(p.ocr.text, p); return; }
  const pr = progressSheet('Riconoscimento del testo');
  try {
    await ocrPage(p, (f, m) => pr.set(f, m));
    currentDoc.text = await docText(currentDoc); await db.putDoc(currentDoc);
    pr.done(); showOcrText(p.ocr.text, p);
  } catch (err) { pr.done(); toast('OCR non riuscito: ' + err.message, 4000); }
};
$('#pg-left').onclick = () => openSheet(`<h3>Sposta pagina ${currentPageIdx + 1}</h3><div class="menu">
  <button data-m="first">${ic('first')}All'inizio</button><button data-m="prev">${ic('prev')}Indietro di una</button>
  <button data-m="next">${ic('next')}Avanti di una</button><button data-m="last">${ic('last')}Alla fine</button></div>`, s => {
  s.querySelectorAll('button[data-m]').forEach(b => b.onclick = async () => {
    closeSheet();
    const arr = currentDoc.pages, i = currentPageIdx, n = arr.length;
    const j = { first: 0, prev: Math.max(0, i - 1), next: Math.min(n - 1, i + 1), last: n - 1 }[b.dataset.m];
    const [id] = arr.splice(i, 1); arr.splice(j, 0, id); currentPageIdx = j;
    await db.putDoc(currentDoc); renderPageView(); toast(`Ora è la pagina ${j + 1}`);
  });
});
$('#pg-del').onclick = async () => {
  if (!await confirmSheet('Eliminare la pagina?', `La pagina ${currentPageIdx + 1} verrà eliminata.`, 'Elimina')) return;
  const id = currentDoc.pages.splice(currentPageIdx, 1)[0];
  await db.deletePage(id);
  if (!currentDoc.pages.length) { await db.deleteDoc(currentDoc); currentDoc = null; backTo(0); toast('Documento vuoto eliminato'); return; }
  currentDoc.text = await docText(currentDoc); await db.putDoc(currentDoc);
  renderPageView();
};

// ==========================================================
// OCR (Tesseract.js, caricato solo quando serve)
// ==========================================================
let tessWorker = null, tessLang = null, tessLogger = null;
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('serve la connessione la prima volta')); document.head.appendChild(s); });
}
async function getTesseract(onProgress) {
  tessLogger = onProgress;
  if (!window.Tesseract) { onProgress?.(0.02, 'Scarico il motore OCR…'); await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'); }
  if (!tessWorker || tessLang !== settings.ocrLang) {
    await tessWorker?.terminate();
    onProgress?.(0.05, 'Preparo la lingua…');
    tessWorker = await Tesseract.createWorker(settings.ocrLang, 1, {
      logger: m => {
        if (!tessLogger) return;
        const labels = { 'loading tesseract core': 'Carico il motore', 'loading language traineddata': 'Scarico la lingua', 'initializing api': 'Inizializzo', 'recognizing text': 'Leggo il testo' };
        tessLogger(m.progress || 0, (labels[m.status] || m.status) + '…');
      },
    });
    tessLang = settings.ocrLang;
  }
  return tessWorker;
}
async function ocrPage(p, onProgress) {
  const w = await getTesseract(onProgress);
  const { data } = await w.recognize(p.base);
  const words = (data.words || []).filter(x => x.text.trim() && x.confidence > 30)
    .map(x => ({ t: x.text, x0: x.bbox.x0, y0: x.bbox.y0, x1: x.bbox.x1, y1: x.bbox.y1 }));
  p.ocr = { text: (data.text || '').trim(), words, w: p.w, h: p.h, lang: settings.ocrLang };
  await db.putPage(p);
  return p.ocr;
}
async function ocrDoc(doc) {
  const pages = await db.getPages(doc);
  const todo = pages.filter(p => !p.ocr);
  if (todo.length) {
    const pr = progressSheet('Riconoscimento del testo');
    try {
      for (let i = 0; i < todo.length; i++) {
        await ocrPage(todo[i], (f, m) => pr.set((i + f) / todo.length, `Pagina ${i + 1} di ${todo.length} · ${m}`));
      }
      pr.done();
    } catch (err) { pr.done(); toast('OCR non riuscito: ' + err.message, 4000); return; }
  }
  doc.text = await docText(doc); await db.putDoc(doc);
  if (stack[stack.length - 1] === 'doc') renderDoc();
  showOcrText(doc.text || '(nessun testo riconosciuto)', null);
}
function showOcrText(text, page) {
  openSheet(`<h3>Testo riconosciuto</h3><textarea id="ocr-txt">${esc(text)}</textarea>
    <p class="muted">Puoi correggere il testo prima di copiarlo. Il PDF esportato diventa ricercabile.</p>
    <div class="row"><button class="btn" id="ocr-copy">Copia</button><button class="btn" id="ocr-share">Condividi</button>
    ${page ? '<button class="btn" id="ocr-redo">Rifai</button>' : ''}</div>`, s => {
    const ta = s.querySelector('#ocr-txt');
    const persist = async () => { if (page && ta.value !== page.ocr.text) { page.ocr.text = ta.value; await db.putPage(page); currentDoc.text = await docText(currentDoc); await db.putDoc(currentDoc); } };
    ta.onchange = persist;
    s.querySelector('#ocr-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(ta.value); toast('Testo copiato'); } catch { ta.select(); document.execCommand('copy'); toast('Testo copiato'); }
    };
    s.querySelector('#ocr-share').onclick = async () => {
      if (isNative) { try { await plug('Share').share({ text: ta.value, dialogTitle: 'Condividi il testo' }); } catch { /* annullato */ } }
      else if (navigator.share) { try { await navigator.share({ text: ta.value }); } catch { /* annullato */ } }
      else shareOrDownload(new Blob([ta.value], { type: 'text/plain' }), 'testo.txt');
    };
    const redo = s.querySelector('#ocr-redo');
    if (redo) redo.onclick = async () => { page.ocr = null; await db.putPage(page); closeSheet(); $('#pg-ocr').click(); };
  });
}

// ==========================================================
// PDF (jsPDF, incluso nell'app)
// ==========================================================
const PDF_OPTS = { size: 'fit', quality: 'high', ocr: true };
function pdfSheet(doc) {
  const o = PDF_OPTS;
  const opt = (k, v, l) => `<button data-k="${k}" data-v="${v}" class="${String(o[k]) === String(v) ? 'on' : ''}">${l}</button>`;
  openSheet(`<h3>Esporta PDF</h3>
    <div class="field"><span>Formato pagina</span><div class="opts">${opt('size', 'fit', 'Adatta')}${opt('size', 'a4', 'A4')}${opt('size', 'letter', 'Lettera')}</div></div>
    <div class="field"><span>Qualità e peso</span><div class="opts">${opt('quality', 'high', 'Alta')}${opt('quality', 'medium', 'Media')}${opt('quality', 'low', 'Leggera')}</div></div>
    <div class="field"><span>Testo ricercabile (dall'OCR, se fatto)</span><div class="opts">${opt('ocr', 'true', 'Sì')}${opt('ocr', 'false', 'No')}</div></div>
    <div class="row"><button class="btn" id="pdf-dl">Scarica</button><button class="btn primary" id="pdf-share">Condividi</button></div>`, s => {
    s.querySelectorAll('.opts button').forEach(b => b.onclick = () => {
      const k = b.dataset.k; o[k] = k === 'ocr' ? b.dataset.v === 'true' : b.dataset.v;
      s.querySelectorAll(`[data-k="${k}"]`).forEach(x => x.classList.toggle('on', x === b));
    });
    const run = async mode => {
      closeSheet(); const pr = progressSheet('Creazione del PDF');
      try { const blob = await buildPDF(doc, o, (f, m) => pr.set(f, m)); pr.done(); await shareOrDownload(blob, safeName(doc.name) + '.pdf', mode); }
      catch (err) { pr.done(); console.error(err); toast('Errore PDF: ' + err.message, 4000); }
    };
    s.querySelector('#pdf-dl').onclick = () => run('download');
    s.querySelector('#pdf-share').onclick = () => run('share');
  });
}
async function recompress(blob, limit, q) {
  const bm = await blobToBitmap(blob); const [w, h] = srcSize(bm);
  const s = Math.min(1, limit / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height); bm.close?.();
  return canvasToBlob(c, 'image/jpeg', q);
}
async function buildPDF(doc, o, onProgress) {
  const { jsPDF } = window.jspdf;
  const pages = await db.getPages(doc);
  const SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
  let pdf = null;
  for (let i = 0; i < pages.length; i++) {
    onProgress((i + 0.5) / pages.length, `Pagina ${i + 1} di ${pages.length}`);
    const p = pages[i];
    let blob = p.final;
    if (o.quality === 'medium') blob = await recompress(blob, 1700, 0.75);
    if (o.quality === 'low') blob = await recompress(blob, 1150, 0.6);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const landscape = p.w > p.h;
    let pw, ph;
    if (o.size === 'fit') { pw = 595.28; ph = pw * p.h / p.w; if (landscape) { ph = 595.28; pw = ph * p.w / p.h; } }
    else { [pw, ph] = SIZES[o.size]; if (landscape) [pw, ph] = [ph, pw]; }
    if (!pdf) pdf = new jsPDF({ unit: 'pt', format: [pw, ph], orientation: pw > ph ? 'l' : 'p', compress: true });
    else pdf.addPage([pw, ph], pw > ph ? 'l' : 'p');
    const s = Math.min(pw / p.w, ph / p.h);
    const iw = p.w * s, ih = p.h * s, ox = (pw - iw) / 2, oy = (ph - ih) / 2;
    pdf.addImage(bytes, 'JPEG', ox, oy, iw, ih, undefined, 'FAST');
    if (o.ocr && p.ocr?.words?.length) {
      const k = iw / p.ocr.w;
      for (const wd of p.ocr.words) {
        try {
          const hpt = Math.max(2, (wd.y1 - wd.y0) * k);
          pdf.setFontSize(hpt / 0.75 * 0.72);
          const target = (wd.x1 - wd.x0) * k;
          const natural = pdf.getTextWidth(wd.t) || 1;
          pdf.text(wd.t, ox + wd.x0 * k, oy + wd.y1 * k - hpt * 0.12, { renderingMode: 'invisible', horizontalScale: target / natural });
        } catch { /* carattere non supportato: si salta la parola */ }
      }
    }
    await sleep(0);
  }
  pdf.setProperties({ title: doc.name, creator: 'MyScanner' });
  return pdf.output('blob');
}

// ==========================================================
// ANNOTAZIONI E FIRMA
// ==========================================================
let annot = null, annotStartTool = 'pen';
const COLORS = ['#111111', '#1f4fd1', '#c62828', '#2e7d32', '#f9a825', '#ffffff'];
screens.annot = { enter: enterAnnot, leave() { annot?.baseBitmap?.close?.(); } };

async function enterAnnot() {
  const p = await currentPage();
  const baseBitmap = await blobToBitmap(p.base);
  annot = { page: p, baseBitmap, history: [], tool: 'pen', color: '#1f4fd1', width: 4, initial: p.annot ? await blobToBitmap(p.annot) : null };
  const im = $('#annot-base'); if (im.dataset.u) URL.revokeObjectURL(im.dataset.u);
  const u = URL.createObjectURL(p.base); im.src = u; im.dataset.u = u;
  const c = $('#annot-canvas'); c.width = p.w; c.height = p.h;
  $('#annot-items').innerHTML = '';
  layoutAnnot(); redrawAnnot(); renderAnnotColors();
  setAnnotTool(annotStartTool === 'sign' ? 'pen' : annotStartTool);
  if (annotStartTool === 'sign') signatureSheet();
}
function layoutAnnot() {
  const st = $('#annot-stage'); const p = annot.page;
  const s = Math.min((st.clientWidth - 24) / p.w, (st.clientHeight - 24) / p.h);
  annot.scale = s;
  const w = $('#annot-wrap'); w.style.width = p.w * s + 'px'; w.style.height = p.h * s + 'px';
}
function strokePath(g, st, k = 1) {
  g.save();
  g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = st.color; g.lineWidth = st.width * k;
  if (st.tool === 'hl') { g.globalAlpha = 0.38; g.globalCompositeOperation = 'source-over'; }
  const pts = st.points; g.beginPath();
  if (pts.length === 1) { g.arc(pts[0][0], pts[0][1], st.width / 2, 0, 7); g.fillStyle = st.color; g.fill(); g.restore(); return; }
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) { const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2; g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my); }
  g.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]); g.stroke(); g.restore();
}
function redrawAnnot(live) {
  const c = $('#annot-canvas'), g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  if (annot.initial) g.drawImage(annot.initial, 0, 0, c.width, c.height);
  for (const h of annot.history) if (h.type === 'stroke') strokePath(g, h);
  if (live) strokePath(g, live);
}
function renderAnnotColors() {
  const box = $('#annot-colors'); box.innerHTML = '';
  COLORS.forEach(col => {
    const b = document.createElement('button'); b.style.background = col; b.className = col === annot.color ? 'on' : '';
    b.style.outline = '1px solid #777';
    b.onclick = () => { annot.color = col; renderAnnotColors(); }; box.appendChild(b);
  });
  const r = document.createElement('input'); r.type = 'range'; r.min = 1; r.max = 24; r.value = annot.width;
  r.oninput = () => annot.width = +r.value; box.appendChild(r);
}
function setAnnotTool(t) {
  annot.tool = t;
  $$('#s-annot .toolbar button[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
}
$$('#s-annot .toolbar button[data-tool]').forEach(b => b.onclick = () => {
  if (b.dataset.tool === 'sign') { signatureSheet(); return; }
  setAnnotTool(b.dataset.tool);
  if (b.dataset.tool === 'hl' && annot.color === '#111111') { annot.color = '#f9a825'; annot.width = 18; renderAnnotColors(); }
  if (b.dataset.tool === 'text') toast('Tocca la pagina dove vuoi scrivere');
});
const annotPt = e => { const r = $('#annot-canvas').getBoundingClientRect(); return [(e.clientX - r.left) / annot.scale, (e.clientY - r.top) / annot.scale]; };
let liveStroke = null;
$('#annot-stage').addEventListener('pointerdown', async e => {
  if (!annot || e.target.closest('.aitem')) return;
  if (annot.tool === 'text') {
    const pt = annotPt(e);
    const txt = await askText('Testo da inserire', '', 'Es. Letto e approvato');
    if (txt) addAnnotItem({ kind: 'text', text: txt, color: annot.color, x: pt[0], y: pt[1] });
    return;
  }
  e.preventDefault(); $('#annot-stage').setPointerCapture(e.pointerId);
  const w = annot.tool === 'hl' ? Math.max(10, annot.width * 2) : annot.width;
  liveStroke = { type: 'stroke', tool: annot.tool, color: annot.color, width: w / annot.scale * 1.0, points: [annotPt(e)] };
  redrawAnnot(liveStroke);
});
$('#annot-stage').addEventListener('pointermove', e => {
  if (!liveStroke) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of evs) liveStroke.points.push(annotPt(ev));
  redrawAnnot(liveStroke);
});
const endStroke = () => { if (!liveStroke) return; annot.history.push(liveStroke); liveStroke = null; redrawAnnot(); };
$('#annot-stage').addEventListener('pointerup', endStroke);
$('#annot-stage').addEventListener('pointercancel', endStroke);
$('#an-undo').onclick = () => {
  const h = annot.history.pop(); if (!h) { toast('Niente da annullare'); return; }
  if (h.type === 'item') h.el.remove(); else redrawAnnot();
};

// Elementi mobili: testo e firme
function addAnnotItem(spec) {
  const el = document.createElement('div'); el.className = 'aitem';
  const s = annot.scale;
  let wPx, hPx;
  if (spec.kind === 'text') {
    const fs = Math.max(14, annot.page.w * 0.035) * s;
    el.innerHTML = `<div class="txt" style="color:${spec.color};font-size:${fs}px">${esc(spec.text)}</div>`;
    el.dataset.fs = fs;
  } else {
    const ratio = spec.h / spec.w;
    wPx = annot.page.w * 0.4 * s; hPx = wPx * ratio;
    el.innerHTML = `<img src="${spec.src}" alt="">`;
    el.style.width = wPx + 'px'; el.style.height = hPx + 'px';
  }
  el.insertAdjacentHTML('beforeend', '<span class="rs"></span><span class="x">×</span>');
  el.style.left = (spec.x * s - (wPx || 0) / 2) + 'px'; el.style.top = (spec.y * s - (hPx || 0) / 2) + 'px';
  el._spec = spec;
  $('#annot-items').appendChild(el);
  const entry = { type: 'item', el }; annot.history.push(entry);
  el.querySelector('.x').onpointerdown = ev => { ev.stopPropagation(); el.remove(); annot.history = annot.history.filter(h => h !== entry); };
  let drag = null;
  el.addEventListener('pointerdown', ev => {
    if (ev.target.classList.contains('x')) return;
    ev.preventDefault(); ev.stopPropagation(); el.setPointerCapture(ev.pointerId);
    drag = { resize: ev.target.classList.contains('rs'), sx: ev.clientX, sy: ev.clientY, l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, fs: +el.dataset.fs || 0 };
  });
  el.addEventListener('pointermove', ev => {
    if (!drag) return;
    const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
    if (drag.resize) {
      const k = Math.max(0.2, (drag.w + dx) / drag.w);
      if (spec.kind === 'text') { const fs = drag.fs * k; el.dataset.fs = fs; el.querySelector('.txt').style.fontSize = fs + 'px'; }
      else { el.style.width = drag.w * k + 'px'; el.style.height = drag.h * k + 'px'; }
    } else { el.style.left = drag.l + dx + 'px'; el.style.top = drag.t + dy + 'px'; }
  });
  el.addEventListener('pointerup', () => { drag = null; });
}

$('#an-cancel').onclick = back;
$('#an-save').onclick = async () => {
  const p = annot.page; const s = annot.scale;
  const c = document.createElement('canvas'); c.width = p.w; c.height = p.h;
  const g = c.getContext('2d');
  g.drawImage($('#annot-canvas'), 0, 0);
  const items = [...$('#annot-items').children];
  for (const el of items) {
    const spec = el._spec; const x = el.offsetLeft / s, y = el.offsetTop / s;
    if (spec.kind === 'text') {
      const fs = +el.dataset.fs / s;
      g.fillStyle = spec.color; g.font = `500 ${fs}px system-ui, sans-serif`; g.textBaseline = 'top';
      spec.text.split('\n').forEach((line, i) => g.fillText(line, x, y + i * fs * 1.15));
    } else {
      const im = el.querySelector('img'); g.drawImage(im, x, y, el.offsetWidth / s, el.offsetHeight / s);
    }
  }
  const empty = !annot.initial && !annot.history.length;
  p.annot = empty ? null : await canvasToBlob(c, 'image/png');
  const baseC = document.createElement('canvas'); baseC.width = p.w; baseC.height = p.h;
  baseC.getContext('2d').drawImage(annot.baseBitmap, 0, 0);
  p.final = await composeFinal(baseC, p.annot);
  p.thumb = await thumbFrom(await blobToBitmap(p.final));
  await db.putPage(p); await db.putDoc(currentDoc);
  toast('Modifiche applicate'); back();
};

function signatureSheet() {
  const sigs = settings.signatures || [];
  openSheet(`<h3>Firma</h3>
    ${sigs.length ? `<span class="muted">Firme salvate (tocca per usarla, tieni premuto per eliminarla)</span><div class="sig-list">${sigs.map((s, i) => `<button data-i="${i}"><img src="${s.src}" alt=""></button>`).join('')}</div>` : ''}
    <span class="muted">Disegna una nuova firma</span>
    <canvas class="sigpad" id="sigpad"></canvas>
    <div class="opts" style="margin-top:10px"><button data-c="#111111" class="on">Nero</button><button data-c="#1f4fd1">Blu</button><button id="sig-clear">Cancella</button></div>
    <div class="row"><button class="btn" id="sig-cancel">Annulla</button><button class="btn primary" id="sig-use">Usa e salva</button></div>`, s => {
    const pad = s.querySelector('#sigpad'); const r = pad.getBoundingClientRect(); const dpr = devicePixelRatio || 1;
    pad.width = r.width * dpr; pad.height = r.height * dpr;
    const g = pad.getContext('2d'); g.scale(dpr, dpr); g.lineCap = 'round'; g.lineJoin = 'round';
    let color = '#111111', drawing = false, last = null, inked = false;
    const P = e => { const b = pad.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top, e.pressure || 0.5]; };
    pad.onpointerdown = e => { pad.setPointerCapture(e.pointerId); drawing = true; last = P(e); };
    pad.onpointermove = e => {
      if (!drawing) return;
      for (const ev of (e.getCoalescedEvents ? e.getCoalescedEvents() : [e])) {
        const p = P(ev); g.strokeStyle = color; g.lineWidth = 1.6 + p[2] * 2.6;
        g.beginPath(); g.moveTo(last[0], last[1]); g.lineTo(p[0], p[1]); g.stroke(); last = p; inked = true;
      }
    };
    pad.onpointerup = () => { drawing = false; };
    s.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { color = b.dataset.c; s.querySelectorAll('[data-c]').forEach(x => x.classList.toggle('on', x === b)); });
    s.querySelector('#sig-clear').onclick = () => { g.clearRect(0, 0, pad.width, pad.height); inked = false; };
    s.querySelector('#sig-cancel').onclick = closeSheet;
    s.querySelectorAll('.sig-list button').forEach(b => {
      let lp;
      b.onpointerdown = () => { lp = setTimeout(async () => { lp = null; closeSheet(); if (await confirmSheet('Eliminare la firma salvata?', 'Verrà rimossa da questo telefono.', 'Elimina')) { const arr = settings.signatures.slice(); arr.splice(+b.dataset.i, 1); await saveSetting('signatures', arr); } }, 650); };
      b.onpointerup = () => { if (lp) { clearTimeout(lp); closeSheet(); placeSignature(sigs[+b.dataset.i]); } };
    });
    s.querySelector('#sig-use').onclick = async () => {
      if (!inked) { toast('Disegna prima la firma'); return; }
      const sig = trimCanvas(pad);
      closeSheet();
      await saveSetting('signatures', [sig, ...(settings.signatures || [])].slice(0, 6));
      placeSignature(sig);
    };
  });
}
function trimCanvas(c) {
  const g = c.getContext('2d'); const { width: w, height: h } = c; const d = g.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const pad = 6; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return { src: o.toDataURL('image/png'), w: o.width, h: o.height };
}
function placeSignature(sig) {
  const p = annot.page;
  addAnnotItem({ kind: 'sign', src: sig.src, w: sig.w, h: sig.h, x: p.w * 0.68, y: p.h * 0.86 });
  toast('Trascina la firma dove vuoi; usa il pallino per ridimensionarla');
}

// ==========================================================
// IMPOSTAZIONI
// ==========================================================
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
async function openSettings() {
  const est = await db.estimate();
  const used = est ? `${(est.usage / 1048576).toFixed(1)} MB usati` : '';
  const o = (k, v, l) => `<button data-k="${k}" data-v="${v}" class="${String(settings[k]) === String(v) ? 'on' : ''}">${l}</button>`;
  openSheet(`<h3>Impostazioni</h3>
    <div class="field"><span>Filtro predefinito</span><div class="opts">${FILTERS.map(f => o('defaultFilter', f.id, f.label)).join('')}</div></div>
    <div class="field"><span>Risoluzione scansioni</span><div class="opts">${o('quality', 'high', 'Alta (2400 px)')}${o('quality', 'medium', 'Media (1700 px)')}</div></div>
    <div class="field"><span>Scatto automatico quando il foglio è fermo</span><div class="opts">${o('autoShot', 'true', 'Attivo')}${o('autoShot', 'false', 'Spento')}</div></div>
    <div class="field"><span>Lingua OCR</span><div class="opts">${o('ocrLang', 'ita', 'Italiano')}${o('ocrLang', 'ita+eng', 'Italiano + Inglese')}${o('ocrLang', 'eng', 'Inglese')}</div></div>
    <div class="field"><span>Firme salvate: ${(settings.signatures || []).length}</span><div class="opts"><button id="st-sigdel">Elimina tutte le firme</button></div></div>
    ${installEvt && !isNative ? '<div class="row"><button class="btn primary" id="st-install">Installa MyScanner sulla schermata Home</button></div>' : ''}
    ${Object.keys(timings).length ? `<div class="field"><span>Tempi dell'ultima scansione</span><p class="muted" style="margin:0">${Object.entries(timings).map(([k, v]) => `${k}: ${(v / 1000).toFixed(1)} s`).join('<br>')}${camInfo ? `<br>risoluzione fotocamera: ${camInfo}` : ''}</p></div>` : ''}
    <p class="muted" style="margin-top:16px">Documenti, firme e testi restano solo su questo telefono (nessun server). ${used}<br>MyScanner 1.0 · Bulli e Pupe S.r.l. · <a href="https://bulliepupe.github.io/myscanner/privacy.html" target="_blank" rel="noopener">Informativa privacy</a></p>`, s => {
    s.querySelectorAll('.opts button[data-k]').forEach(b => b.onclick = async () => {
      const k = b.dataset.k; let v = b.dataset.v; if (k === 'autoShot') v = v === 'true';
      await saveSetting(k, v); s.querySelectorAll(`[data-k="${k}"]`).forEach(x => x.classList.toggle('on', x === b));
    });
    s.querySelector('#st-sigdel').onclick = async () => { await saveSetting('signatures', []); toast('Firme eliminate'); closeSheet(); };
    const inst = s.querySelector('#st-install');
    if (inst) inst.onclick = async () => { closeSheet(); installEvt.prompt(); await installEvt.userChoice; installEvt = null; };
  });
}

// ==========================================================
// AVVIO
// ==========================================================
(async () => {
  await loadSettings();
  renderHome();
  if ('serviceWorker' in navigator && !isNative) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (isNative && plug('App')) {
    // tasto Indietro di Android: chiude i fogli, torna alla schermata precedente, e dalla home esce
    plug('App').addListener('backButton', () => {
      if (!$('#sheet').classList.contains('hidden')) { closeSheet(); return; }
      if (stack.length > 1) history.back(); else plug('App').exitApp();
    });
  }
  // prepara il modello di intelligenza artificiale in background (la prima volta lo scarica, poi resta sul telefono)
  setTimeout(warmUp, 1500);
  // condivisione verso MyScanner da altre app (Web Share Target): immagini in coda
  const params = new URLSearchParams(location.search);
  if (params.get('azione') === 'scansiona') startScan(null);
})();

// utile per i test
window.__foglio = { makeImage, adjust };
