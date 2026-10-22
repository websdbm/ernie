# Build 96 — Memoria affidabile e continuità

Le schede mostrano stato, fonte, validità e revisioni dei fatti. Le impostazioni
«Come lavora Ernie» permettono di gestire le preferenze esplicite. Le nuove chat
leggono le liste canoniche aggiornate e i soli spunti storici pertinenti, senza
creare nuove notifiche. Il consolidamento generale salta il modello quando tutte
le versioni delle note sono già state esaminate, mantenendo il limite giornaliero.

Contratti e limiti: [memoria e continuità](../research/19-memoria-continuita-preferenze.md).

## Verifiche prima della distribuzione

- TypeScript build/typecheck superato.
- Suite completa: 876 test superati, uno online opzionale non eseguito; PostgreSQL
  e Redis isolati reali, incluse RLS, concorrenza e aggiornamenti persistiti.
- Nove test nativi delle schede e un test nativo delle preferenze superati.
  Anteprime ispezionate in tema chiaro/scuro e con testo accessibile. Corretto
  il colore delle fonti nelle righe delle preferenze in tema scuro.
- Etichette italiane dei nuovi strumenti sincronizzate con il client.
- Verifica su iPhone fisico non eseguita.

## Backend

API e worker su staging: versione `0.1.0-continuity-20261022.1`, immagine
`sha256:89b202709cc771aa73243f25491894ac25a8ace27f481bdff7581b603cd5cede`.
Backup privato: `/srv/staging3/backups/ernie/20261022-continuity/`.
Nessuna nuova migrazione o dipendenza. Immagine ottenuta dalla precedente,
aggiornando solo JavaScript compilati e relativi metadati; quota inode rootless
invariata. Sono stati verificati 1.464 file compilati nel runtime con SHA-256.

Il collaudo HTTPS/WebSocket ha completato cinque turni reali: salvataggio di una
preferenza, recupero da una nuova chat, aggiornamento del fatto Sport con citazione
originale e cronologia, lettura di una lista, nuova lettura dopo completamento di
un elemento. Controllati i dati persistiti, l'isolamento fra account, modifica/
disattivazione/eliminazione delle preferenze, assenza di duplicati e notifiche.
Costo registrato complessivo: 0,258609239 USD. Le prime esecuzioni hanno individuato
due errori nel solo harness di collaudo (DELETE con Content-Type ma corpo vuoto;
creazione Todo priva di ID/giorno). Corretto l'harness e completati i casi rimanenti.
Gli account sintetici, le relative code e i vault sono stati eliminati dopo i test.

La pubblicazione Git include anche la chiusura delle dipendenze backend già
presenti sul server ma ancora non versionate: ricette, media, Todo, SSH, voce,
consumi e performance. Sono state confrontate con i sorgenti live prima di
selezionarle; non sono nuovi deployment di quelle funzionalità. Restano fuori
bozze grafiche, script backup e documentazione estranea alla release.

## Distribuzione iOS

In preparazione: sorgenti da pubblicare su GitHub prima dell'archive e del
caricamento. Build 96 non ancora distribuita. Compilazione prevista sul Mac Studio
da snapshot del commit pubblicato, con hash di tutti gli input e verifica di
firma, quattro bundle e risorse. Rollback client: build 95.

Evidenze backend: `/tmp/ernie-continuity-20261022/`.
Evidenze iOS: `/tmp/ernie-brain-reliability-20261022/` e
`/tmp/ernie-operating-preferences-20261022/`.
