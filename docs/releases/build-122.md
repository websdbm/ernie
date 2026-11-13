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
- **289 test backend passati**, 29 integrazioni estranee non eseguite; PostgreSQL isolato dedicato
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
Sorgenti iOS pubblicati e SHA remoto verificato: `2ca3f01ed4bba3f1b20a0ff32957d17ddfbe30d9`.
Checkout pulito, 321 input iOS verificati per SHA-256. Archivio Release ed export Apple con Xcode 27.2
sul Mac ufficio: l’utente ha creato certificati Apple Development e Apple Distribution validi,
senza revocare i precedenti. Mac Studio offline, non utilizzato per questa compilazione.

Quattro bundle 122 firmati Apple Distribution, profili validi e coerenti, APNs production e gruppo
Diario privato solo nell’app principale, nessun permesso di debug nell’IPA.
IPA **83.023.284 byte**, SHA-256
`9e77a7e2969306f3c93d628cd40bb7446a1745897f990a0365f7f93194488bc7`.
Artefatti privati ufficio `~/Library/Caches/ernie-builds/build-122-20261113-raindrop/`:
archivio firmato, export IPA, manifest, input e log. Il backend comprende inoltre la risoluzione
delle raccolte per nome/percorso, con risultati paginati e totali espliciti; nessuna differenza agli
input iOS rispetto al commit dell’archivio.

Nessun caricamento App Store Connect effettuato. API/worker, migrazione, chiave e TestFlight in attesa
del via libera di pubblicazione richiesto da HANDOFF.md. Il collegamento personale si verifica dopo.
