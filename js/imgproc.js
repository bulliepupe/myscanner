// Foglio — elaborazione immagini (funzioni pure, nessuna dipendenza dal DOM)
// Le immagini sono oggetti {data: Uint8ClampedArray RGBA, width, height}.

export function makeImage(width, height) {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

export function toGray(img) {
  const { data, width, height } = img;
  const g = new Float32Array(width * height);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return g;
}

// Ridimensionamento a media d'area (per rilevamento e miniature)
export function downscaleGray(gray, w, h, maxSide) {
  const s = Math.min(1, maxSide / Math.max(w, h));
  const nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
  const out = new Float32Array(nw * nh);
  const cnt = new Float32Array(nw * nh);
  for (let y = 0; y < h; y++) {
    const ny = Math.min(nh - 1, Math.floor(y * s));
    for (let x = 0; x < w; x++) {
      const nx = Math.min(nw - 1, Math.floor(x * s));
      out[ny * nw + nx] += gray[y * w + x];
      cnt[ny * nw + nx]++;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= cnt[i] || 1;
  return { g: out, w: nw, h: nh, scale: s };
}

// Sfocatura a box separabile, raggio r
export function boxBlur(src, w, h, r) {
  if (r < 1) return Float32Array.from(src);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0; const row = y * w;
    for (let x = -r; x <= r; x++) acc += src[row + clampI(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / (2 * r + 1);
      acc += src[row + clampI(x + r + 1, 0, w - 1)] - src[row + clampI(x - r, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[clampI(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      acc += tmp[clampI(y + r + 1, 0, h - 1) * w + x] - tmp[clampI(y - r, 0, h - 1) * w + x];
    }
  }
  return out;
}

function clampI(v, a, b) { return v < a ? a : v > b ? b : v; }

export function otsu(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[clampI(gray[i] | 0, 0, 255)]++;
  const total = gray.length;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

// Componenti connesse di una maschera binaria: restituisce la più grande
function largestComponent(mask, w, h) {
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let bestId = 0, bestSize = 0, id = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || label[i]) continue;
    id++; let sp = 0, size = 0; stack[sp++] = i; label[i] = id;
    while (sp) {
      const p = stack[--sp]; size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = id; stack[sp++] = p + w; }
    }
    if (size > bestSize) { bestSize = size; bestId = id; }
  }
  return { label, id: bestId, size: bestSize };
}

function convexHull(pts) {
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

export function polyArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) { const p = q[i], n = q[(i + 1) % q.length]; a += p[0] * n[1] - n[0] * p[1]; }
  return Math.abs(a) / 2;
}

// Quadrilatero di area massima con vertici sull'inviluppo convesso
function maxAreaQuad(hull) {
  const n = hull.length;
  if (n < 4) return null;
  // riduzione dei punti per contenere i costi
  let H = hull;
  if (n > 60) { H = []; const step = n / 60; for (let i = 0; i < 60; i++) H.push(hull[Math.floor(i * step)]); }
  const m = H.length;
  const tri = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  let best = 0, bq = null;
  for (let i = 0; i < m; i++) for (let k = i + 2; k < m; k++) {
    let b1 = 0, j1 = -1;
    for (let j = i + 1; j < k; j++) { const t = tri(H[i], H[j], H[k]); if (t > b1) { b1 = t; j1 = j; } }
    let b2 = 0, l1 = -1;
    for (let l = k + 1; l < m + i; l++) { const t = tri(H[k], H[l % m], H[i]); if (t > b2) { b2 = t; l1 = l % m; } }
    if (j1 >= 0 && l1 >= 0 && b1 + b2 > best) { best = b1 + b2; bq = [H[i], H[j1], H[k], H[l1]]; }
  }
  return bq;
}

// Ordina i 4 angoli: alto-sx, alto-dx, basso-dx, basso-sx
export function orderCorners(q) {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  // dopo l'ordinamento per angolo (senso orario in coordinate schermo) troviamo l'alto-sx
  let start = 0, bestS = Infinity;
  sorted.forEach((p, i) => { const s = p[0] + p[1]; if (s < bestS) { bestS = s; start = i; } });
  return [0, 1, 2, 3].map(i => sorted[(start + i) % 4]);
}

export function defaultCorners(w, h, inset = 0.06) {
  const dx = w * inset, dy = h * inset;
  return [[dx, dy], [w - dx, dy], [w - dx, h - dy], [dx, h - dy]];
}

// Rilevamento del documento: restituisce 4 angoli in coordinate dell'immagine, o null
export function detectDocument(img, maxSide = 320) {
  const gray = toGray(img);
  const small = downscaleGray(gray, img.width, img.height, maxSide);
  const { w, h } = small;
  const g = boxBlur(small.g, w, h, 2);
  const thr = otsu(g);
  const total = w * h;
  let best = null;
  const masks = [];
  for (const bright of [true, false]) {
    const mask = new Uint8Array(total);
    for (let i = 0; i < total; i++) mask[i] = bright ? (g[i] > thr ? 1 : 0) : (g[i] <= thr ? 1 : 0);
    masks.push(mask);
  }
  masks.push(edgeEnclosedMask(g, w, h)); // regge meglio ombre e illuminazione non uniforme
  for (let mi = 0; mi < masks.length; mi++) {
    const mask = masks[mi];
    const comp = largestComponent(mask, w, h);
    const frac = comp.size / total;
    if (frac < 0.08 || frac > 0.985) continue;
    // punti di bordo della componente
    const pts = [];
    let touches = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x; if (comp.label[p] !== comp.id) continue;
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        comp.label[p - 1] !== comp.id || comp.label[p + 1] !== comp.id ||
        comp.label[p - w] !== comp.id || comp.label[p + w] !== comp.id;
      if (edge) { pts.push([x + 0.5, y + 0.5]); if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches++; }
    }
    const hull = convexHull(pts);
    const quad = maxAreaQuad(hull);
    if (!quad) continue;
    const qa = polyArea(quad);
    const hullA = polyArea(hull);
    // punteggio: area grande, forma ben approssimata da un quadrilatero, pochi pixel sul bordo immagine
    const fit = qa / (hullA || 1);
    const borderPenalty = touches / (2 * (w + h));
    const score = (qa / total) * fit * fit * (1 - Math.min(0.9, borderPenalty * 3));
    if (fit > 0.85 && qa / total > 0.1 && (!best || score > best.score)) best = { quad, score, grow: mi === 2 ? 3.2 : 0 };
  }
  if (!best) return null;
  if (best.grow) {
    // la maschera dei bordi resta un poco all'interno del foglio: allarghiamo
    const cx = best.quad.reduce((a, p) => a + p[0], 0) / 4, cy = best.quad.reduce((a, p) => a + p[1], 0) / 4;
    best.quad = best.quad.map(([x, y]) => { const d = Math.hypot(x - cx, y - cy) || 1; return [x + (x - cx) / d * best.grow, y + (y - cy) / d * best.grow]; });
  }
  const sx = img.width / w, sy = img.height / h;
  return orderCorners(best.quad.map(([x, y]) => [clamp(x * sx, 0, img.width), clamp(y * sy, 0, img.height)]));
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// Regioni racchiuse dai bordi: ciò che non si raggiunge dal margine dell'immagine senza attraversare un bordo
function edgeEnclosedMask(g, w, h) {
  const n = w * h, mag = new Float32Array(n);
  let sum = 0, sum2 = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1];
    const gy = g[i + w - 1] + 2 * g[i + w] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - w] - g[i - w + 1];
    const m = Math.hypot(gx, gy); mag[i] = m; sum += m; sum2 += m * m;
  }
  const mean = sum / n, sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  const thr = Math.max(14, mean + 1.2 * sd);
  const edge = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (mag[i] > thr) { edge[i] = 1; edge[i - 1] = 1; edge[i + 1] = 1; edge[i - w] = 1; edge[i + w] = 1; }
  }
  const outside = new Uint8Array(n), stack = new Int32Array(n); let sp = 0;
  const push = i => { if (!edge[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp) {
    const p = stack[--sp], x = p % w, y = (p / w) | 0;
    if (x > 0) push(p - 1); if (x < w - 1) push(p + 1); if (y > 0) push(p - w); if (y < h - 1) push(p + w);
  }
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = !outside[i] && !edge[i] ? 1 : 0;
  return mask;
}

// --- Omografia e raddrizzamento prospettico ---
function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    const d = A[c][c]; if (Math.abs(d) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

// Omografia che porta i punti src -> dst (4 coppie)
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return h ? [...h, 1] : null;
}

export function applyH(H, x, y) {
  const d = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function warpSize(corners, maxSide = 2400) {
  const [tl, tr, br, bl] = corners;
  let w = Math.max(dist(tl, tr), dist(bl, br));
  let h = Math.max(dist(tl, bl), dist(tr, br));
  const s = Math.min(1, maxSide / Math.max(w, h));
  return [Math.max(8, Math.round(w * s)), Math.max(8, Math.round(h * s))];
}

export function warpPerspective(img, corners, maxSide = 2400) {
  const [W, Hh] = warpSize(corners, maxSide);
  const dst = [[0, 0], [W, 0], [W, Hh], [0, Hh]];
  const H = homography(dst, corners); // da destinazione a sorgente
  const out = makeImage(W, Hh);
  const { data: s, width: sw, height: sh } = img, o = out.data;
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const [fx, fy] = applyH(H, x + 0.5, y + 0.5);
      let sx = fx - 0.5, sy = fy - 0.5;
      sx = clamp(sx, 0, sw - 1.001); sy = clamp(sy, 0, sh - 1.001);
      const x0 = sx | 0, y0 = sy | 0, ax = sx - x0, ay = sy - y0;
      const p00 = (y0 * sw + x0) * 4, p10 = p00 + 4, p01 = p00 + sw * 4, p11 = p01 + 4;
      const q = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        o[q + c] = (s[p00 + c] * (1 - ax) + s[p10 + c] * ax) * (1 - ay) + (s[p01 + c] * (1 - ax) + s[p11 + c] * ax) * ay;
      }
      o[q + 3] = 255;
    }
  }
  return out;
}

