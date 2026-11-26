// MyScanner — worker per le elaborazioni pesanti, così l'interfaccia resta fluida
import { detectQuad, snapData, fuse } from './detect.js';
import { warpPerspective, rotate90, applyFilter, adjust } from './imgproc.js';

const wrap = img => ({ data: new Uint8ClampedArray(img.data.buffer || img.data), width: img.width, height: img.height });

// anteprime tenute in memoria nel worker: i filtri non devono ricevere ogni volta l'immagine
const cache = new Map();

self.onmessage = e => {
  const { id, op, img, opts = {} } = e.data;
  try {
    let src = img ? wrap(img) : null, out, result;
    if (op === 'cacheImg') {
      cache.set(opts.key, { img: src, ctx: {} });
      while (cache.size > 4) cache.delete(cache.keys().next().value);
      result = true;
    } else if (op === 'filterKey') {
      const entry = cache.get(opts.key);
      if (!entry) throw new Error('anteprima non in memoria');
      const copy = { data: new Uint8ClampedArray(entry.img.data), width: entry.img.width, height: entry.img.height };
      out = adjust(applyFilter(copy, opts.filter, entry.ctx), opts.adj);
    } else if (op === 'detect') {
      const r = detectQuad(src);
      result = r ? r.corners : null;
    } else if (op === 'fuse') {
      result = fuse(src, opts.ml || null);
    } else if (op === 'snap') {
      result = snapData(src);
    } else if (op === 'warp') {
      out = rotate90(warpPerspective(src, opts.corners, opts.maxSide), opts.rotation || 0);
    } else if (op === 'filter') {
      out = adjust(applyFilter(src, opts.filter), opts.adj);
    } else if (op === 'process') {
      out = rotate90(warpPerspective(src, opts.corners, opts.maxSide), opts.rotation || 0);
      out = adjust(applyFilter(out, opts.filter), opts.adj);
    } else if (op === 'rotate') {
      out = rotate90(src, opts.times);
    } else throw new Error('op sconosciuta: ' + op);
    if (out) self.postMessage({ id, img: { data: out.data, width: out.width, height: out.height } }, [out.data.buffer]);
    else self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
