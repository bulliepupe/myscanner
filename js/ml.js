// MyScanner — rilevamento della pagina con intelligenza artificiale
// Modello DocCornerNet (rete neurale addestrata sugli angoli dei documenti) tramite la libreria scanic (MIT).
// Gira interamente sul telefono: modello e motore sono inclusi nell'app.
let mod = null, loadFailed = false;
const ASSETS = new URL('../vendor/scanic-ml/', import.meta.url).href;

async function load() {
  if (!mod) mod = import('../vendor/scanic/scanic.js');
  return mod;
}

// Il modello può eseguire un solo calcolo alla volta: le richieste si mettono in fila.
// (Due calcoli sovrapposti, per esempio inquadratura dal vivo + scatto, davano risultati sbagliati.)
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export function warmUp() {
  if (loadFailed) return;
  serial(async () => {
    const m = await load();
    const c = document.createElement('canvas'); c.width = c.height = 64;
    await m.scanDocument(c, { detector: 'ml', mode: 'detect', ml: { assetBaseUrl: ASSETS } });
  }).catch(() => { loadFailed = true; });
}

// source: canvas, immagine o ImageBitmap. Restituisce {corners, score} in pixel della sorgente, o null.
export function detectML(source) {
  if (loadFailed) return Promise.resolve(null);
  return serial(async () => {
    let m;
    try { m = await load(); } catch (err) { loadFailed = true; console.warn('Modello IA non caricato', err); return null; }
    try {
      const r = await m.scanDocument(source, { detector: 'ml', mode: 'detect', ml: { assetBaseUrl: ASSETS } });
      if (!r || !r.success || !r.corners) return { corners: null, score: r?.score ?? 0 };
      const c = r.corners;
      return {
        corners: [[c.topLeft.x, c.topLeft.y], [c.topRight.x, c.topRight.y], [c.bottomRight.x, c.bottomRight.y], [c.bottomLeft.x, c.bottomLeft.y]],
        score: r.score ?? r.confidence ?? 1,
      };
    } catch (err) {
      // errore su una singola immagine: non si spegne l'IA per tutto il resto della sessione
      console.warn('Rilevamento IA non riuscito su questa immagine', err);
      return null;
    }
  });
}

export const mlAvailable = () => !loadFailed;
