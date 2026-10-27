# Build 108 — Lettura dei contenuti

27 ottobre 2026. **Disponibile su TestFlight**, gruppo **Interni**.
Apple: **VALID**, **IN_BETA_TESTING**. Build ID `f51d2138-4afe-45b6-ab3c-63c10bc495fb`.
Note italiane dal changelog pubblicate e rilette: **779 caratteri**. Nessuna installazione diretta su iPhone fisico.

## Comportamento

Impostazioni → Diagnostica → Lettura dei contenuti: stato dei metadati YouTube, sottotitoli,
analisi visiva e Instagram, limitato all’account autenticato. Configurazione distinta da una lettura riuscita;
ultimo esito, data e durata, con messaggi italiani per credito, budget, limiti temporanei e accessi bloccati.
Aggiornare il pannello legge solo Redis: nessuna sonda remota o chiamata AI. Gli esiti scadono dopo 24 ore,
non contengono URL, testi, cookie o errori grezzi. Le risposte di un vecchio account non riappaiono dopo il cambio.

Riassunti YouTube espliciti: prova una sola traccia pubblica di sottotitoli (italiano preferito), JSON3,
5 secondi, 500 kB e 32.000 caratteri massimi. Timestamp e controllo conservativo dell’estensione temporale;
nessun download audio, nuovo provider, cookie o aggiramento dei blocchi. Per blocchi/errori/limiti dei sottotitoli,
pausa di cinque minuti per account, poi lettura visiva esistente. I riassunti culinari e le richieste sulle immagini
usano sempre il video. Richieste negate o miste (riassunto e ricetta) conservano la ricetta completa.
Cache separata per account e per riassunto testuale, riassunto visivo, lettura completa.

L’output YouTube include provenienza comune: URL canonico, titolo/autore, metodo, lingua, data,
copertura e limiti. I sottotitoli non vengono presentati come immagini viste o audio ascoltato.
Il prompt di salvataggio richiede di mantenere metodo e limiti nel Brain; non è una migrazione delle note esistenti.
Budget, registrazione consumi, limite di 20 minuti e analisi visiva delle ricette restano applicati.
Gli errori HTTP del servizio AI sono distinti da quelli del contenuto.

Instagram resta **non collegato**, coerentemente con la scelta precedente. Nessuna installazione di Agent-Reach.

## Verifiche prima del rilascio

- TypeScript API e pacchetti dipendenti: compilazione riuscita.
- **101 test backend verdi**: YouTube (31), sottotitoli (5), diagnostica (3), server (8),
  WebSocket (50) e blocchi della risposta (4).
  Contratto, accesso chat, isolamento account, input ostili, limiti, cache, fallback, credito e classificazione HTTP.
- Prova pubblica senza AI su tre link: due pagine pubbliche con durata ma sottotitoli non leggibili;
  terza pagina senza durata. **Il percorso sottotitoli non è verificato end-to-end con un video reale**;
  parser e analisi testuale sono coperti da fixture. Non è dimostrato un risparmio effettivo su quei link.
- Simulatore iPhone 17 Pro, iOS 26.5: **23 test verdi in tre suite** (ContentReaders, Confirmation, PerformanceObservation).
  Coperti contratto HTTP, server precedente, refresh concorrenti, cambio account e uscita durante una richiesta.
- Backend pubblicato da Git al commit `f157faf646280c7ed6e56e514a56a88f5233f409`.
  Compilazione Docker API/worker riuscita; ricreata **solo l’API**, worker/DB/Redis conservati.
  Health HTTPS OK; nuova rotta senza chiave → 401. Contratto diagnostica e lettura Redis verificati
  nel container con identità di prova, senza scrivere né usare credenziali di utenti reali.
- Sul VPS le tre pagine non espongono durata/sottotitoli utilizzabili. Resta il limite noto per i video
  normali con pagina anti-bot; gli URL Shorts mantengono l’eccezione precedente. Nessuna chiamata AI
  reale eseguita in queste prove; costo e qualità del percorso testuale restano da verificare sul campo.
- `ARCHIVE SUCCEEDED` da export Git pulito; `EXPORT SUCCEEDED` con firma Apple Distribution.
  Verificati app e tre estensioni con `codesign --verify --deep --strict`, versione 108, entitlement dai sorgenti,
  diario privato solo nell’app principale, changelog e sette WAV identici. Manifest IPA: 59 file.
- Upload della **stessa IPA verificata**: `UPLOAD SUCCEEDED with no errors`, codice 0, 81.001.901 byte.
  Delivery UUID `f51d2138-4afe-45b6-ab3c-63c10bc495fb`. SHA-256:
  `0c2b0dada4835dc1480d09b1ec3d6bda56972621f81f5d28a303184ba804f141`.
  Credenziali API temporanee rimosse dopo export/upload; nessuna chiave privata di firma trasferita.
- Il primo export è rimasto senza risposta nella creazione della riserva upload Apple. Interrotto dopo
  verifica API senza build/upload presenti; secondo export riuscito dallo stesso archivio, senza ricompilare.
- Stato Apple verificato via API: `VALID`, `IN_BETA_TESTING`, gruppo Interni associato automaticamente;
  note italiane rilette (779 caratteri). Nessuna aggiunta manuale di gruppi.

## Riproducibilità

Build 108 su app e tre estensioni; sorgenti, risorse e progetto Xcode pubblicati su GitHub prima della
compilazione Release pulita. Sorgenti `f157faf646280c7ed6e56e514a56a88f5233f409`,
SHA remoto verificato; **287 input iOS** con manifest SHA-256. Export e verifica dei permessi seguono il percorso Apple API della build 107.
Il backend richiede un deploy separato da Git; nessuna migrazione DB e nessuna nuova credenziale.
Evidenze temporanee: `/tmp/ernie-readers-*`; archivio in
`~/Library/Caches/ernie-builds/build-108-20261027-content-readers/`.

## Backend e recupero

Backup checkout privato: `/srv/staging3/backups/ernie-pre-readers-108-20261027/checkout`;
immagine precedente: `ernie-app:pre-readers-108`. Immagine nuova API:
`sha256:66dec3464b0432cf6b144c7d8ab8d7d37c2680c12f7a3ed04e69dbef5474c1a6`. Worker ancora sull’immagine precedente; nessuna modifica ai suoi sorgenti.
`.env`, override, volumi e migrazioni conservati. Il campo version di `/health` resta
`0.1.0-reminder-details-106`, impostato dall’ambiente esistente: identificare il deploy con SHA Git e immagine.
Per recuperare il servizio, conservare il checkout nuovo, assegnare nuovamente
`ernie-app:pre-readers-108` al tag `ernie-app:local` e ricreare soltanto l’API con Compose (`up -d --no-deps api`);
nessuna migrazione DB da annullare. Gli esiti Redis sono temporanei e non contengono contenuti acquisiti.
