# Build 104 — Più stabile e più riservato

25 ottobre 2026. **Caricata su TestFlight** dal Mac Studio, `VALID` su App Store Connect
(build ID `5e0dfbc6-197b-47d0-a75e-97b38e674aaa`), «Cosa testare» scritto dalle novità.

Nasce dalla revisione generale delle build 64–103 descritta in [HANDOFF](../HANDOFF.md).

## Contenuto

- **Crash alla conferma di lettura**: `AppDelegate` gestiva le notifiche con metodi `async` nonisolated; al tocco su
  «… ha letto» iOS chiudeva la consegna su un thread di Swift Concurrency e UIKit aggiornava l'istantanea fuori dal
  main (NSAssertion `_updateSnapshotAndStateRestorationWithAction`). Visto il 16 ott (build 62) e il 24 ott (build 102),
  simbolizzato su `AppDelegate.userNotificationCenter(_:didReceive:)`. Ora completamento esplicito sul main.
- **Crash della dettatura del diario** e della prova vocale in Diagnostica: callback di sistema (`requestAuthorization`,
  `AVSpeechSynthesizer.write`) che ereditavano il MainActor; ora `@Sendable`.
- **Diario**: il testo privato che nomina il «diario operativo/delle attività» resta nel diario (prima finiva in chat e
  al server); il ripristino di una copia a diario bloccato unisce le pagine e sostituisce solo con la chiave
  invalidata (`DiaryError.keyInvalidated`).
- **Spesa**: niente chiusura con id di lista duplicati.

## Backend pubblicato insieme

- YouTube: «dati non leggibili» con le ricette il cui tempo superava 40 caratteri (riprodotto 3/3 sullo Short
  dell'utente, poi 2/2 riuscito dopo la correzione).
- Todo: orari del modello con lo scostamento di prima del cambio dell'ora rifiutati con istruzioni; orari inesistenti
  con messaggio dedicato.
- SSH: output ripulito da define di wp-config, `*_TOKEN`, tabelle e token negli URL; `wp config get` di segreti
  rifiutato.
- Scope `chat` su sintesi vocale, consumi e prestazioni; diario 503 per errori del server; replay WebSocket dopo
  `session_forbidden`; avvio dell'API con il primo recupero dei Todo protetto; data delle foto nel fuso di Roma.

## Verifiche

- Server: typecheck, lint (27 avvisi preesistenti), 915 test di cui l'integrazione su Postgres 17 e Redis reali
  (ruolo `ernie_app`, RLS, migrazioni fino alla 0046): tutti verdi.
- App: 281 test; verdi tranne `TerminalChatTests.focusProgrammaticoECambioSkinNellaBarraCompleta`, che passa da solo
  (6/6) e fallisce a volte nella suite completa; `avvioRealeMicrofonoRiceveBufferEFermaSenzaCrash` escluso perché sul
  simulatore nuovo aspetta il permesso del microfono. Test nuovi: comandi del diario con «diario operativo» nel testo,
  ripristino con chiave valida, annullata o invalidata.

## Tracciabilità

- Commit dei sorgenti `4d9aa7d`, pubblicato e verificato su GitHub `main` prima dell'archiviazione; archiviato dal
  checkout pulito del Mac Studio con `CURRENT_PROJECT_VERSION=104` (anche in `project.yml`, quattro target).
- Server staging3 riallineato a git sullo stesso commit: copia di sicurezza della cartella in
  `/srv/staging3/backups/ernie-pre-git-sync-20261025/` (`working-tree.tgz`, stato git precedente), immagine precedente
  `ernie-app:pre-104`. Rimossi 25 file `._*` lasciati dalle copie da macOS. API e worker ricostruiti;
  `/health` 200, chiave errata 401, diario senza accesso 401. Nessuna migrazione.
  Ritorno indietro: `docker tag ernie-app:pre-104 ernie-app:local` e `docker compose up -d api worker`.
- iPhone di Giorgio: pacchetto ad hoc 104 preparato (SHA-256 `ed6c44b2f67badea779203c4b6921d1c0174a2a0f4a90c66e850bc6483652ccf`); installazione al prossimo collegamento, il telefono era irraggiungibile (era alla 102).

Il commit della documentazione finale non modifica i sorgenti della build.
