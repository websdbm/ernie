# Regole operative del progetto Ernie

## Handoff sempre aggiornato

Sul progetto lavorano più agenti (Mac Studio e Mac dell'ufficio). Prima di iniziare: `git fetch`, leggere
[docs/HANDOFF.md](docs/HANDOFF.md) e l'ultima nota in `docs/releases/`. A fine sessione aggiornare `docs/HANDOFF.md`
(stato pubblicato, cosa è cambiato, lavori aperti) e pubblicarlo su GitHub insieme alle modifiche: è una richiesta
dell'utente. Il server si aggiorna da git, non copiando file (vedi HANDOFF, «Server»).

## Ogni nuova build deve essere riproducibile da GitHub

Questa regola è richiesta dall'utente e vale per ogni aggiornamento di build
destinato a installazione, distribuzione o TestFlight, anche quando si compila
su un altro Mac o con una procedura manuale.

1. Aggiornare il numero di build e il relativo changelog. Includere in Git tutti
   gli input necessari: sorgenti, risorse e sprite, progetto Xcode, estensioni,
   configurazioni condivisibili, script e documentazione pertinente. Se il
   rilascio richiede modifiche backend o contratti condivisi, versionare anche
   quelle dipendenze, distinguendo il loro deployment dalla build iOS.
2. Verificare le modifiche, creare un commit e pubblicarlo su GitHub prima del
   caricamento o della distribuzione della build. Verificare il SHA remoto:
   un commit solo locale non soddisfa la regola. Usare il ramo di rilascio
   concordato (attualmente `main`), senza force push.
3. Compilare dal commit pubblicato, preferibilmente da un checkout pulito.
   Su Mac Studio recuperare quel commit e verificare che sorgenti e risorse
   usati corrispondano. Se si riusa un archivio già compilato, dimostrarne la
   corrispondenza mediante manifest e hash; altrimenti ricompilare.
4. Registrare nel riepilogo del rilascio e nella documentazione pertinente il
   numero di build, il commit GitHub, le verifiche eseguite e lo stato effettivo
   della distribuzione. Pubblicare anche gli aggiornamenti finali di documentazione;
   il commit dei sorgenti della build deve restare identificabile.
5. Se il push o la verifica remota falliscono, risolvere il problema prima della
   distribuzione. Non dichiarare completato il rilascio con GitHub arretrato;
   segnalare chiaramente l'eventuale impedimento.

Non aggiungere credenziali, chiavi private, certificati, profili di firma,
`.env`, dati personali o artefatti di compilazione. Selezionare esplicitamente
i file del rilascio; conservare le modifiche estranee senza includerle alla
cieca, scartarle o sovrascrivere il lavoro presente su altri Mac.

Le compilazioni temporanee per test e le anteprime locali non richiedono un
nuovo commit o push a ogni esecuzione; la regola si applica alla build aggiornata
che viene consegnata o distribuita.
