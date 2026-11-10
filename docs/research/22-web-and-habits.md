# Ricerca web, abitudini e salute — verifica e protocollo proposto

10 novembre 2026. Analisi richiesta durante la preparazione della build 116. **Nessuna modifica implementata
alla ricerca o al rilevamento degli spostamenti.** Le schede promemoria sono un rilascio separato.
L'estensione Apple Salute descritta sotto non è implementata. Le scelte raccolte definiscono il lavoro
successivo e non attivano raccolte o cambiano impostazioni degli account.

## Ricerca online: stato verificato

- `packages/tools/src/builtins/web.ts`: Firecrawl v2, `web_search` e `web_fetch`.
  Ricerca predefinita di tre risultati, massimo cinque; la ricerca richiede anche il Markdown delle pagine.
  Entrambi i tool restituiscono al modello al massimo i primi 3.000 caratteri per pagina. Non selezionano
  i passaggi in base alla domanda. Query, limit e URL sono gli unici parametri esposti al modello.
- Timeout di 30 secondi, due tentativi totali sugli errori ripetibili; schede con titolo/link e istruzione
  di attribuzione. Nessun parametro esplicito per freschezza, lingua/area, pubblicazione o aggiornamento.
- Staging3: chiave Firecrawl configurata nel container API (valore non letto/stampato), nessuna allow/deny
  list di domini globale. Prova pubblica `site:developer.apple.com WidgetKit`, due risultati: HTTP 200,
  2.937 ms, 4 crediti Firecrawl; testi da 13.971 e 55.271 caratteri prima del taglio applicativo.
  Singola misura del provider, non latenza completa dell’agente o benchmark generale.
- YouTube segue `youtube_read`, con metadati/sottotitoli e lettura video quando necessaria; Instagram non
  è collegato. Le protezioni su contenuti esterni e accessi per account restano necessarie.

### Miglioramenti proposti

1. Politica di attivazione: ricerca per richieste esplicite e fatti variabili; nessuna ricerca per un comando
   locale o un fatto personale già disponibile. Conservare una decisione verificabile “serve il web / no”.
2. Due livelli: risposta rapida con poche fonti; approfondimento con 2–3 query complementari e letture
   indipendenti concorrenti, budget di tempo/fonti/costo. Scegliere una o due fasi in base al compito:
   cercare e leggere tutto insieme è semplice, selezionare prima le pagine può evitare letture inutili.
3. Recupero dei passaggi pertinenti con riferimento alla pagina/sezione, copertura e troncamento espliciti.
   Non sostituire 3.000 con un tetto enorme indiscriminato: mantenere testo completo fuori dal prompt e
   recuperare ciò che serve, compresa una seconda porzione quando mancano evidenze.
4. Preferenza per fonti primarie; data di consultazione, data della fonte se disponibile, confronti e
   divergenze dichiarate. Due siti che ripetono la stessa notizia non sono conferme indipendenti.
5. Freschezza scelta per domanda: lettura aggiornata per stato attuale; cache breve di Ernie per pagine
   stabili, con versione/ora e tasto aggiorna. Firecrawl ha una propria cache: la documentazione indica
   `maxAge` predefinito di due giorni e addebito anche per pagine recuperate dalla cache.
6. Metriche di qualità e p50/p95 prima/dopo, fonti realmente lette, tentativi e consumo. Valutare un secondo
   provider soltanto dopo misurazioni comparative sui casi reali; non duplicare ogni ricerca per default.

