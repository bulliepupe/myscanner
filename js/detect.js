// MyScanner — rilevamento dei bordi del documento basato sulle linee rette
// 1) bordi con Sobel + soppressione dei non massimi
// 2) trasformata di Hough orientata (ogni pixel vota solo nella direzione del suo gradiente)
// 3) coppie di linee quasi parallele -> quadrilateri candidati
// 4) punteggio = quanta parte del perimetro coincide davvero con un bordo dell'immagine
import { toGray, downscaleGray, boxBlur, orderCorners, polyArea, detectDocument as detectByRegion } from './imgproc.js';

const DEG = Math.PI / 180;

export function analyze(img, maxSide = 480) {
  const gray = toGray(img);
  const sm = downscaleGray(gray, img.width, img.height, maxSide);
  const { w, h } = sm;
  const g = boxBlur(boxBlur(sm.g, w, h, 1), w, h, 1);
  const n = w * h;
  const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1], d = g[i - 1], f = g[i + 1], k = g[i + w - 1], l = g[i + w], m = g[i + w + 1];
    const X = c + 2 * f + m - a - 2 * d - k, Y = k + 2 * l + m - a - 2 * b - c;
    gx[i] = X; gy[i] = Y; mag[i] = Math.hypot(X, Y);
  }
  // soglia adattiva sul 95° percentile
  const sample = [];
  for (let i = 0; i < n; i += 7) sample.push(mag[i]);
  sample.sort((p, q) => p - q);
  const p95 = sample[Math.floor(sample.length * 0.95)] || 0;
  const thr = Math.max(10, p95 * 0.45);
  // soppressione dei non massimi
  const edge = new Uint8Array(n);
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x, M = mag[i];
    if (M < thr) continue;
    const ang = Math.atan2(gy[i], gx[i]);
    const dx = Math.round(Math.cos(ang)), dy = Math.round(Math.sin(ang));
    if (M >= mag[i + dy * w + dx] && M >= mag[i - dy * w - dx]) edge[i] = 1;
  }
  // bordi "spessi" per misurare la copertura del perimetro
  const near = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x; if (!edge[i]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) near[i + dy * w + dx] = 1;
  }
  const lines = houghLines(edge, gx, gy, w, h);
  return { w, h, s: sm.scale, sx: img.width / w, sy: img.height / h, gx, gy, mag, edge, near, lines, g };
}

function houghLines(edge, gx, gy, w, h) {
  const T = 180, D = Math.ceil(Math.hypot(w, h)), R = 2 * D + 1;
  const acc = new Float32Array(T * R);
  const cos = new Float32Array(T), sin = new Float32Array(T);
  for (let t = 0; t < T; t++) { cos[t] = Math.cos(t * DEG); sin[t] = Math.sin(t * DEG); }
  const SPAN = 6;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!edge[i]) continue;
    let phi = Math.atan2(gy[i], gx[i]) / DEG; // direzione del gradiente = normale della linea
    if (phi < 0) phi += 180; if (phi >= 180) phi -= 180;
    const c = Math.round(phi);
    for (let dt = -SPAN; dt <= SPAN; dt++) {
      let t = c + dt;
      if (t < 0) t += 180; else if (t >= 180) t -= 180;
      const r = Math.round(x * cos[t] + y * sin[t]) + D;
      acc[t * R + r] += 1 - Math.abs(dt) / (SPAN + 2);
    }
  }
  // picchi con soppressione dei vicini
  const minVotes = Math.min(w, h) * 0.12;
  const peaks = [];
  for (let t = 0; t < T; t++) for (let r = 1; r < R - 1; r++) {
    const v = acc[t * R + r]; if (v < minVotes) continue;
    let isMax = true;
    for (let dt = -4; dt <= 4 && isMax; dt++) {
      let tt = t + dt, rr0 = r;
      if (tt < 0) { tt += 180; rr0 = 2 * D - r; } else if (tt >= 180) { tt -= 180; rr0 = 2 * D - r; }
      for (let dr = -5; dr <= 5; dr++) {
        const rr = rr0 + dr; if (rr < 0 || rr >= R || (dt === 0 && dr === 0)) continue;
        const u = acc[tt * R + rr];
        if (u > v || (u === v && (tt * R + rr) < t * R + r)) { isMax = false; break; }
      }
    }
    if (isMax) peaks.push({ theta: t * DEG, rho: r - D, votes: v });
  }
  peaks.sort((a, b) => b.votes - a.votes);
  return peaks.slice(0, 28);
}

