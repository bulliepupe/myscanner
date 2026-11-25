// MyScanner — archivio locale su IndexedDB
const DB_NAME = 'foglio';
const VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pages')) {
        const s = db.createObjectStore('pages', { keyPath: 'id' });
        s.createIndex('docId', 'docId');
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result;
    Promise.resolve(fn(t)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const db = {
  async listDocs() {
    return tx('docs', 'readonly', t => reqP(t.objectStore('docs').getAll()))
      .then(list => list.sort((a, b) => b.updated - a.updated));
  },
  getDoc: id => tx('docs', 'readonly', t => reqP(t.objectStore('docs').get(id))),
  putDoc: doc => tx('docs', 'readwrite', t => { doc.updated = Date.now(); t.objectStore('docs').put(doc); }),
  getPage: id => tx('pages', 'readonly', t => reqP(t.objectStore('pages').get(id))),
  putPage: page => tx('pages', 'readwrite', t => { t.objectStore('pages').put(page); }),
  deletePage: id => tx('pages', 'readwrite', t => { t.objectStore('pages').delete(id); }),
  async getPages(doc) {
    const pages = await Promise.all(doc.pages.map(id => db.getPage(id)));
    return pages.filter(Boolean);
  },
  async deleteDoc(doc) {
    await tx(['docs', 'pages'], 'readwrite', t => {
      t.objectStore('docs').delete(doc.id);
      for (const pid of doc.pages) t.objectStore('pages').delete(pid);
    });
  },
  getSetting: key => tx('settings', 'readonly', t => reqP(t.objectStore('settings').get(key))),
  setSetting: (key, val) => tx('settings', 'readwrite', t => { t.objectStore('settings').put(val, key); }),
  async estimate() {
    try { return await navigator.storage.estimate(); } catch { return null; }
  },
  async persist() {
    try { return await navigator.storage.persist(); } catch { return false; }
  },
};
