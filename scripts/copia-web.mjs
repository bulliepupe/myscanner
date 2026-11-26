// Copia i file dell'app web nella cartella www, che Capacitor mette dentro l'app Android
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'www');
const items = ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons', 'vendor'];
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
for (const it of items) fs.cpSync(path.join(root, it), path.join(out, it), { recursive: true });
console.log('Cartella www pronta:', items.join(', '));