export function rotate90(img, times) {
  times = ((times % 4) + 4) % 4;
  if (!times) return img;
  const { width: w, height: h, data: s } = img;
  const out = times === 2 ? makeImage(w, h) : makeImage(h, w);
  const o = out.data, ow = out.width;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let nx, ny;
    if (times === 1) { nx = h - 1 - y; ny = x; }
    else if (times === 2) { nx = w - 1 - x; ny = h - 1 - y; }
    else { nx = y; ny = w - 1 - x; }
    const p = (y * w + x) * 4, q = (ny * ow + nx) * 4;
    o[q] = s[p]; o[q + 1] = s[p + 1]; o[q + 2] = s[p + 2]; o[q + 3] = 255;
  }
  return out;
}

// --- Filtri di miglioramento ---

// Stima dell'illuminazione di fondo (carta) tramite dilatazione + sfocatura su versione ridotta
function backgroundMap(gray, w, h) {
  const small = downscaleGray(gray, w, h, 120);
  const { w: sw, h: sh } = small;
  // dilatazione (massimo locale) per eliminare il testo scuro
  let cur = small.g;
  for (let it = 0; it < 3; it++) {
    const nxt = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const v = cur[clampI(y + dy, 0, sh - 1) * sw + clampI(x + dx, 0, sw - 1)]; if (v > m) m = v;
      }
      nxt[y * sw + x] = m;
    }
    cur = nxt;
  }
  cur = boxBlur(cur, sw, sh, 3);
  // ricampionamento bilineare alla dimensione piena
  const bg = new Float32Array(w * h);
  const fx = sw / w, fy = sh / h;
  for (let y = 0; y < h; y++) {
    const yy = clamp((y + 0.5) * fy - 0.5, 0, sh - 1.001), y0 = yy | 0, ay = yy - y0;
    for (let x = 0; x < w; x++) {
      const xx = clamp((x + 0.5) * fx - 0.5, 0, sw - 1.001), x0 = xx | 0, ax = xx - x0;
      const i = y0 * sw + x0;
      bg[y * w + x] = (cur[i] * (1 - ax) + cur[i + 1] * ax) * (1 - ay) + (cur[i + sw] * (1 - ax) + cur[i + sw + 1] * ax) * ay;
    }
  }
  return bg;
}

