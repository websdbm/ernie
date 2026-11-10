# Chiusura punti aperti — primo gruppo, 10 novembre 2026

Sorgenti destinati alla build 118 e all'API associata. Stato effettivo della distribuzione in
[HANDOFF](../HANDOFF.md) e [build 118](../releases/build-118.md). Questo documento non dichiara completate
Abitudini, HealthKit, cifratura integrale Salute o analisi generale delle immagini.

## Ricerca web

`web_search` e `web_fetch` conservano risultati/pagina, titolo, URL e testo. Aggiungono passaggi selezionati
localmente per parole e intestazioni, posizione nel testo pulito, hash e copertura. Una domanda su una parte
in fondo alla pagina può quindi recuperarla senza inviare al modello tutto il documento. Ranking lessicale:
non garantisce di individuare sinonimi o il passaggio decisivo se il testo estratto è incompleto.

`read_sources` legge fino a cinque URL, massimo tre in parallelo; errori separati per fonte, 10 secondi per
lettura e 25 complessivi, budget testuale predefinito 9.000 caratteri (massimo 12.000). Nessun accesso a diario
o archivi chat. Fonti esterne rimangono non fidate anche in cache; controllo genitori comprende il nuovo tool.

Cache RAM isolata per account/URL/lingua/paese, cinque minuti, 12 pagine per account, 96 globali, massimo quattro
milioni di caratteri. Si trattengono fino a 200.000 caratteri per pagina; la copertura dichiara i tagli.
`web_fetch` può continuare con `nextOffset` e `contentId`: un cambio della fonte richiede una nuova lettura.
`refresh` ignora la cache e chiede `maxAge=0` al provider. `retrievedAt` è il recupero, non la pubblicazione.
I parametri di periodo `tbs`, paese e preferenza linguistica sono verificati nelle API ufficiali
[Search](https://docs.firecrawl.dev/api-reference/endpoint/search) e
[Scrape](https://docs.firecrawl.dev/api-reference/endpoint/scrape).

Test del batch con cinque risposte simulate da 100 ms: 200 ms, massimo tre simultanee, rispetto ai 500 ms
seriali. Misura dell'orchestrazione, non promessa di velocità su internet o dell'LLM. Nessuna chiamata
Firecrawl reale in questa verifica; restano da raccogliere misure di produzione dopo il rilascio.

## Strumenti comuni, prima versione

- `day_snapshot`: letture parallele di Todo del giorno, prossimi promemoria e routine Brain. Data relativa
  calcolata nel fuso del telefono; avviso distinto dall'appuntamento. Non legge il calendario iOS dal vivo,
  esclude note riservate e dichiara che i promemoria coprono solo le prossime occorrenze attive. Non fonde
  titoli uguali e non deduce disponibilità dai vuoti. Un errore o una revoca esclude la fonte, senza trasformarla
  in «nessun impegno».
- `resolve_target`: ID e candidati reali per liste, persone, luoghi e siti. Solo un nome esatto univoco risolve
  direttamente; suggerimenti, omonimi e cataloghi parziali richiedono scelta. SSH conserva il requisito di
  modello avanzato. Nessuna creazione o unione implicita.
- `change_preview` / `change_apply`: patch limitata ai campi indicati di liste e attività Todo esistenti.
  Revisione e stato iniziale, differenza, prova firmata per account/conversazione con scadenza di dieci minuti;
  dopo un riavvio serve nuova anteprima. La prova non sostituisce autorizzazione o approvazione. Applicazione
  atomica con il repository versionato, retry idempotente, rilettura dell'esito e rispetto dell'annullamento.
  Le aggiunte restano su `todo_save`, con ID stabili. La conversione a lista semplice elimina gli orari e gli
  avvisi nella stessa trasformazione, conservando attività e dipendenze.
  Anteprima limitata a 6.000 caratteri di differenze e 20 campi; valori lunghi abbreviati, totale/omissioni
  espliciti e prova integra. L'abbreviazione non deve essere presentata come revisione integrale: per dettagli
  si rilegge la lista o si preparano patch più piccole. Regressione verificata anche attraverso l'executor.
- `check_result`: rilegge una lista Todo e controlla i campi richiesti; esiti verificato/parziale/mancante.
  L'estensione delle modifiche/verifiche ad altri domini rimane futura; questi tool non sono esecutori generici.

Tutti i nuovi strumenti hanno etichette italiane. Skill/kill switch/controllo genitori controllati in esecuzione;
nessuna estensione automatica dei permessi. Test reali PostgreSQL provano isolamento degli account, revisioni,
storico, retry e rifiuto di una modifica concorrente. Non è stata misurata una riduzione generale dei token LLM.

## Inventario SSH

Menu nei dettagli server/sito, conferma delle conseguenze, avanzamento ed errore. La rimozione riguarda
l'inventario Ernie: il server remoto non viene spento, modificato o eliminato. Per un server si rimuovono
anche siti collegati e storico delle sue operazioni; la chiave già installata sull'host non è revocata.

Il nuovo client invia la revisione del server e lo snapshot completo dei siti mostrati nella conferma.
Il backend confronta sotto lock, prima di qualunque rimozione: una variazione su un altro dispositivo
restituisce `409 inventory_changed`. Serve aggiornare e riconfermare. Operazioni in corso bloccano la
rimozione, risposte tardive non ripristinano dati rimossi, errori non vengono ritentati automaticamente.
Client vecchi senza precondizione compatibili. Distribuire l'API prima del client 118.

## Accuratezza dei referti e residui storici

La migrazione 0051 rende nullable `health_reports.taken_on`; non cambia date già memorizzate. Data mancante
o invalida rimane ignota, non diventa la data del caricamento. Referti consultabili per ID e valori conservati;
le misure senza data non diventano «ultime» e non entrano in trend/confronti temporali. I percorsi delle note
senza data restano distinti. Nell'app appare «Data non disponibile».

Intervalli di riferimento assenti, multipli/qualificati o invertiti non vengono interpretati scegliendo un
valore arbitrario. I riepiloghi distinguono confrontabili e non determinabili; non dichiarano tutti i valori
nella norma quando mancano i riferimenti. Le vecchie date e interpretazioni non vengono riscritte senza fonte.
Originali, indice e vault hanno ancora la protezione precedente: **questa modifica non è la cifratura Salute**.

### Inventario per il prossimo incremento Salute

Review del solo codice, senza leggere dati sanitari reali. La migrazione deve comprendere:

- Foto/miniature/OCR in `media_items`: `DocumentComposer` carica le foto prima del documento. Oggi manca il
  collegamento esplicito documento–media–referto–note, necessario per una cancellazione coordinata.
- Testi, pagine, prodotti e schemi in `documents`; `document_chunks` con testo, embedding e ricerca testuale.
- `health_reports`, `health_values`, `health_notices`; note `Salute/*.md`, indice `brain_notes` e `brain_chunks`.
- Tutte le revisioni del vault Git locale/remoto; conversazioni Mastra, riepiloghi, replay Redis (24 ore),
  cache chat iOS e anteprime degli argomenti nei log tool. `llm_calls` conserva metadati/costi, non prompt.
- Backup precedenti: archivio finale protetto con age, ma contiene database, vault con cronologia e Redis.
  L'inventario delle copie deve precedere qualunque dichiarazione di bonifica.

La revoca AI deve fermare estrazione **e** embedding documenti, embedding delle note private, catalogazione
Media, ricerca generica dei documenti/Brain e avvisi sanitari inseriti nel contesto. Vanno esclusi anche
risultati in volo dopo la revoca. Disabilitare il solo estrattore non copre questi percorsi.

Gap preesistente registrato per R4: `documents.remove` svuota testo/pagine ma conserva prodotti, schemi e
chunks; la ricerca chunks non filtra i documenti eliminati. Il solo stato `deleted` non prova cancellazione
dei derivati. Occorrono lineage, cancellazione coordinata e test che nessun passaggio rimanga ricercabile.

Obsidian legge Markdown in chiaro: cifrare anche vault/remoto richiede lettore/plugin che decifra sul
dispositivo o esportazione locale esplicita fuori sincronizzazione. Non promettere cifratura integrale
mantenendo invariata una sincronizzazione di Markdown leggibile. Queste protezioni non sono nella 118.

Il tetto giornaliero delle automazioni ora usa il fuso della singola automazione, con confini di giorno locale;
non una durata fissa di 24 ore o il giorno UTC. Prova PostgreSQL prima rossa e poi verde sui due confini e su RLS.

## Prerequisiti conservati

Le nove foto ricetta non risultano più nei percorsi originali del Mac né nel percorso equivalente del Mac Studio;
non si può ricostruire fedelmente la trascrizione né attestare un'importazione dai soli nomi dei file.
Non sono state create ricette sostitutive. Contabo richiede ancora la password API, YouTube la chiave Data API.
Instagram e intervento sulla rete del VPS restano sospesi per scelta dell'utente.
