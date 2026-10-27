# Build 109 — Messaggi in famiglia

27 ottobre 2026. **Disponibile su TestFlight**, gruppo **Interni**.
Apple: **VALID**, **IN_BETA_TESTING**. Build ID `1a17f25e-cfb5-4eb4-bd9c-c317cac999aa`.
Note italiane pubblicate dal changelog e rilette: **687 caratteri**.

## UX

Una sola superficie con destinatario/mittente, urgenza e ora nell’intestazione; testo in evidenza;
stato della conferma in fondo, separato da una linea sottile. Rimossi etichette esterne a forma di busta,
bordo rosso spesso e descrizione ripetuta del telefono che suona. Gli urgenti usano tutta la larghezza della chat.
Il rosso segnala l’urgenza, senza circondare l’intero messaggio. Dopo la conferma compare lo stato positivo con ora.
Il solo invio non viene presentato come consegna o lettura verificata. Verde di conferma nel tema chiaro
con contrasto 5,02:1 sul bianco; variante chiara distinta da quella scura.

Palette e tipografia seguono l’orso (Borg monospaziato incluso), in chiaro e scuro. Testo e nomi lunghi si
espandono; con Dynamic Type accessibile le azioni si dispongono in verticale. Pulsanti con altezza minima 44 pt.
Le foto mantengono le proporzioni, entro 240 pt di altezza. Testo selezionabile.
«Rispondi» apre il compositore esistente; «Apri e conferma» apre la schermata di conferma urgente esistente.
Nessuna nuova azione di invio, annullamento o conferma automatica.

Il risultato di `family_message_send` include una nota per il modello: riscontro in una sola frase breve,
dettagli nella scheda; nessuna affermazione che il telefono stia suonando o che la consegna sia verificata.
Non vengono riscritte le risposte di Ernie già presenti nello storico. API di invio, deduplica, notifiche,
ripetizioni e conferma di lettura conservano il comportamento precedente.

## Verifiche

- **27 test iOS verdi**: FamilyMessageCard (4), Lifecycle e Confirmation; simulatore iPhone 17 Pro iOS 26.5.
- Rendering nativo: Borg in attesa, chiaro in attesa, scuro confermato, ricevuto urgente, normale inviato/ricevuto,
  320 pt con caratteri grandi e accessibili. Nomi e messaggi lunghi aumentano l’altezza senza tagliare contenuto;
  foto panoramiche/verticali entro i limiti. Anteprima Borg a 390 pt: altezza totale 198,5 pt, margini inclusi.
- **10 test backend verdi**: family-message-tool, family-urgent e family-push. Invii soltanto simulati;
  nessun messaggio o push reale di prova. TypeScript e Biome riusciti.
- Ripetuti i quattro test della scheda dopo la rifinitura del contrasto; verdi anche la nuova anteprima
  chiara dopo conferma e le foto molto verticali/panoramiche.
- API pubblicata da Git al commit `f961ab088e88c8e8630d98c8b5b4eeeb4b6e041d`, solo container API ricreato;
  health HTTPS OK. Worker, database, Redis, `.env` e override conservati. Nessuna migrazione né nuova credenziale.
- `ARCHIVE SUCCEEDED` da export Git pulito, sorgenti **`c3cede513ae6041c3040fd05cc5e79800b20cc54`**
  pubblicati prima della compilazione finale; manifest SHA-256 di **288 file iOS**.
- `EXPORT SUCCEEDED`; IPA Apple Distribution verificata con `codesign --verify --deep --strict` su app e tre
  estensioni, tutte alla 109. Entitlement confrontati con i sorgenti; diario privato soltanto nell’app principale.
  Changelog e sette WAV identici. Manifest IPA: 59 file, 81.004.439 byte.
- SHA-256 IPA verificata: `5d476bf419337090cd0a95282ce2bb9a7161a4ad093d79ea28c362c9fccb6ff7`.
  Upload della stessa IPA verificata: `UPLOAD SUCCEEDED with no errors`, codice 0.
  Delivery UUID `1a17f25e-cfb5-4eb4-bd9c-c317cac999aa`; Apple `VALID`, `IN_BETA_TESTING`, gruppo Interni associato automaticamente.
  Note italiane rilette (687 caratteri). Copie temporanee della credenziale API Apple rimosse al termine;
  nessuna chiave privata di firma trasferita. Nessuna installazione diretta su iPhone fisico.

## Riproducibilità

Build 109 su app e tre estensioni. Sorgenti pubblicati su GitHub prima di compilare Release da export Git
pulito; firma Apple API come nelle build 107/108. Evidenze: `/tmp/ernie-family-card-*`,
`~/Library/Caches/ernie-builds/build-109-20261027-family-cards/`.
La successiva pulizia delle fixture usa solo nomi/testi sintetici: nessuna modifica agli input runtime,
confrontati per hash; i target dei test non sono presenti nella IPA distribuita.

## Backend e recupero

Backup checkout: `/srv/staging3/backups/ernie-pre-family-card-109-20261027/checkout` (accesso privato).
Immagine di recupero: `ernie-app:pre-family-card-109`; nuova API:
`sha256:0b968a3df7299121b050e799a0ac0375e793b762a202b19e2a9586e6287ee196`.
Worker invariato (avviato il 27 ott alle 06:14 UTC), DB e Redis non ricreati.
Il campo versione di `/health` conserva il valore dell’ambiente `0.1.0-reminder-details-106`:
per identificare questa pubblicazione usare commit Git e immagine, senza modificare `.env`.
Recupero: riassegnare il tag dell’immagine precedente a `ernie-app:local`, poi `up -d --no-deps api`;
nessuna migrazione DB da annullare.