export function intersect(l1, l2) {
  const a = Math.cos(l1.theta), b = Math.sin(l1.theta), c = Math.cos(l2.theta), d = Math.sin(l2.theta);
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-6) return null;
  return [(l1.rho * d - b * l2.rho) / det, (a * l2.rho - l1.rho * c) / det];
}

function angleDiff(t1, t2) { // differenza tra direzioni di linea, 0..90°
  let d = Math.abs(t1 - t2) % Math.PI; if (d > Math.PI / 2) d = Math.PI - d; return d;
}

// Quanta parte del perimetro coincide con bordi reali orientati nel modo giusto (0..1 per lato)
export function sideSupport(A, P, Q) {
  const { w, h, near, gx, gy, mag } = A;
  const L = Math.hypot(Q[0] - P[0], Q[1] - P[1]); if (L < 4) return 0;
  const nx = -(Q[1] - P[1]) / L, ny = (Q[0] - P[0]) / L;
  const steps = Math.max(16, Math.round(L / 2));
  let hit = 0, out = 0;
  for (let k = 0; k <= steps; k++) {
    const t = 0.04 + 0.92 * k / steps; // gli estremi (angoli) contano poco
    const x = P[0] + (Q[0] - P[0]) * t, y = P[1] + (Q[1] - P[1]) * t;
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 2 || yi < 2 || xi >= w - 2 || yi >= h - 2) { out++; continue; }
    // cerca un bordo entro 2 px lungo la normale, con gradiente perpendicolare al lato
    let ok = false;
    for (let o = -2; o <= 2 && !ok; o++) {
      const px = Math.round(x + nx * o), py = Math.round(y + ny * o);
      const i = py * w + px;
      if (!near[i] || mag[i] < 1) continue;
      const c = Math.abs(gx[i] * nx + gy[i] * ny) / mag[i];
      if (c > 0.8) ok = true;
    }
    if (ok) hit++;
  }
  const inside = steps + 1 - out;
  // i tratti fuori dall'immagine (foglio che esce dall'inquadratura) valgono a metà
  return (hit + out * 0.7) / (steps + 1);
}

export function quadScore(A, q) {
  const sides = [0, 1, 2, 3].map(i => sideSupport(A, q[i], q[(i + 1) % 4]));
  const minSide = Math.min(...sides);
  if (minSide < 0.25) return { score: 0, sides };
  const cov = sides.reduce((s, v) => s + v, 0) / 4;
  // se i lati proseguono con un bordo forte oltre gli angoli, il quadrilatero è probabilmente
  // un rettangolo interno al foglio (intestazione, riquadro, tabella): lo penalizziamo
  let ext = 0;
  for (let i = 0; i < 4; i++) {
    const P = q[i], Q = q[(i + 1) % 4];
    const dx = (Q[0] - P[0]) * 0.18, dy = (Q[1] - P[1]) * 0.18;
    ext += extSupport(A, P, [P[0] - dx, P[1] - dy]) + extSupport(A, Q, [Q[0] + dx, Q[1] + dy]);
  }
  ext /= 8;
  const area = polyArea(q) / (A.w * A.h);
  // contrasto: il foglio di solito è più chiaro del fondo
  const contrast = interiorContrast(A, q);
  // ogni lato deve separare foglio e sfondo nello stesso verso (dentro più chiaro, o più scuro, per tutti)
  const sc = sideContrasts(A, q);
  const pos = sc.some(c => c > 8), neg = sc.some(c => c < -8);
  const consistency = pos && neg ? 0.45 : 1;
  const score = cov * cov * (0.6 + 0.4 * minSide) * Math.pow(area, 0.35) * (contrast > 0 ? 1 : 0.85) * (1 - 0.8 * ext) * consistency;
  return { score, sides, cov, area };
}

