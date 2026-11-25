# Foglio — scanner di documenti (PWA)

Web app installabile per scansionare documenti con la fotocamera del telefono. Tutto resta sul dispositivo: nessun server e nessun account.

## Funzioni
- **Fotocamera dal vivo** con riconoscimento dei bordi in tempo reale, flash, modalità singola o multipla, scatto automatico (si attiva dalle impostazioni)
- **Importazione** dalla galleria, anche di più foto insieme
- **Ritaglio** con 4 angoli e 4 lati trascinabili, lente d'ingrandimento, rilevamento automatico, rotazione
- **Raddrizzamento prospettico** (omografia) fino a 2400 px
- **8 filtri**: Originale, Migliora, Colore vivo, Documento, Grigi, B/N, Risparmio inchiostro, Senza ombre; più luminosità, contrasto e nitidezza. Si possono applicare a tutte le pagine.
- **Archivio** su IndexedDB con cartelle, ricerca per nome e nel testo OCR, duplicazione, riordino ed eliminazione delle pagine
- **OCR** in italiano e/o inglese (Tesseract.js, si scarica la prima volta e poi funziona offline), testo modificabile, copiabile ed esportabile in .txt
- **PDF** in formato Adatta, A4 o Lettera, in tre livelli di qualità, con **testo ricercabile** invisibile se l'OCR è stato fatto
- **Firma e annotazioni**: penna, evidenziatore, testo, firme disegnate e salvate (fino a 6), tutto spostabile e ridimensionabile, con annulla. Le annotazioni stanno su un livello separato, quindi si possono cambiare filtro e ritaglio senza perderle.
- **Condivisione** tramite il menu di sistema (WhatsApp, email, Drive…) oppure scaricamento
- **Offline** grazie al service worker; scorciatoia "Nuova scansione" dall'icona

## Struttura
```
index.html            schermate dell'app
css/style.css         stile
js/app.js             logica dell'interfaccia
js/imgproc.js         elaborazione immagini (rilevamento bordi, prospettiva, filtri)
js/worker.js          esegue le elaborazioni pesanti in background
js/db.js              archivio IndexedDB
sw.js                 service worker (offline)
vendor/jspdf.umd.min.js  libreria PDF (MIT)
```

## Pubblicazione su GitHub Pages
Settings → Pages → Source: *Deploy from a branch* → branch `main`, cartella `/ (root)`.
La fotocamera funziona solo in HTTPS, e GitHub Pages lo fornisce già.

## Prova in locale
```
python -m http.server 8000
```
poi apri http://localhost:8000 (la fotocamera funziona in locale solo su `localhost`).
