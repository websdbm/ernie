# Build 106 — Appuntamenti completi e liste più ordinate

**Disponibile su TestFlight**, verificata il **27 ottobre 2026**: `VALID`, `IN_BETA_TESTING`, gruppo Interni,
note italiane verificate. Compilata, firmata e caricata dal Mac dell’ufficio.

26 ottobre: appuntamenti con luogo, link e note (Codex, ufficio). 27 ottobre: pannello delle liste e giornate
archiviate (Claude Code, Mac Studio), inclusi nell’archivio pubblicato. Sorgenti `af5a80238278985525ab2bc03811073f5655d3a2`.

## Funzionamento

- `location` (indirizzo o etichetta di un luogo), `url` (http/https completo, fino a 2000 caratteri),
  `notes` (testo, fino a 4000 caratteri) facoltativi. La sede non cambia il trigger dell’avviso.
- Campi conservati nei metadati delle automazioni: nessuna migrazione necessaria. La lettura dei vecchi
  promemoria resta compatibile. Un’etichetta nota nella scheda risolve anche l’indirizzo per Mappe.
- `reminder_create` v3, `reminder_list`, nuovo `reminder_update`, blocchi chat e REST condividono il contratto.
  Le richieste con URL, indirizzi o note passano dal modello per l’estrazione strutturata.
- Omettere un campo lo conserva; `null` lo cancella. La sola modifica dei dettagli mantiene id, job e orario.
  Testo/orario continuano a usare il percorso di sostituzione esistente, preservando i dettagli.
- App: matita nella scheda chat o in Promemoria; luogo apribile in Mappe, link apribile e note espandibili.
  Dettagli inclusi anche nelle email se questo canale è stato scelto.
- Ernie chiede solo i dettagli necessari o ambigui e può completarli in seguito. Nessuna informazione inventata.

## Pannello laterale e giornate passate (27 ott)

Richiesta dell'utente: le liste nel pannello erano troppo verbose, spesa e attività mescolate, giornate passate
ancora in vista.

- `ListShortcutsSection`: due gruppi, «Spesa» e «Attività», una riga per lista (nome troncato, a destra quante
  voci restano e il giorno breve: «oggi», «domani», «ven», «23 ott»); tre righe per gruppo con «Mostra tutte».
  Liste della spesa archiviate fuori dal pannello.
- `TodoTime.isArchived`: una lista con giorno è archiviata quando nel suo fuso è iniziato il giorno dopo; le liste
  senza giorno non scadono. Fuori dal pannello e in «Archiviate» (chiuso) nella pagina Attività. Calcolato
  nell'app, nessun dato modificato.
- Server (già pubblicato il 27 ott, `5abd040`): «aggiungi alla lista … <voci>» non aggiunge più la voce «alla».

## Verifiche

Compilazione TypeScript completa e **191 test** backend/protocollo/tool/routing superati (`6f09699`);
compresi luoghi espressi come etichette, creazione/modifica/cancellazione dei dettagli e compatibilità. Nove test nativi di contratto e anteprima superati: compatibilità, URL e PATCH con cancellazione esplicita.
Anteprime a 320 pt in tema chiaro e scuro renderizzate e ispezionate.
Prova con modello reale `anthropic/claude-sonnet-5.5`: estratti correttamente luogo, URL completo con parametri,
note e orario; archivio promemoria sostituito da uno stub, nessun appuntamento di prova salvato.

Verifiche del 27 ott (Mac Studio, codice unito delle due parti): suite completa dell'app 295 test, 294 verdi;
`TerminalChatTests.focusProgrammaticoECambioSkinNellaBarraCompleta` (instabile noto) passa con la sua suite.
Test nuovo `giornataPassataNelSuoFusoEArchiviataEGiornoBreve`; anteprima del pannello disegnata e controllata.
Server: 823 test unitari verdi; nessun errore nei log dopo la pubblicazione di `72a027e`, che include anche la
parte server degli appuntamenti.


## Pubblicazione appuntamenti e tracciabilità (verifica 27 ottobre)

- Sorgenti iniziali appuntamenti `4e02ec2`; preparazione iOS `edcd06e`;
  riconoscimento sedi negli eventi `6f09699`. Tutti pubblicati e verificati su GitHub `main`.
- Backend distribuito da Git il 26 ottobre, poi aggiornato dal Mac Studio il 27 ottobre con la correzione spesa:
  checkout attuale `72a027ee0a71772ebcaf326f334833c5df47fa0c`, API healthy e `/health` HTTP 200,
  versione `0.1.0-reminder-details-106`.