Fonti ufficiali consultate:
- [Firecrawl Search](https://docs.firecrawl.dev/features/search): ricerca con/senza estrazione, filtri e due fasi.
- [Firecrawl Scrape](https://docs.firecrawl.dev/features/scrape): `maxAge`, caching e metadati.

## Abitudini: preferenze dell’utente

L’utente vuole apprendimento passivo degli spostamenti e attivo tramite domande, per anticipare necessità.
Ha scelto **storico anche nel backend personale cifrato**. Ha poi chiarito che **consente l’uso della posizione
e del contesto personale con gli LLM esterni**: il requisito è associare correttamente dati e abitudini al suo
account e combinarli nel contesto di Ernie. Questa precisazione supera la proposta iniziale “nessun dato ai
modelli”. Non implica condivisione con altri account/familiari, monitoraggio attivo da subito o invio di tutto
lo storico a ogni richiesta.

L’identità viene dal login e dall’isolamento dei dati per account, non da una deduzione del modello sulle
coordinate. Cifratura a riposo e TLS in transito; backend autorizzato a decifrare e produrre il contesto.
Non chiamarla cifratura end-to-end con chiave esclusivamente sul telefono se il backend deve elaborare.

### Stato attuale

- `DeviceContextProvider.swift`: una posizione all’avvio/ritorno in primo piano o se vecchia; autorizzazione
  “mentre usi l’app”, nessuno storico continuo. Richieste distanziate; reverse geocoding con MapKit.
- `apps/api/src/device-context.ts`: contesto ora/fuso e posizione già disponibile al modello, coordinate
  arrotondate a due decimali; oltre due ore etichettata ultima nota, oltre 24 ore omessa.
- Brain: esistono fatti e routine esplicite; non equivalgono a uno storico di mobilità appreso.
- `packages/automations/src/proactive.ts`: gate riutilizzabile con interruttore, quiete, tetto quotidiano,
  deduplicazione e motivazione/evidenza. Non aggiungere un secondo sistema che lo aggiri.

### Protocollo proposto

**1. Attivazione e controllo.** Skill **Abitudini**, separata dalla skill **Salute** già esistente, con
attivazione/disattivazione per account. “Conosci te stesso” è una possibile pagina di insieme, non un
interruttore che abilita implicitamente entrambe. La precisazione dell'utente è interpretata nel senso
coerente con la richiesta: skill spenta = nessun monitoraggio/apprendimento delle abitudini.
Sezione “Abitudini e spostamenti”, separata dal Brain generico. Opt-in nell’app
prima di richiedere il permesso iOS per il background. Pausa, esclusione di luogo/periodo, rettifica,
cancellazione e durata dello storico. Proposta iniziale: eventi dettagliati per 30 giorni, abitudini finché
utili/confermate; durata da rendere modificabile. Non cambia i permessi delle altre installazioni.

**2. Osservazioni passive.** Visite a luoghi, arrivi/partenze, durata e accuratezza; non GPS continuo con
traccia di ogni strada. Deduplicare gli eventi e gestire quelli parziali/fuori ordine. `CLVisit` è una base
da provare sul dispositivo; Apple descrive tempi approssimati e possibili eventi senza entrambi gli estremi.
Integrare eventualmente cambi significativi/geofence per luoghi confermati. Il sistema non garantisce
copertura completa o precisione al minuto; mostrare buchi e rilevamenti vecchi.

**3. Memoria personale.** Separare `osservazione`, `ipotesi di abitudine`, `conferma dell’utente` e
`eccezione`. Ogni elemento ha user_id, provenienza, intervallo, accuratezza/confidenza e aggiornamento.
Cifratura applicativa dei contenuti con chiavi gestite separatamente dal DB, autenticazione/isolamento per
account, backup cifrati, assenza di coordinate nei log generali. Nessun riversamento nel Brain generale
di tutte le posizioni; collegamenti ai luoghi esistenti attraverso ID dell’account.

**4. Apprendimento.** Conteggi, raggruppamento dei luoghi e finestre orarie calcolati deterministicamente.
Revisione al massimo quotidiana, con giorni distinti e copertura registrata. Un giorno anomalo non cambia
la routine. Soglie da validare, per esempio più giorni su almeno due settimane, non una percentuale LLM
inventata. Correzioni e routine dichiarate dall’utente prevalgono sulle inferenze; ferie, turni e lavoro
da casa sono eccezioni esplicite. Non dedurre motivi sensibili o identità di altre persone dal solo luogo.

**5. Domande attive.** Requisito esplicito: l'utente non deve ricordarsi di insegnare sistematicamente a
Ernie. Un luogo nuovo o frequentato senza significato noto genera una candidata domanda, con evidenza
registrata e priorità per ciò che può migliorare un consiglio. Chiedere dopo una sosta credibile, mai dal
solo transito o con una localizzazione troppo imprecisa; preferire un momento di interazione o il termine
della visita. Non garantire che il telefono rilevi l'arrivo in tempo reale.

Esempio di dialogo (dati fittizi):
- «Ti sei fermato in questo luogo: è un cliente, un luogo personale o una visita occasionale?»
- L'utente: «Sono dal cliente XY; usa l'etichetta Studio Rossi».
- Cercare nei soli clienti/persone/luoghi dell'account. Se c'è un'associazione univoca, collegarla;
  se esistono omonimi, proporre la scelta. Il nome commerciale suggerito da una mappa non identifica
  necessariamente la persona/azienda visitata.
- Salvare luogo → relazione “visita presso” → cliente, etichetta/alias, motivo dichiarato e visita datata.
  Il luogo rimane un nodo; cliente e luogo non diventano la stessa entità e un cliente può avere più sedi.
- Chiedere la frequenza soltanto se ancora utile: «È un appuntamento abituale o occasionale?».
  Una visita occasionale può arricchire il punto di interesse senza creare una routine.

Una domanda alla volta, scelta chiusa con campo libero; «Più tardi», «Non chiedermelo qui», «Non ricordare
questa visita». Quest'ultima non crea fatti o pattern derivati. Domande in sospeso in una scheda dedicata,
senza una notifica per ciascuna visita. Proposta iniziale: una domanda spontanea al giorno (impostazione
regolabile), nel gate già esistente e fuori dalle ore di quiete; le risposte possono avviare chiarimenti
brevi nello stesso scambio. Nessuna ripetizione se ignorata, cooldown per argomento. Preferire la domanda
a indovinare quando cambia un consiglio. La risposta esplicita aggiorna subito l'area interessata; la
revisione globale resta al massimo quotidiana e non serve un LLM per ogni campione di posizione.

**6. Contesto del turno.** Un compositore seleziona posizione attuale/ultima nota, abitudini pertinenti,
calendario/Todo e vincoli confermati. Invia al modello solo ciò che serve, con date, qualità e distinzione
tra osservato e probabile. Esempio fittizio: “A casa, fix di 3 minuti fa. Nei feriali parte per l’ufficio
tra le 8:00 e le 8:20; abitudine confermata. Oggi c’è un appuntamento alle 9:00”. Nessuna trasmissione
automatica dell’intero storico; gli eventuali tool di dettaglio mantengono l’ambito dell’account.

**7. Anticipazione progressiva.** Prima osservare/chiedere, poi suggerire (“vuoi anticipare la partenza?”).
Azioni, messaggi e nuovi promemoria solo se richiesti o entro una regola che l’utente ha attivato. Non
trasformare la memorizzazione di uno sport o di una routine in notifiche indesiderate. Per avvisi tempestivi
usare regole locali/deterministiche quando possibile; l’analisi quotidiana non è un navigatore in tempo reale.

### Ordine di realizzazione e prove

1. Consenso, raccolta minima, archivio cifrato/isolato e pagina con correzione/cancellazione.
2. Collegamento ai luoghi, osservazioni→ipotesi→conferme e domande nel gate proattivo.
3. Compositore del contesto con controlli di pertinenza/freschezza e suggerimenti progressivi.

Test necessari prima dell’attivazione: isolamento tra account, cifratura/backup/rotazione chiavi, revoca e
cancellazione dei derivati, eventi parziali e duplicati, fusi/DST, assenza di fix, deroghe ai pattern,
limiti di domande/token, nessuna notifica implicita, batteria e rilevamento reale con app sospesa.
I test del simulatore non bastano per stimare qualità/batteria della raccolta passiva.

Fonti Apple consultate (anche in versione Markdown ufficiale):
- [CLVisit](https://developer.apple.com/documentation/corelocation/clvisit)
- [startMonitoringVisits](https://developer.apple.com/documentation/corelocation/cllocationmanager/startmonitoringvisits())
- [Aggiornamenti in background](https://developer.apple.com/documentation/corelocation/handling-location-updates-in-the-background)

## Salute, stato personale e contesto

### Decisioni dell'utente del 10 novembre

- Estendere il quadro personale con Apple Salute, referti caricati nel tempo, stato fisico, benessere
  riferito e abitudini. Stessa identità autenticata; accessi separati per account e dominio.
- **Consenso AI continuativo revocabile** per i dati pertinenti della sezione Salute, scelto esplicitamente
  dopo una domanda distinta da quella sulla posizione. Non chiedere di nuovo a ogni analisi nell'ambito
  autorizzato; rendere riconoscibili scopo, dati e fornitore effettivo e gestire cambi sostanziali di ambito.
- Skill dedicate, attivabili e disattivabili. Salute esiste già; estenderla senza creare un secondo archivio
  parallelo o abilitare implicitamente Abitudini. Le impostazioni sono per singolo account.
- Il consenso alla Salute non apre il diario personale: rimane lo sblocco e consenso esplicito già scelto
  per il diario. Nessuna lettura trasversale automatica delle chat archiviate.

### Stato del codice verificato

Esistono `apps/api/src/health.ts`, `packages/brain/src/health.ts`, i tool `health_*`, l'estrattore di
referti e la skill `salute` (attivazione esplicita). Leggono valori di laboratorio da documenti caricati,
salvano report/serie per account e generano note riservate in `Salute/` nel vault. Non risulta alcun client
HealthKit nel sorgente iOS, né relativi entitlement. Questa è una verifica del codice, non una prova
con esami reali o con un dispositivo. Non dichiarare l'archivio già cifrato a livello applicativo:
le note riservate e l'accesso autenticato non sono cifratura dei contenuti.

Prima della nuova sincronizzazione occorre censire dati, originali, estrazioni, note, indici, cache,
cronologia/versioni e backup sanitari esistenti, e migrarli in modo reversibile alla protezione scelta.
Nessuna cancellazione/migrazione effettuata in questa analisi. Correzioni necessarie individuate nel
percorso corrente: se la data dell'esame manca non sostituirla con oggi; non annunciare «tutti
nell'intervallo» quando mancano i riferimenti. Conservare separati data esame, data caricamento e ignoto.

### Collegamento Apple Salute

Modulo HealthKit nell'app principale, inizialmente **sola lettura**, con permessi per ciascuna categoria
richiesta: attività/allenamenti, sonno, frequenza cardiaca, peso e altre misure disponibili e scelte dalla
persona. Disponibilità dipendente dal dispositivo e dalle fonti; niente valori inventati o zero al posto
di dati mancanti. I campioni di stato d'animo, se registrati in Salute e autorizzati, sono una fonte distinta
dalle risposte che la persona dà in Ernie. Le cartelle cliniche FHIR sono un percorso aggiuntivo dove
supportato dall'istituzione; non promettere l'importazione automatica di tutti i referti italiani.

Sincronizzazione incrementale con ID originali, ancore e cancellazioni; retry idempotenti, deduplicazione
tra dispositivi/fonti e aggregazioni coerenti con HealthKit. Non sommare ingenuamente passi o ore di sonno
sovrapposti. Le ancore devono essere isolate per account/dispositivo/tipo; logout/cambio account invalida
code e contesto del precedente. Gli accessi al background hanno limiti e dati protetti possono non essere
leggibili con telefono bloccato: mostrare ultimo aggiornamento e recuperare in seguito, non promettere
tempo reale. L'assenza di risultati non distingue autorizzazione di lettura negata da dati assenti.

Le regole Apple richiedono finalità salute/fitness e limiti specifici alla condivisione con terzi, anche
con consenso. Prima dell'invio HealthKit a un modello verificare idoneità del servizio, uso/ritenzione,
instradamento e condizioni del fornitore: il consenso da solo non autorizza un uso generico illimitato.
Niente fallback silenzioso a un fornitore non coperto. Non salvare dati sanitari in iCloud; mantenere
archivio proprio cifrato e impostare l'esclusione dei dati/copie locali dai backup cloud dell'app.

### Scheda personale utile

Pagina con **riepilogo attuale**, categorie, serie temporali e documenti originali. Ogni dato porta fonte,
data, unità, intervallo del laboratorio se presente, ultimo aggiornamento e stato di verifica.
Per i referti: testo originale, estrazione strutturata, pagina di provenienza, valori incerti da correggere
e riassunto. Le conclusioni del medico rimangono attribuite al referto, separate da una sintesi dell'AI.
Riconoscere il paziente del documento prima di associarlo: un referto caricato dall'utente può appartenere
a un'altra persona. Se dubbio, chiedere; non aggiungerlo automaticamente al profilo dell'account.

Il compositore può combinare abitudini e salute **per uno scopo pertinente di salute/benessere**, rispettando
le skill attive. Dati sanitari esclusi da normali task SSH, lavoro, ricerche generiche e messaggi ad altri.
Statistiche di passi/sonno e selezione del periodo deterministicamente; al modello solo un riepilogo
tracciabile necessario alla domanda. Nessuna supposizione di causalità dal solo andamento congiunto.

Domande attive con la stessa coda e lo stesso budget delle abitudini, senza raddoppiare le interruzioni:
«Il dato di sonno di stanotte sembra incompleto: avevi l'orologio?» oppure «Come ti senti oggi?».
Benessere mentale: autoriferito, osservazioni e dati clinici separati; non diagnosticare depressione,
stress o altre condizioni da geolocalizzazione, sonno o frequenza cardiaca. Per sintesi/andamenti non
modificare terapie né convertire un'anomalia in una diagnosi. Un profilo più ricco rimane parziale e datato.

### Semantica comune degli interruttori

Spegnere la skill ferma raccolta/sincronizzazione dedicata, upload in coda, elaborazioni, domande e uso
automatico del suo contesto. Verificare lo stato anche sul backend e nei job appena prima degli effetti,
non soltanto nascondere il pannello. Sull'iPhone fermare i watcher dedicati quando riceve il cambio;
se offline, il backend deve già rifiutare nuovi upload/lavori e il dispositivo fermarsi alla successiva
sincronizzazione. Non promettere uno stop istantaneo su un telefono offline modificando un altro device.

Conservare lo storico cifrato per consultazione esplicita nella sezione; non eseguire analisi AI con skill
spenta. Cancellazione distinta, comprensiva di derivati e policy di scadenza dei backup. Riattivare non
ricostruisce automaticamente il periodo spento: un eventuale recupero di storia Salute richiede una
scelta esplicita. Le richieste puntuali di posizione delle altre skill restano vincolate al proprio scopo
e non alimentano lo storico Abitudini quando disattivata. Revoca AI ferma i nuovi invii, rimuove contesti
in coda e impedisce nuovi riassunti; non può ritirare richieste già ricevute dal fornitore.

### Ordine proposto

1. Contratto delle skill/consensi, inventario e archivio cifrato, fonti e cancellazione verificabile.
2. Connettori distinti Abitudini e HealthKit, controlli nell'app e sincronizzazione affidabile.
3. Miglioramento dei referti esistenti, scheda personale e domande di apprendimento condivise.
4. Contesto pertinente, analisi AI autorizzate e proattività entro budget misurati.

Prove aggiuntive: revoca durante import/job/upload, cambio account e dispositivo, protezione dei backup,
assenza di salute in ricerca/log/notifiche generici, ancore e cancellazioni, sovrapposizione campioni,
unità/decimali e date mancanti, referto di terzi, copertura parziale esplicita e test HealthKit su iPhone.

Fonti Apple consultate:
- [Autorizzazione HealthKit](https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data)
- [Query incrementali](https://developer.apple.com/documentation/healthkit/executing-anchored-object-queries)
- [Stato d'animo](https://developer.apple.com/documentation/healthkit/hkstateofmind)
- [Cartelle cliniche](https://developer.apple.com/documentation/healthkit/accessing-health-records)
- [Protezione dei dati HealthKit](https://developer.apple.com/documentation/healthkit/protecting-user-privacy)
- [App Review Guidelines, 5.1.2–5.1.3](https://developer.apple.com/app-store/review/guidelines/)