function percentiles(arr, lo, hi) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < arr.length; i++) hist[clampI(arr[i] | 0, 0, 255)]++;
  const n = arr.length; let acc = 0, a = 0, b = 255;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * lo) { a = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * (1 - hi)) { b = i; break; } }
  return [a, Math.max(a + 1, b)];
}

function autoLevels(img) {
  const { data } = img, n = data.length / 4;
  const out = makeImage(img.width, img.height), o = out.data;
  const lut = [];
  for (let c = 0; c < 3; c++) {
    const ch = new Uint8Array(n);
    for (let i = 0; i < n; i++) ch[i] = data[i * 4 + c];
    const [a, b] = percentiles(ch, 0.01, 0.99);
    const t = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) t[v] = (v - a) * 255 / (b - a);
    lut.push(t);
  }
  for (let p = 0; p < data.length; p += 4) {
    o[p] = lut[0][data[p]]; o[p + 1] = lut[1][data[p + 1]]; o[p + 2] = lut[2][data[p + 2]]; o[p + 3] = 255;
  }
  return out;
}

function saturate(img, k) {
  const d = img.data;
  for (let p = 0; p < d.length; p += 4) {
    const l = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    d[p] = l + (d[p] - l) * k; d[p + 1] = l + (d[p + 1] - l) * k; d[p + 2] = l + (d[p + 2] - l) * k;
  }
  return img;
}

