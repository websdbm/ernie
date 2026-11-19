# Build 123 — Abitudini: luoghi, domande e notifiche

19 novembre 2026. Implementazione e verifiche locali completate. **Non pubblicata**: API e TestFlight
restano alla 122. Nessuna scrittura nei dati personali, nessun invio di prova all’utente durante la diagnosi.

## Problema e correzione

Le schede di luoghi diversi avevano tutte lo stesso titolo generico. Il questionario sceglieva la prima
scheda storica ancora disponibile e chiedeva «qui» senza riferirsi alla data della visita. Una descrizione
salvata senza rinominare la scheda lasciava intatto il titolo segnaposto. La verifica in sola lettura
sull’account interessato ha confermato luoghi distinti e una descrizione salvata; la corrispondenza tra
quella descrizione e il luogo storico resta da confermare con l’utente. Nessun accorpamento automatico.

- Elenco ordinato per ultima sosta, data/ora e conteggio; per le vecchie schede confermate senza nome,
  descrizione fornita dalla persona al posto del segnaposto. Nuove modifiche richiedono un nome utile.
- Domande sulle osservazioni più recenti tra quelle eleggibili, con data e ora esplicite della visita.
  Non presentano una sosta storica come posizione attuale; il riferimento resta quello originale.
- Domanda aperta recuperabile dal server dopo riavvio/cambio processo, senza generare un altro avviso.
- Voce inbox generica creata nella stessa transazione della domanda, poi push APNs ed evento live.
  Nessuna posizione o descrizione nel testo della notifica. Tocco → Abitudini, anche dalla scheda inbox.
- Controllo sul server ogni cinque minuti anche ad app chiusa, senza LLM. Inferenza delle routine ancora
  al massimo una volta al giorno. Una sola domanda aperta, massimo una nuova domanda al giorno,
  rispetto delle ore di quiete, dei limiti globali e degli interruttori per account.
- Push senza ripetizione automatica dopo consegna incerta; in caso di errore resta la domanda/inbox
  sul server. La ricezione reale dipende da APNs e dalle autorizzazioni notifiche dell’iPhone.

## Verifiche

- TypeScript/Biome e controllo diff passati.
- **61 test backend passati**: modello, chat, PostgreSQL reale isolato con RLS, notifiche atomiche,
  letture concorrenti/riavvio, inferenza giornaliera, quiet hours/kill switch, regressioni proattività e
  connessioni manuali Raindrop. Fixture sintetiche, database locale dedicato `127.0.0.1:62204/ernie`.
- **38 test iOS passati** su iPhone 17 simulato iOS 27.2: Abitudini, notifiche/link, widget e rendering
  chiaro/scuro con caratteri grandi. Risultati `/tmp/ernie-habits-questions-final-20261119.xcresult`.
- Test prima della correzione: selezione della sosta più recente falliva; stessa regressione poi passata.
- Anteprime delle righe con soli dati sintetici `habits-places-light.png` / `habits-places-dark.png` nel
  contenitore temporaneo del simulatore. Nessuna chiamata LLM o APNs reale nei test.

## Rilascio

Build 123 nei quattro bundle, changelog e progetto versionati prima dell’archiviazione. Compilazione
per distribuzione dal commit GitHub verificato, con manifest privato di input/hash. Stato archivio e
firma da aggiornare a preparazione conclusa; nessun caricamento effettuato.

Necessario aggiornare **API e iOS**; worker invariato per questa correzione, nessuna migrazione SQL,
nessuna modifica obbligatoria a `.env` o ai consensi. Backup prima del deploy e normale approvazione
esplicita per API/TestFlight. La nuova API comprende anche il codice OAuth Raindrop non ancora
configurato: il pulsante resta nascosto senza i due parametri OAuth; i token manuali sono preservati.
Non sovrascrivere chiavi o configurazioni esistenti e non dichiarare il login OAuth reale verificato.
