# 12 — Second brain

> Stato: **B1, B2 e B3 realizzate** (13–14 ottobre 2026): `packages/brain`, migrazione 0028, tool `brain_*`, pagine-concetto, suggerimenti e travaso dalla memoria, viste Elenco, Tempo e Mappa, menu ⋯ › Second brain nell'app. Repository privato `websdbm/ernie-brain`, aperto con Obsidian sul Mac in `~/Documents/Obsidian/ernie-brain` (plugin Git: pull e commit ogni 5 minuti). B3: vedi §10.
> Richiesta iniziale: «una seconda memoria esplicita che può comunicare con la memoria di Ernie e travasare da lì contenuti, o posso metterci io contenuti in vari modi, ad es. caricando file; struttura di un wiki, navigabile sia da me che da Ernie».

## 1. Decisioni dell'utente

| Tema | Decisione |
|---|---|
| Cosa ci va | Qualunque cosa: archivio di casa, note e idee, studio, persone e famiglia. «Può essere qualunque cosa che vado ad annotare in diversi modi.» |
| Tempo e spazio | Ogni contenuto ha un **quando** e un **dove**. Il dove vale sia come luogo fisico sia come posto nella mappa delle idee. |
| Richiamo | Diretto (lo chiedo io) e **suggerito** da Ernie in conversazione con un cenno breve, quando ha senso. |
| Libertà di Ernie | **Libero**: crea, collega, riorganizza e riscrive, con la cronologia per tornare indietro. |
| Travaso dalla memoria | **Lo propone Ernie** («ho 12 cose su Giorgio, ne faccio una pagina?»), tu accetti o scarti. |
| Dove si legge e si scrive | App di Ernie e **Obsidian**, tramite un **repository git privato**. |
| Primi modi di inserimento | **Voce o chat** («annota che…») e **foto e scansioni** con l'OCR sul telefono. |
| Famiglia | **Solo tuo**: ognuno ha il proprio, Giorgio compreso. |
| Scheda anagrafica | Diventa la pagina **«Chi sono»**; i familiari diventano pagine-persona. |
| Note delicate | **Pagine riservate**: usate solo se le chiedi esplicitamente, mai nei suggerimenti. |
| Nome | **Second brain**. |

## 2. Il modello: note in un grafo, con tempo e luogo

Ogni elemento è una **nota** (una pagina markdown). Le note sono di pochi tipi, perché Ernie sappia trattarle e Obsidian le mostri bene:

- **nota**: un pensiero, un'idea, un appunto («annota che…»);
- **documento**: il testo letto da una foto o da un PDF, con le pagine e un riassunto;
- **persona**, **luogo**, **progetto**, **argomento**: le pagine-concetto a cui le altre si collegano.

Ogni nota ha in testa i suoi dati (frontmatter YAML, letto anche da Obsidian):

```yaml
tipo: nota
creata: 2026-10-13T14:05
riguarda: 2026-10-14          # quando accade o a quando si riferisce (anche un intervallo)
luogo: Padova                  # nome leggibile
coordinate: [45.41, 11.88]     # dal telefono, circa 1 km
collegamenti: ["[[Giorgio]]", "[[Scuola]]"]
riservata: false
fonte: chat                    # chat, voce, foto, pdf, memoria
```

- **Tempo.** Ci sono due date: quando la nota nasce e a quando si riferisce. Si può chiedere «cosa avevo annotato a marzo?» oppure «cosa c'è in programma la settimana prossima?».
- **Luogo fisico.** Viene preso dalla posizione del telefono al momento dell'annotazione (la stessa della versione 1.10 del protocollo), oppure dal luogo detto. Così si può chiedere «cosa avevo annotato a Verona?» e vedere le note su una mappa.
- **Mappa delle idee.** I collegamenti `[[…]]` formano il grafo, che Obsidian disegna già. Ernie aggiunge i collegamenti quando riconosce persone, luoghi, progetti e argomenti, e crea la pagina-concetto se manca.

## 3. Dove stanno i dati: git per te, Postgres per Ernie

- **Fonte di verità: un repository git privato** con una cartella di file markdown, il vault di Obsidian. Ogni modifica di Ernie è un commit con un messaggio leggibile («Ernie: collegata la nota sulla gita a [[Giorgio]]»). Tornare indietro è un `revert`, ed è questo che rende accettabile la mano libera.
- **Indice per Ernie in Postgres.** Contiene pezzi con vettori e full-text (la stessa ricerca ibrida dei documenti), date, coordinate e grafo dei collegamenti. È ricostruibile dal repository in qualunque momento.
- **Sincronizzazione.** Il server fa pull ogni pochi minuti e reindicizza i file cambiati. Scrive e fa push subito dopo ogni sua modifica. Obsidian sul Mac usa il plugin Git. Se tu ed Ernie modificate lo stesso file nello stesso momento, si tengono entrambe le versioni e Ernie te lo segnala.
- **Allegati.** Gli originali di foto e PDF non vanno sul server, come già oggi: nel vault c'è il testo letto con l'OCR. Se vuoi conservare l'originale, lo metti tu nel vault da Obsidian.

