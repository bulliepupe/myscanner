// MyScanner — rilevamento della pagina con intelligenza artificiale
// Modello DocCornerNet (rete neurale addestrata sugli angoli dei documenti) tramite la libreria scanic (MIT).
// Gira interamente sul telefono: modello e motore sono inclusi nell'app (circa 3,5 MB, scaricati una volta sola).
let mod = null, failed = false;
const ASSETS = new URL('../vendor/scanic-ml/', import.meta.url).href;

async function load() {
  if (!mod) mod = import('../vendor/scanic/scanic.js');
  return mod;
}

// Precarica in background, così il primo scatto è già veloce
export function warmUp() {
  if (failed) return;
  load().then(m => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    return m.scanDocument(c, { detector: 'ml', mode: 'detect', ml: { assetBaseUrl: ASSETS } });
  }).catch(() => { failed = true; });
}

// source: canvas, immagine, ImageBitmap o video. Restituisce {corners, score} in pixel della sorgente, o null.
export async function detectML(source) {
  if (failed) return null;
  try {
    const { scanDocument } = await load();
    const r = await scanDocument(source, { detector: 'ml', mode: 'detect', ml: { assetBaseUrl: ASSETS } });
    if (!r || !r.success || !r.corners) return { corners: null, score: r?.score ?? 0 };
    const c = r.corners;
    return {
      corners: [[c.topLeft.x, c.topLeft.y], [c.topRight.x, c.topRight.y], [c.bottomRight.x, c.bottomRight.y], [c.bottomLeft.x, c.bottomLeft.y]],
      score: r.score ?? r.confidence ?? 1,
    };
  } catch (err) {
    console.warn('Rilevamento IA non disponibile, uso quello classico', err);
    failed = true;
    return null;
  }
}

export const mlAvailable = () => !failed;
