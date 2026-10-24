# Build 103 — Diario personale

24 ottobre 2026. **Disponibile su TestFlight**, verificata alle 14:43 CEST.
`VALID`, `IN_BETA_TESTING`, gruppo «Interni» e note italiane verificati.

## Contenuto

Diario locale cifrato, accesso biometrico separato, originali e bozze con data/ora,
versioni riordinate e punti chiave, riepiloghi per periodo con consenso per ogni
invio AI. Copia cifrata recuperabile con password. Ingresso da Area privata,
menu Second Brain e comando locale «Apri diario»; nessun indice nella memoria
ordinaria. Contratto e confini in [Diario personale](../research/19-private-diary.md).

## Verifiche prima del rilascio

- Test API/catalogo/server: 27/27; TypeScript API e skills compilati.
- Test nativi: 16/16 in quattro suite; crittografia, backup, consenso, comandi locali, lock/cancellazione,
  overflow e fallimento scrittura; regressione avvio locale ErnieTRIX.
- UI nativa: cancello chiaro/scuro, pagina originale e comparsa della richiesta
  di consenso senza inviare testo. Anteprime ispezionate sul simulatore.
- Review privacy indipendente: mitigati overflow e avvisi di mancato salvataggio;
  documentato che la dettatura privata va avviata dentro il diario sbloccato.
- Face ID e Data Protection su iPhone fisico non verificati. Le prove dello
  store usano key access simulato, senza bypass biometrici nella build distribuita.
- Main app con access group dedicato; le tre estensioni mantengono soltanto il
  precedente gruppo condiviso. Tutti e quattro i target alla build 103.

## Deployment backend

- staging3, `/srv/staging3/projects/ernie`: sette file distribuiti, SHA-256
  corrispondenti al commit pubblicato. Nessuna migrazione e nessuna modifica ai
  dati o alla configurazione dei provider.
- API aggiornata e healthy; `/health` HTTP 200, endpoint diario anonimo HTTP 401.
  Worker, PostgreSQL e Redis non riavviati.
- Immagine API `sha256:abcc777c4cfeac0569bb127aa7019f262cac83b938c8b47d0c9386bc08b6aa23`.
- Copia sorgenti precedenti, manifest, log build/deploy e lista dei nuovi file:
  `/srv/staging3/backups/ernie-diary-103-20261024`.
  Immagine precedente conservata come `ernie-app:pre-diary-103`.
  Rollback: ripristinare i soli sorgenti del backup e i nuovi file elencati,
  riportare il tag dell'immagine precedente a `ernie-app:local`, ricreare solo API.
- Prova provider reale con testo sintetico, senza diario o account reale:
  `anthropic/claude-sonnet-5.5`, JSON valido, riordino e quattro punti;
  675 token input, 119 output, costo comunicato USD 0.00254. Routing ZDR e divieto
  raccolta dati mantenuti. Nessuna occorrenza del testo di prova nei log API.
- Caddy dell'endpoint verificato: reverse proxy senza log del corpo della richiesta.
  Questa verifica non attesta le impostazioni di logging dell'account OpenRouter.

## Tracciabilità iOS

- Commit sorgenti `92934c308044f373de489aaea69a3d8329479995`, pubblicato e verificato
  su GitHub `main` prima dell'archiviazione.
- Mac Studio aggiornato in fast-forward da checkout pulito; snapshot Git e
  manifest SHA-256 per tutti i 270 input iOS.
- Archive Release iPhone ed export riusciti. Firma Apple Distribution e profili
  dei quattro bundle verificati, tutti build 103. Gruppo Keychain privato presente
  soltanto nell'app; assente nelle estensioni. Hook Debug assenti.
- Pixel originali dei 536 frame logici degli avatar conservati.
- SHA-256 IPA: `2819d077135013052255f73d56cb162c40c21faa0bab3b47f529a7b6f435806d`.
- Evidenze sul Mac Studio:
  `/Users/alessandro/Library/Caches/ernie-builds/build-103-20261024-private-diary`.

- Upload completato con codice 0. App Store Connect build ID:
  `8a1cc6eb-2415-4b4a-b66c-9c7bd6907828`.
- Verifica 14:43 CEST: `VALID`, `IN_BETA_TESTING`, gruppo «Interni» con accesso
  alla build; note italiane corrispondenti al changelog.

Il commit finale della documentazione non modifica i sorgenti della build.

## Collaudo sul telefono

Aprire da Impostazioni → Area privata → Diario personale. Verificare Face ID,
scrittura e ripresa della bozza, riordino con conferma, ritorno dal background,
uscita con diario bloccato e copia cifrata esportata/reimportata. Per i contenuti
riservati usare la dettatura interna dopo lo sblocco, non quella della chat.
Le prove hardware non sono state effettuate sul telefono dell'utente.