// supporto di un prolungamento: i punti fuori dall'immagine non contano
function extSupport(A, P, Q) {
  const { w, h } = A;
  const inside = ([x, y]) => x >= 3 && y >= 3 && x < w - 3 && y < h - 3;
  if (!inside(P) || !inside(Q)) {
    // accorcia il tratto alla parte interna
    let a = 0, b = 1, ok = false;
    for (let k = 1; k <= 10; k++) { const t = k / 10; if (inside([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t])) { b = t; ok = true; } else break; }
    if (!ok || b < 0.3) return 0;
    Q = [P[0] + (Q[0] - P[0]) * b, P[1] + (Q[1] - P[1]) * b]; void a;
    if (!inside(P)) return 0;
  }
  return sideSupportRaw(A, P, Q);
}
function sideSupportRaw(A, P, Q) {
  const { w, near, gx, gy, mag } = A;
  const L = Math.hypot(Q[0] - P[0], Q[1] - P[1]); if (L < 3) return 0;
  const nx = -(Q[1] - P[1]) / L, ny = (Q[0] - P[0]) / L;
  const steps = Math.max(6, Math.round(L / 2)); let hit = 0;
  for (let k = 1; k <= steps; k++) {
    const t = k / steps, x = P[0] + (Q[0] - P[0]) * t, y = P[1] + (Q[1] - P[1]) * t;
    for (let o = -2; o <= 2; o++) {
      const i = Math.round(y + ny * o) * w + Math.round(x + nx * o);
      if (near[i] && mag[i] > 1 && Math.abs(gx[i] * nx + gy[i] * ny) / mag[i] > 0.8) { hit++; break; }
    }
  }
  return hit / steps;
}

function sideContrasts(A, q) {
  const { w, h, g } = A;
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  return [0, 1, 2, 3].map(i => {
    const P = q[i], Q = q[(i + 1) % 4];
    const L = Math.hypot(Q[0] - P[0], Q[1] - P[1]) || 1;
    let nx = -(Q[1] - P[1]) / L, ny = (Q[0] - P[0]) / L;
    const mx = (P[0] + Q[0]) / 2, my = (P[1] + Q[1]) / 2;
    if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; } // normale verso l'interno
    let si = 0, so = 0, n = 0;
    for (let k = 1; k < 16; k++) {
      const t = 0.1 + 0.8 * k / 16, x = P[0] + (Q[0] - P[0]) * t, y = P[1] + (Q[1] - P[1]) * t;
      const xi = Math.round(x + nx * 5), yi = Math.round(y + ny * 5), xo = Math.round(x - nx * 5), yo = Math.round(y - ny * 5);
      if (xi < 0 || yi < 0 || xi >= w || yi >= h || xo < 0 || yo < 0 || xo >= w || yo >= h) continue;
      si += g[yi * w + xi]; so += g[yo * w + xo]; n++;
    }
    return n >= 5 ? (si - so) / n : 0;
  });
}

function interiorContrast(A, q) {
  const { w, h, g } = A;
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  let inS = 0, inN = 0, outS = 0, outN = 0;
  for (let i = 0; i < 4; i++) {
    const P = q[i], Q = q[(i + 1) % 4];
    for (let k = 1; k < 10; k++) {
      const t = k / 10, x = P[0] + (Q[0] - P[0]) * t, y = P[1] + (Q[1] - P[1]) * t;
      const dx = cx - x, dy = cy - y, d = Math.hypot(dx, dy) || 1;
      const xi = Math.round(x + dx / d * 5), yi = Math.round(y + dy / d * 5);
      const xo = Math.round(x - dx / d * 5), yo = Math.round(y - dy / d * 5);
      if (xi >= 0 && yi >= 0 && xi < w && yi < h) { inS += g[yi * w + xi]; inN++; }
      if (xo >= 0 && yo >= 0 && xo < w && yo < h) { outS += g[yo * w + xo]; outN++; }
    }
  }
  if (!inN || !outN) return 1;
  return inS / inN - outS / outN;
}

function convexOK(q, w, h) {
  const m = 0.1;
  for (const [x, y] of q) if (x < -w * m || y < -h * m || x > w * (1 + m) || y > h * (1 + m)) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-6) return false;
    const s = Math.sign(cr); if (!sign) sign = s; else if (s !== sign) return false;
    // angoli interni tra 35° e 145°
    const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2));
    if (Math.abs(cos) > 0.82) return false;
  }
  return true;
}