// Divisione per lo sfondo: carta bianca uniforme, ombre attenuate
function flatten(img, keepColor) {
  const { width: w, height: h, data } = img;
  const gray = toGray(img);
  const bg = backgroundMap(gray, w, h);
  const out = makeImage(w, h), o = out.data;
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const k = 255 / Math.max(30, bg[i]);
    if (keepColor) {
      o[p] = data[p] * k; o[p + 1] = data[p + 1] * k; o[p + 2] = data[p + 2] * k;
    } else {
      const v = gray[i] * k; o[p] = o[p + 1] = o[p + 2] = v;
    }
    o[p + 3] = 255;
  }
  return out;
}

function curve(img, black, white, gamma = 1) {
  const t = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const x = clamp((v - black) / (white - black), 0, 1);
    t[v] = Math.pow(x, gamma) * 255;
  }
  const d = img.data;
  for (let p = 0; p < d.length; p += 4) { d[p] = t[d[p]]; d[p + 1] = t[d[p + 1]]; d[p + 2] = t[d[p + 2]]; }
  return img;
}

// Soglia adattiva (tipo Sauvola semplificato) su immagine già appiattita
function adaptiveThreshold(img, k, radiusFrac) {
  const { width: w, height: h } = img;
  const gray = toGray(img);
  const r = Math.max(6, Math.round(Math.max(w, h) * radiusFrac));
  const mean = boxBlur(gray, w, h, r);
  const out = makeImage(w, h), o = out.data;
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const v = gray[i] < mean[i] * (1 - k) ? 0 : 255;
    o[p] = o[p + 1] = o[p + 2] = v; o[p + 3] = 255;
  }
  return out;
}

export const FILTERS = [
  { id: 'original', label: 'Originale' },
  { id: 'auto', label: 'Migliora' },
  { id: 'magic', label: 'Colore vivo' },
  { id: 'document', label: 'Documento' },
  { id: 'gray', label: 'Grigi' },
  { id: 'bw', label: 'B/N' },
  { id: 'eco', label: 'Risparmio' },
  { id: 'nosh', label: 'Senza ombre' },
];

export function applyFilter(img, id) {
  switch (id) {
    case 'auto': return saturate(autoLevels(img), 1.15);
    case 'magic': return saturate(curve(flatten(img, true), 25, 235, 1.1), 1.35);
    case 'document': return curve(flatten(img, false), 60, 225, 1.25);
    case 'gray': {
      const g = toGray(img), out = makeImage(img.width, img.height), o = out.data;
      for (let i = 0, p = 0; i < g.length; i++, p += 4) { o[p] = o[p + 1] = o[p + 2] = g[i]; o[p + 3] = 255; }
      return autoLevels(out);
    }
    case 'bw': return adaptiveThreshold(flatten(img, false), 0.12, 0.02);
    case 'eco': {
      // B/N con tratti sottili e sfondo pulito: meno inchiostro in stampa
      return adaptiveThreshold(flatten(img, false), 0.22, 0.015);
    }
    case 'nosh': return curve(flatten(img, true), 5, 245, 1);
    default: return img;
  }
}

// Luminosità (-100..100), contrasto (-100..100), nitidezza (0..100)
export function adjust(img, { brightness = 0, contrast = 0, sharpness = 0 } = {}) {
  let out = img;
  if (brightness || contrast) {
    const c = (contrast + 100) / 100, b = brightness * 1.6;
    const t = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) t[v] = (v - 128) * c * c + 128 + b;
    const d = out.data;
    for (let p = 0; p < d.length; p += 4) { d[p] = t[d[p]]; d[p + 1] = t[d[p + 1]]; d[p + 2] = t[d[p + 2]]; }
  }
  if (sharpness > 0) {
    const { width: w, height: h, data: s } = out;
    const res = makeImage(w, h), o = res.data, k = sharpness / 50;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const up = (clampI(y - 1, 0, h - 1) * w + x) * 4, dn = (clampI(y + 1, 0, h - 1) * w + x) * 4;
      const lf = (y * w + clampI(x - 1, 0, w - 1)) * 4, rt = (y * w + clampI(x + 1, 0, w - 1)) * 4;
      for (let c = 0; c < 3; c++) o[p + c] = s[p + c] + k * (4 * s[p + c] - s[up + c] - s[dn + c] - s[lf + c] - s[rt + c]);
      o[p + 3] = 255;
    }
    out = res;
  }
  return out;
}
