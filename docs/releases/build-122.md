# Build 122 — Raindrop

13 novembre 2026. Pubblicazione autorizzata dall’utente. **API e worker pubblicati e verificati**,
migrazione 0055 applicata. Account personale ancora da collegare. **Upload iOS ricevuto da Apple**
alle 14:19 CET; elaborazione, note italiane e assegnazione Interni ancora da verificare dopo il login web.

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
IPA effettivamente caricata **83.023.606 byte**, SHA-256
`0c85642f48234f05168d5b0278d5b03878784dfc7aba705ee8882096506f8fab`.
L’export preliminare verificato era 83.023.284 byte, SHA-256
`9e77a7e2969306f3c93d628cd40bb7446a1745897f990a0365f7f93194488bc7`.
Nuova verifica completa di firme/profili e input sul pacchetto caricato; tutti e quattro gli eseguibili
privati della firma sono identici all’export preliminare. Il confezionamento e la firma dell’app
principale cambiano nell’esportazione con destinazione upload, non il codice compilato.
Artefatti privati ufficio `~/Library/Caches/ernie-builds/build-122-20261113-raindrop/`:
archivio firmato, export IPA, manifest, input e log. Il backend comprende inoltre la risoluzione
delle raccolte per nome/percorso, con risultati paginati e totali espliciti; nessuna differenza agli
input iOS rispetto al commit dell’archivio.

Il via libera di pubblicazione è stato ricevuto. Il primo upload era stato rifiutato per contratto
aggiornato. L’utente ha letto e accettato personalmente la licenza; il secondo upload dall’archivio
firmato è terminato con **EXPORT SUCCEEDED**, «Upload succeeded» e «Uploaded package is processing»
il **13 novembre 2026 alle 14:19 CET**. Log privato `upload-after-agreement.log`; pacchetto effettivo
conservato in `upload/Ernie.ipa`, verifica `verify-upload.json`, confronto binari
`upload-binary-comparison.json`. Nessun nuovo caricamento necessario.

Sessione web App Store Connect scaduta: lasciata scheda di login all’utente per verificare elaborazione,
applicare le note italiane già pronte (949 caratteri, `whats-new-it.txt`) e assegnare il gruppo Interni.
**Disponibilità della 122 su TestFlight non ancora verificata**; nessuna dichiarazione di distribuzione
completata finché il portale non la conferma. Non occorre un nuovo consenso alla pubblicazione.

## Backend pubblicato

Checkout Git `35e9008e03bab9fae65b60c2d348f8dd3f809493`; immagine API e worker
`sha256:32bec54e34a7197e3ca46a8250ab49d3d5ed93561aef201a16c73f5e731b2547`.
Backup `/srv/staging3/backups/ernie-pre-122-20261113/`: progetto, configurazioni, dump PostgreSQL
con indice verificato, vecchie immagini distinte per API/worker, log e risultato smoke.
Migrazione 0055 applicata, RLS e FORCE RLS riletti; chiave dedicata generata e copia privata di
recupero sul Mac ufficio in `~/Library/Application Support/ErniePrivate/`.
Solo la nuova impostazione Raindrop aggiunta: altre impostazioni e override confrontati col backup.
Postgres e Redis non ricreati; health/readiness pubbliche 200, worker memoria e automazioni pronti.
L’etichetta legacy della health resta quella dell’ambiente; Git, immagine e sei moduli compilati
verificati direttamente rispetto ai moduli locali testati.

Smoke sul servizio in esercizio: stato HTTPS configurato ma spento, collegamento con provider sintetico
iniettato nel servizio compilato, cifratura e isolamento, blocco a skill spenta, scollegamento e filtro
di memoria. Fixture rimosse; zero chiamate reali a Raindrop/LLM e nessuna nota/fatto/automazione creata.
Zero utenti con skill esplicitamente attivata e zero collegamenti reali al termine delle verifiche.