## 4. Come entrano i contenuti (prima fase)

1. **Voce o chat.** «Annota che il codice della caldaia è 4471», «metti nel second brain che a Giorgio piacciono i Lego Technic». Ernie decide tipo, data di riferimento, luogo e collegamenti, poi conferma in una riga: «Annotato in [[Casa]], collegato a [[Caldaia]]».
2. **Foto e scansioni.** Si usa la catena dei documenti già pronta: OCR sul telefono, pezzi con pagina, citazioni verificate. Il documento diventa una nota di tipo documento, con il riassunto e i collegamenti.
3. **Travaso dalla memoria.** Ernie raggruppa i ricordi sparsi sullo stesso tema e propone una pagina. Dopo il travaso, i ricordi restano con un rimando alla pagina.

Condividi da altre app e inoltro email vengono dopo.

## 5. Come Ernie lo usa

- **Richiamo diretto.** Strumenti `brain_search`, `brain_read`, `brain_write`, `brain_link`, con filtri per tempo, luogo, tipo e collegamenti. Ernie cita la nota come oggi cita le pagine dei documenti, con una scheda «Fonti».
- **Suggerimento in contesto.** A ogni turno una ricerca veloce, senza modello, trova le note pertinenti. Se una supera la soglia, nel contesto del turno arriva un cenno, e Ernie lo dice in una riga: «Ho una nota su questo dell'anno scorso, vuoi che la riprenda?». Al massimo una volta per argomento per conversazione. Mai le pagine riservate.
- **Pagine riservate.** Non entrano nella ricerca dei suggerimenti né nel contesto automatico. Ernie le legge solo se nomini la pagina o chiedi esplicitamente di cercare tra le riservate.
- **«Chi sono».** È la scheda anagrafica resa come pagina e resta in cima al contesto di Ernie. Una modifica alla pagina in Obsidian aggiorna la scheda, e viceversa. Giorgio, Laura e gli altri familiari diventano pagine-persona a cui collegare note, regali e ricorrenze.
- **Memoria e second brain.** La memoria resta l'annotazione automatica e veloce. Il second brain è il posto ordinato. In caso di contrasto vale il second brain, come già vale la scheda sui ricordi.

## 6. Fasi

1. **B1, il cuore.** (fatta) Repository git e indice; note con tempo, luogo e collegamenti; «annota che…» da chat e voce; documenti da foto; ricerca e citazioni; pagina «Chi sono»; scheda iOS per sfogliare, cercare e leggere.
2. **B2, il grafo vivo.** (fatta) Pagine-concetto create da Ernie, travaso proposto dalla memoria, suggerimenti in conversazione, pagine riservate, mappa dei luoghi e linea del tempo nell'app.
3. **B3, apertura.** Condividi da altre app, inoltro email, modifica delle note dall'app, riorganizzazioni proposte da Ernie («queste 8 note sulla caldaia: le unisco?»).

## 7. Obsidian sul Mac

1. In Obsidian: «Apri cartella come vault» → `~/Documents/Obsidian/ernie-brain`.
2. Impostazioni › Plugin della community › Sfoglia → «Git» (Vinzent03) → Installa e Attiva.
3. Nelle opzioni del plugin: «Auto pull interval» e «Auto commit-and-sync interval» a 5 minuti, «Pull on startup» attivo.

Il server sincronizza ogni 5 minuti; in caso di modifiche contemporanee allo stesso file vince la versione di Obsidian e quella di Ernie resta nella cronologia git.

## 8. Decisioni prese prima di partire (13 ott 2026)

- **Repository.** Va creato un repository GitHub privato sul tuo account `websdbm`, per esempio `ernie-brain`. Il server di staging3 ha bisogno di una chiave di deploy con permesso di scrittura solo su quel repository. Sono azioni sul tuo account: le preparo io, ma servono il tuo via libera e il tuo controllo sulla chiave.
- **Obsidian sul Mac** con il plugin Git, configurato una volta. Su iPhone il plugin funziona male, ma lì c'è l'app di Ernie.
- **Il modello vede le note.** Ricerca e citazioni mandano al modello AI i pezzi pertinenti, come oggi con i documenti. Le riservate no, salvo tua richiesta esplicita.