// Restituisce {corners, confidence} in coordinate dell'immagine originale, oppure null
export function detectQuad(img) {
  const A = analyze(img);
  const { w, h } = A;
  // i margini dell'immagine valgono come linee: servono quando il foglio esce dall'inquadratura
  const lines = [...A.lines, { theta: 0, rho: 0.5, votes: 0 }, { theta: 0, rho: w - 1.5, votes: 0 },
    { theta: Math.PI / 2, rho: 0.5, votes: 0 }, { theta: Math.PI / 2, rho: h - 1.5, votes: 0 }];
  const minDim = Math.min(w, h);
  const pairs = [];
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const a = lines[i], b = lines[j];
    if (angleDiff(a.theta, b.theta) > 28 * DEG) continue;
    // distanza tra le due linee (al centro dell'immagine)
    const ca = Math.cos(a.theta) * w / 2 + Math.sin(a.theta) * h / 2 - a.rho;
    const sameDir = Math.cos(a.theta - b.theta) > 0;
    const cb = (Math.cos(b.theta) * w / 2 + Math.sin(b.theta) * h / 2 - b.rho) * (sameDir ? 1 : -1);
    if (Math.abs(ca - cb) < minDim * 0.2) continue;
    pairs.push([a, b]);
  }
  let best = null;
  for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) {
    const [a1, a2] = pairs[i], [b1, b2] = pairs[j];
    if (angleDiff(a1.theta, b1.theta) < 40 * DEG) continue;
    const pts = [intersect(a1, b1), intersect(a1, b2), intersect(a2, b2), intersect(a2, b1)];
    if (pts.some(p => !p)) continue;
    if (!convexOK(pts, w, h)) continue;
    if (polyArea(pts) < w * h * 0.12) continue;
    const s = quadScore(A, pts);
    if (s.score > 0 && (!best || s.score > best.score)) best = { ...s, q: pts };
  }
  // candidato alternativo: segmentazione per regioni, rifinito sulle linee
  try {
    const r = detectByRegion(img);
    if (r) {
      let q = r.map(([x, y]) => [x / A.sx, y / A.sy]);
      q = refineOnLines(A, q);
      const s = quadScore(A, q);
      if (s.score > 0 && (!best || s.score > best.score * 1.05)) best = { ...s, q };
    }
  } catch { /* ignora */ }
  if (!best) return null;
  const corners = orderCorners(best.q.map(([x, y]) => [
    Math.max(0, Math.min(img.width, x * A.sx)), Math.max(0, Math.min(img.height, y * A.sy)),
  ]));
  return { corners, confidence: Math.min(1, best.cov || 0) };
}

// Sposta ogni lato sulla linea rilevata più vicina e simile, se c'è
function refineOnLines(A, q) {
  const sideLines = [];
  for (let i = 0; i < 4; i++) {
    const P = q[i], Q = q[(i + 1) % 4];
    sideLines.push(bestLineNear(A.lines, P, Q, Math.min(A.w, A.h) * 0.05) || lineThrough(P, Q));
  }
  const out = [];
  for (let i = 0; i < 4; i++) out.push(intersect(sideLines[(i + 3) % 4], sideLines[i]) || q[i]);
  return convexOK(out, A.w, A.h) ? out : q;
}

export function lineThrough(P, Q) {
  const dx = Q[0] - P[0], dy = Q[1] - P[1];
  let theta = Math.atan2(dx, -dy); // normale
  if (theta < 0) theta += Math.PI; if (theta >= Math.PI) theta -= Math.PI;
  return { theta, rho: P[0] * Math.cos(theta) + P[1] * Math.sin(theta) };
}

function distToLine(l, [x, y]) { return Math.abs(x * Math.cos(l.theta) + y * Math.sin(l.theta) - l.rho); }

export function bestLineNear(lines, P, Q, maxDist, maxAngle = 10 * DEG) {
  const ref = lineThrough(P, Q);
  const M = [(P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2];
  let best = null, bd = Infinity;
  for (const l of lines) {
    if (angleDiff(l.theta, ref.theta) > maxAngle) continue;
    const d = Math.max(distToLine(l, P), distToLine(l, Q)) * 0.5 + distToLine(l, M) * 0.5;
    if (d < maxDist && d < bd) { bd = d; best = l; }
  }
  return best;
}

// Dati per i bordi magnetici, in coordinate dell'immagine originale (piccoli, adatti a postMessage)
export function snapData(img) {
  const A = analyze(img, 640);
  const k = (A.sx + A.sy) / 2;
  const lines = A.lines.map(l => ({ theta: l.theta, rho: l.rho * k, votes: l.votes }));
  const corners = [];
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    if (angleDiff(lines[i].theta, lines[j].theta) < 30 * DEG) continue;
    const p = intersect(lines[i], lines[j]);
    if (p && p[0] > -img.width * 0.02 && p[1] > -img.height * 0.02 && p[0] < img.width * 1.02 && p[1] < img.height * 1.02) {
      // tieni solo gli incroci dove almeno una delle due linee ha davvero dei bordi vicino
      corners.push([Math.max(0, Math.min(img.width, p[0])), Math.max(0, Math.min(img.height, p[1]))]);
    }
  }
  return { lines, corners };
}