- Immagine corrente verificata: `sha256:a2bafb183c2cb8d1a1deac78b6b04b9b4105b821c639161bfba3c8a3e10af95e`.
- Link del workshop recuperato dalla richiesta originale e associato al promemoria esistente tramite store;
  verificati stesso id, stessa azione e stesso trigger. Nessun dato personale incluso in Git.
- Evidenze e backup del 26 ottobre: `/srv/staging3/backups/ernie-reminder-106-20261026/`.
  Questi precedono le modifiche del 27 ottobre; per un eventuale rollback corrente tenere conto del successivo
  backup `ernie-app:pre-5abd040`, senza ripristinare alla cieca la vecchia configurazione.
- Il primo build Docker ha incontrato file Git creati da root con permessi 600: ripristinati proprietario e
  permessi dei soli file tracciati; `.env` e override esclusi. Ricompilazione riuscita.
  In `.env` è stato aggiornato soltanto `APP_VERSION`, dopo copia privata, per rendere `/health` coerente.

## Tentativi iniziali sul Mac Studio (26–27 ottobre, poi superati)

Sul Mac Studio, da checkout pulito del commit pubblicato `edcd06ec7d4ffe08e1a52776563e64e1d20c1998`,
è riuscita la compilazione Release iPhone con firma disabilitata. Verificati build 106 su app e tre estensioni,
e manifest SHA-256 dei 272 input iOS. Evidenze:
`~/Library/Caches/ernie-builds/build-106-20261026-reminder-details/`.

**Non è un archivio distribuibile**: i tentativi di firma si fermano con `errSecInternalComponent`;
`SecKeychainGetStatus` conferma Portachiavi login bloccato, anche il 27 ottobre. Non sono state copiate chiavi,
lette password o modificate le protezioni del Portachiavi. Chiesto all’utente di sbloccarlo direttamente sul Mac.

Al primo controllo del 27 ottobre App Store Connect aveva ancora la 105: la 106 non era presente.
I prodotti del 26 ottobre non contenevano il pannello liste aggiunto il 27; sono stati quindi scartati come
input per la distribuzione e sostituiti dalla compilazione pulita dall’ufficio descritta sotto.


## Alternativa completata: firma e upload dal Mac dell’ufficio (27 ottobre)

Il Portachiavi login del Mac dell’ufficio era già sbloccato, con identità Apple valide; una firma di prova
ha confermato l’accesso alla chiave locale. L’archivio Release della 106 è stato quindi ricompilato dal
Mac dell’ufficio, senza richiedere lo sblocco del Mac Studio.

- Commit sorgenti **`af5a80238278985525ab2bc03811073f5655d3a2`**, pubblicato su GitHub prima della compilazione:
  comprende `89a1f96` (pannello liste). Export pulito dei 272 input iOS con manifest SHA-256; confronto
  finale con `origin/main` e con il checkout pulito del Mac Studio: nessuna differenza.
- Nessuna differenza nei sorgenti backend fra il checkout server `72a027e` e quel commit.
- `ARCHIVE SUCCEEDED`; firma dell’archivio verificata con `codesign --verify --deep --strict`.
  App e tre estensioni alla 106; gruppo Keychain privato del diario presente soltanto nell’app principale.
- Il primo export con l’account Xcode ha restituito `Failed to Use Accounts`. L’export con l’accesso API Apple
  già configurato è riuscito: `EXPORT SUCCEEDED`, upload completato con codice 0. La copia temporanea della
  chiave di autenticazione, fuori dal repository e con accesso ristretto, è stata rimossa al termine.
  Nessuna chiave privata di firma è stata trasferita tra i Mac.
- L’upload non ha conservato una IPA locale. Evidenze, archivio firmato, manifest dei 60 file dell’archivio
  e log sono in `~/Library/Caches/ernie-builds/build-106-20261027-office/` sul Mac dell’ufficio.

Verifica finale tramite App Store Connect:

- Build ID `d1c38641-a500-4a8c-b935-238b8069aa57`, versione **106**, elaborazione **VALID**.
- Stato interno **IN_BETA_TESTING**, gruppo **Interni**, con accesso alla build.
- Note italiane scritte dal changelog e rilette: **1147 caratteri**, inclusi appuntamenti, pannello liste,
  giornate archiviate e correzione spesa.
- Evidenze API salvate nel percorso locale sopra (`asc-status.json`, `asc-notes.json`).

Il blocco del Portachiavi del Mac Studio riguarda i tentativi iniziali: la distribuzione è completata
con la procedura alternativa dall’ufficio. Nessuna nuova installazione su iPhone fisico è stata eseguita.
Il commit finale della documentazione non modifica gli input iOS della build pubblicata.