## 9. Sezione salute (13 ott 2026)

Richiesta dell'utente: salvare analisi del sangue ed esami in una parte sensibile del wiki e confrontare i valori tra
un'analisi e l'altra. Decisioni: archivio anche in Obsidian; lettura automatica a ogni caricamento; confronti e
andamenti, spiegazioni prudenti, avvisi spontanei e una «tabellina» riconoscibile quando si chiede un parametro.

- **Dati**: migrazione 0029 (`health_reports`, `health_values`, `health_notices`, RLS). I numeri stanno in Postgres; le
  note leggibili nel vault, cartella `Salute/` (riservate): `Salute/Analisi/<Analisi del sangue del 7 ottobre 2026>.md`,
  `Salute/Parametri/<Glicemia>.md` con lo storico, `Salute/Salute.md` come indice. Sono pagine generate: a ogni referto
  si riscrivono (le modifiche fatte in Obsidian lì si perdono).
- **Lettura**: al caricamento di un documento, se il testo sembra un referto (unità di misura tipiche + parole da
  referto), il modello standard estrae le righe come scritte (schema largo, sezione sangue/urine); i controlli sono
  deterministici in `@ernie/brain/health`: nomi dei parametri con sinonimi (GOT = AST, glucosio = glicemia…), numeri con
  la virgola, intervalli («70 - 110», «< 200», «fino a 35»; al limite esatto di «< N» il valore è fuori), formula
  leucocitaria in % separata dall'assoluto, urine separate dal sangue. Misura (`packages/agent-core/scripts/
  health-extract-quality.ts`): 26/26 valori su un referto di prova, circa 1,4 centesimi a referto.
- **Uso**: tool `health_parameter`, `health_report` (confronto con la precedente o con una data), `health_overview`,
  `health_import` (per un documento già caricato); skill guidata «Salute» (spiegazioni prudenti, niente diagnosi né
  terapie, il medico per i fuori intervallo). Blocco di protocollo `health` (v1.12) = la tabellina nell'app, con grafico
  dello storico.
- **Avvisi**: dopo un referto, un riepilogo («Ho letto il referto…») e, se è l'analisi più recente, i fuori intervallo
  con i valori precedenti e i peggioramenti da tre analisi vicino al limite; detti una volta al turno successivo. Un
  referto più recente rende superati gli avvisi non ancora detti dei precedenti.

## 10. B3, apertura (14 ottobre 2026)

- **Modifica dall'app.** Nella scheda di una nota: Modifica (testo e riservatezza) ed Elimina; «+» per una nota nuova
  (titolo, tipo, testo). Le pagine generate («Chi sono», Salute) non si toccano. API: `POST /v1/brain/notes`,
  `PATCH /v1/brain/note`, `DELETE /v1/brain/note`. Fonte `app`.
- **Condividi da altre app.** Estensione «Ernie» nel foglio di condivisione di iOS: link e testi arrivano subito
  (`POST /v1/brain/share`; i link vengono letti con Firecrawl e la nota ha titolo, fonte e testo della pagina); foto e
  PDF finiscono in una cassetta dell'App Group e l'app, alla riapertura, li prepara come documento con la frase
  «Metti questo documento nel second brain» già pronta. Fonte `condiviso`. L'estensione legge le credenziali dal
  Keychain condiviso (`76X78MBPR3.com.websdbm.ernie`, con migrazione dal vecchio elemento).
- **Inoltro email.** Indirizzo personale `<token>@brain.ernie.staging3.eklettica.it` (Second brain › ⋯ › Inoltra email);
  Brevo riceve la posta del sottodominio (record MX `inbound1.sendinblue.com` 10 e `inbound2.sendinblue.com` 20,
  dominio verificato in Brevo) e chiama `POST /v1/brain/inbound/email?key=…`. Si accettano solo messaggi il cui
  mittente è l'email della scheda; il token → utente passa da `brain_inbox_user` (migrazione 0031). Fonte `email`;
  allegati elencati, non scaricati. Variabili: `BRAIN_INBOUND_SECRET`, `BRAIN_INBOUND_DOMAIN`.
- **Riordino proposto da Ernie.** Se almeno 5 note sono collegate alla stessa pagina-concetto, al turno successivo
  Ernie propone in una riga di riunirle («Ho 8 note sulla caldaia: le unisco?»), una volta ogni 30 giorni per pagina.
  Solo dopo il sì chiama `brain_merge`: una sezione per nota con la data, le originali spariscono (restano nella
  cronologia git) e le note che le citavano ora citano la pagina.
