# Build 122 — Raindrop

13 novembre 2026. Implementazione autorizzata dall’utente. API/worker e iOS preparati,
**non pubblicati**; account personale ancora da collegare. La build attiva resta la 121.

## Funzionalità

- Skill disponibile ma spenta per impostazione predefinita, attivazione e credenziali per account.
- Collegamento con token personale Raindrop nel pannello, verifica del profilo in sola lettura,
  credenziale e metadati cifrati nel backend. Nessuna password o token in chat.
- Ricerca paginata per parole/filtri, raccolte principali e annidate, note ed evidenziazioni con link.
- Consultazione semantica/integrale attraverso il MCP ufficiale quando consentita dal piano,
  schemi correnti e allowlist di lettura. Nessuna promessa di testo integrale da un semplice estratto.
- Salvataggio di un link soltanto su richiesta, senza ritentare automaticamente una scrittura incerta.
- Nessuna importazione nel Second Brain o nell’indice personale; protezione meccanica del
  consolidamento e del riepilogo anche per risposte successive basate sul contenuto letto.
- Spegnimento, scollegamento e cambio account gestiti; risultati tardivi di lettura/collegamento
  non possono ripopolare lo stato dopo lo scollegamento. Nessun tool di cancellazione remoto.

## Dipendenze e attivazione

Pubblicare **API e worker** dal medesimo commit: il worker precedente non filtra i contenuti Raindrop.
Applicare migrazione **0055** dopo backup e predisporre keyring dedicato `RAINDROP_ENCRYPTION_KEYS`.
Nessuna modifica ai consensi Salute/Abitudini né alle chiavi esistenti. La skill resterà spenta.
Il token personale non appartiene alla configurazione globale: viene inserito dall’utente dopo
l’attivazione. Istruzioni e contratti in [Raindrop](../integrations/raindrop.md).

Non implementato OAuth interattivo nativo: la prima versione usa il percorso ufficiale del Test token
per il proprio account. MCP di un client ospitato potrebbe richiedere abilitazione del provider;
letture avanzate e piano devono essere verificati con l’account reale.

## Verifiche

- `pnpm typecheck` e Biome sui file cambiati superati.
- **288 test backend passati**, 29 integrazioni estranee non eseguite; PostgreSQL isolato dedicato
  `127.0.0.1:62205/ernie` per RLS/cifratura/migrazione. Fixture sintetiche rimosse dal test.
- HTTP autenticata, rifiuto userId contraffatto, token assente dalle risposte/log, errori provider depurati,
  limite payload e redirect, unica richiesta di salvataggio, schemi MCP/SSE con connessione lasciata aperta.
- Skill off per account, isolamento con chiave autenticata, interruzione e scollegamento durante richieste.
- Regressioni chat, companion, memoria, policy/executor, skill e server passate.
- **25 test iOS passati** su iPhone 17 simulato iOS 27.2 con Xcode 27.2: Raindrop, lettori,
  compiti paralleli e stile delle azioni. Risultati locali `/tmp/ernie-raindrop-tests-final.xcresult`.
- Nessuna chiamata AI o accesso alla libreria reale durante i test. Nessun segnalibro reale creato.

## Archivio e distribuzione

Numero 122 in tutti e quattro i bundle, changelog e progetto Xcode versionati.
Compilazioni di test locali riuscite; archivio dispositivo da preparare dal commit pubblicato.
Firma/esportazione non completate: Mac Studio offline; sul Mac ufficio risultano solo due certificati
Apple Development scaduti. L’utente sta verificando Manage Certificates in Xcode.
Nessun caricamento App Store Connect effettuato. Non confondere archivio senza firma con IPA installabile.
