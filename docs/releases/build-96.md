# Build 96 — Memoria affidabile e continuità

Le schede mostrano stato, fonte, validità e revisioni dei fatti. Le impostazioni
«Come lavora Ernie» permettono di gestire le preferenze esplicite. Le nuove chat
leggono le liste canoniche aggiornate e i soli spunti storici pertinenti, senza
creare nuove notifiche. Il consolidamento generale salta il modello quando tutte
le versioni delle note sono già state esaminate, mantenendo il limite giornaliero.

Contratti e limiti: [memoria e continuità](../research/19-memoria-continuita-preferenze.md).

## Verifiche prima della distribuzione

- TypeScript build/typecheck e lint superati (27 avvisi, nessun errore).
- Suite completa: 876 test superati, uno online opzionale non eseguito; PostgreSQL
  e Redis isolati reali, incluse RLS, concorrenza e aggiornamenti persistiti.
- Nove test nativi delle schede e un test nativo delle preferenze superati.
  Anteprime ispezionate in tema chiaro/scuro e con testo accessibile. Corretto
  il colore delle fonti nelle righe delle preferenze in tema scuro.
- CI GitHub sul commit backend finale: tutti i job superati, compresi build
  Docker, avvio Compose e smoke. [Run verificato](https://github.com/websdbm/ernie/actions/runs/39840704574).
- Etichette italiane dei nuovi strumenti sincronizzate con il client.
- Verifica su iPhone fisico non eseguita.

## Backend

API e worker su staging: versione `0.1.0-continuity-20261022.2`, immagine
`sha256:88124775aa0e75de9ef2ea61011591ee7bdeea04d4db053ec16ac832ab88416e`.
Backup privati: `/srv/staging3/backups/ernie/20261022-continuity/` e
`/srv/staging3/backups/ernie/20261022-continuity-guard/`.
Nessuna nuova migrazione o dipendenza. Immagine ottenuta dalla precedente,
aggiornando solo JavaScript compilati e relativi metadati; quota inode rootless
invariata. Sono stati verificati 1.464 file compilati nel runtime con SHA-256, poi gli otto
file aggiornati dalla correzione finale sulle preferenze.

Il collaudo HTTPS/WebSocket ha completato cinque turni reali: salvataggio di una
preferenza, recupero da una nuova chat, aggiornamento del fatto Sport con citazione
originale e cronologia, lettura di una lista, nuova lettura dopo completamento di
un elemento. Controllati i dati persistiti, l'isolamento fra account, modifica/
disattivazione/eliminazione delle preferenze, assenza di duplicati e notifiche.
Costo registrato complessivo: 0,258609239 USD. Le prime esecuzioni hanno individuato
due errori nel solo harness di collaudo (DELETE con Content-Type ma corpo vuoto;
creazione Todo priva di ID/giorno). Corretto l'harness e completati i casi rimanenti.
Gli account sintetici, le relative code e i vault sono stati eliminati dopo i test.

Una prova aggiuntiva di tre turni ha inserito deliberatamente una regola obsoleta
nei riepiloghi storici: con preferenza attiva viene applicata; dopo disattivazione
e dopo eliminazione non viene ripristinata. Il registro delle preferenze rimane
la fonte autorevole anche vuoto o indisponibile. Costo della prova aggiuntiva:
0,070275270 USD; totale dei collaudi reali 0,328884509 USD. Dopo questa correzione
sono passati altri 65 test mirati. La configurazione GitHub è stata corretta per
usare il ruolo applicativo nei test RLS invece del proprietario del database.

La pubblicazione Git include anche la chiusura delle dipendenze backend già
presenti sul server ma ancora non versionate: ricette, media, Todo, SSH, voce,
consumi e performance. Sono state confrontate con i sorgenti live prima di
selezionarle; non sono nuovi deployment di quelle funzionalità. Restano fuori
bozze grafiche, script backup e documentazione estranea alla release.

## Distribuzione iOS

- Sorgenti iOS: `2205cfb57adbf8ca60e41b73b882a78fde9b93b5`, pubblicati su GitHub
  prima dell'archive. Snapshot pulito dei 254 input iOS verificati con SHA-256
  sul Mac Studio. Tutti e quattro i target sono alla build 96.
- Correzione CI: `22afaff2fdf6bb48828adfe5846bbcf19693a37e`.
- Ultimo backend: `1aa0c4dc63e75fd4d99f0b6d92f9034d5b77673b`, pubblicato e
  verificato su GitHub prima dell'upload iOS. Nessun ulteriore cambiamento iOS.
- Archive ed export App Store Connect riusciti; firme Apple Distribution,
  profili ed entitlement controllati per app, widget, share e notification extension.
- Verificati tutti i 536 fotogrammi logici e la corrispondenza dei pixel con i
  sorgenti, incluse risorse condivise e fallback dei widget.
- SHA-256 IPA: `a6ca45b90f0958a4c7c36bd4076eaa3e7c1aa7b6c7e297e2f2fafb0a1654b059`.
- Upload completato il 22 ottobre 2026; disponibilità TestFlight ancora da confermare.

Archivio e IPA: Mac Studio,
`~/Library/Caches/ernie-builds/build-96-20261022-continuity/`.
Rollback client: build 95.

Evidenze backend: `/tmp/ernie-continuity-20261022/`.
Evidenze iOS: `/tmp/ernie-brain-reliability-20261022/` e
`/tmp/ernie-operating-preferences-20261022/`.
