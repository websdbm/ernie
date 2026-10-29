# Build 111 — Richieste rapide sui promemoria

29 ottobre 2026. **Disponibile su TestFlight**, gruppo **Interni**.
Apple: **VALID**, **IN_BETA_TESTING**. Build ID `b1d80a6e-45ab-4af8-97b3-de4bdd272483`.
Note italiane pubblicate, rilette e confrontate con il changelog: **765 caratteri**.

## Comportamento

- `/promemoria` e gli alias senza testo aprono l’elenco localmente, anche a skill spenta.
- `/ricordami` prepara la bozza con focus; non invia una richiesta vuota.
- `/ricordami domani alle 18 ritira il pacco` invia `Ricordami domani alle 18 ritira il pacco`.
- `/promemoria domani alle 18 ritira il pacco` invia `Promemoria: domani alle 18 ritira il pacco`.
- `/promemoria sposta il dentista a venerdì alle 10` e `/promemoria annulla il dentista` passano la richiesta
  al normale flusso autenticato. L’app non sceglie ID, data o azioni: interpretazione, chiarimenti e controlli
  restano sul server esistente. Nessun nuovo parser di orari nell’app e nessun tool eseguito direttamente.

Le richieste possono consumare token; la sola navigazione resta locale. Suggerimenti con esempi, freccia
Invia e accessibilità distinguono richiesta e apertura. URL, note, righe e più impegni restano integri.
Skill «Ricordami» verificata prima di richieste o bozza; elenco consultabile anche a skill spenta.
Allegati conservati e bloccati per i comandi come nella 110, richieste oltre 8.000 caratteri rifiutate,
comandi sconosciuti e diario privato non inviati. Nessuna modifica al comportamento degli altri comandi.

## Verifiche e distribuzione

Verifica finale sul Mac Studio: **19 test verdi in tre suite** (SlashCommand, TerminalChat, FamilyMessageCard).
Copertura: elenco/creazione/gestione, skill spenta/non caricata, alias, allegati, limiti, URL e note,
più impegni senza appiattirli, richiesta utente nel recupero della conversazione, regressioni famiglia e focus.
Test senza connessione né account reali: nessun impegno creato o spostato. Non provato un nuovo turno LLM reale.
Digitazione con focus e cursore Borg verificata in anteprima nativa: suggerimento completo e pulsante Invio.
Xcode dell’ufficio richiede la nuova licenza; test, archivio ed export eseguiti sul Mac Studio.
Backend invariato, nessun deploy. Nessuna installazione diretta su iPhone fisici.

## Riproducibilità

Sorgenti **`7c7acb4e3fb6e212e203fccb5bde9bb90db93dcf`** pubblicati e SHA remoto verificato prima della
compilazione da export Git pulito sul Mac Studio. Tutti i quattro target alla build 111.
**290 file iOS** confrontati con GitHub, checkout dell’ufficio e manifest SHA-256 del Mac Studio: identici.
`ARCHIVE SUCCEEDED`, `EXPORT SUCCEEDED`; esportazione con API Apple senza cambiare il Portachiavi
né trasferire chiavi. Preparazione firmata ad hoc su copia dell’archivio e profili validi della 106,
tramite lo script versionato; solo l’IPA definitiva Apple Distribution è stata caricata.
Verificate firma deep/strict, versione, permessi esatti rispetto ai sorgenti, Keychain privato del diario
solo nell’app, changelog e sette WAV. Manifest IPA salvato. Caricata la medesima IPA verificata:
`UPLOAD SUCCEEDED with no errors`, codice 0, **81.133.239 byte**.
SHA-256: `746686313b5e7857e9c8e765c4f3a074f47a677fb5c69626090bba27c9d227c3`.
Apple: `VALID`, `IN_BETA_TESTING`; associazione automatica al gruppo Interni riletta.

Artefatti principali sul Mac Studio e copie di log/manifest sul Mac dell’ufficio:
`~/Library/Caches/ernie-builds/build-111-20261029-reminder-commands/`.
Anteprima nativa ispezionata sul Mac dell’ufficio:
`~/.codex/visualizations/2026/10/29/ernie-reminder-commands-111/inputbar.png`.
