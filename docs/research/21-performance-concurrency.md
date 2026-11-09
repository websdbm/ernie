# Velocità, compiti paralleli e iniziativa utile

9 novembre 2026. Implementazione destinata alla build 115; stato del rilascio in
[build-115.md](../releases/build-115.md). Non confondere codice verificato con deploy effettuato.

## Punto di partenza misurato

Lettura aggregata, senza testi delle conversazioni, delle osservazioni degli ultimi sette giorni su staging3:

| Misura | Campione | Mediana | 95° percentile |
|---|---:|---:|---:|
| Primo contenuto visibile, iOS 114 | 14 turni completati | 3.481 ms | 35.746 ms |
| Primo contenuto, server | 16 turni completati | 3.059 ms | 22.766 ms |
| Preparazione contesto, server | medesima finestra | 471 ms | non usato |
| Preparazione agente, server | medesima finestra | 40 ms | non usato |
| Instradamento, server | medesima finestra | 360 ms | non usato |

I campioni client/server non sono coppie abbinate; non sottrarre le mediane per stimare la rete.
Campione piccolo, soli completati: non dimostra una percentuale generale di miglioramento, né copre gli errori.
Il margine ordinario prima del modello è nell'ordine di centinaia di millisecondi. Le attese più lunghe
richiedono osservazione per classe/modello/tool, tempi di coda e fallimenti; non si risolvono soltanto col layout.

## Interventi realizzati

- Preparazione dell'agente sovrapposta alle letture indipendenti del contesto. Settings/skill in parallelo;
  richieste contemporanee per lo stesso account condividono il caricamento iniziale, con invalidazione sicura.
- Primo frammento di testo immediato; quelli successivi raggruppati entro 30 ms o 1.024 caratteri. Prima di
  eventi non testuali, fine, errore e annullamento si svuota il buffer. Nel test sintetico 101 frammenti
  diventano due emissioni con testo identico: misura del trasporto, non del tempo totale dell'LLM.
- La fine del turno libera subito il posto al turno successivo. Espressione facciale e lavoro opzionale
  successivo non trattengono la richiesta e un loro errore non trasforma una risposta conclusa in fallita.
- Codifica/scrittura delle conversazioni iOS su coda dedicata; letture, eliminazione e logout hanno una
  barriera per evitare dati obsoleti e ricomparsa di file eliminati.

## Precisazione o nuovo incarico

Fino a tre sessioni aperte nell'app, con transcript, connessione, richiesta, recupero e audio distinti.
La barra dei compiti consente di cambiare vista senza annullare gli altri. Solo quello visibile parla.
Il microfono può raccogliere un nuovo contributo mentre un compito lavora; Stop rimane un'azione distinta.

Quando arriva un messaggio durante una richiesta, `POST /v1/tasks/resolve` usa il modello light su testo e
titoli dei compiti attivi, senza strumenti né lettura di transcript, Brain, diario o archivio. Esiti:

1. Precisazione certa: `user.steer` al compito individuato; se non disponibile rimane nella coda della stessa sessione.
2. Incarico autonomo certo: nuova sessione, visibile e indipendente.
3. Referente ambiguo, richiesta mista, dipendenza o stessa risorsa modificabile: domanda con pulsanti.
   L'utente può aggiungere al compito, avviarne un altro, rimandare o modificare il messaggio.

Soglia conservativa 0,92, ID validati, tre candidati al massimo. Il risultato vale per gli esatti turni
osservati all'avvio: se nel frattempo cambiano, resta la scelta manuale. Timeout 3,5 s, nessun retry LLM;
limite di 12 analisi/minuto per account e una in corso nel processo. La chiamata consuma token solo in questo
caso, passa dal budget e dal registro consumi. Il messaggio resta recuperabile con errore, rete assente,
backend precedente o capacità piena. Richieste ancora da assegnare salvate in file protetto per credenziali;
logout le elimina. Gli allegati richiedono una scelta esplicita, senza presumere dal solo testo il contenuto.

Diario e riferimenti all'Archivio chat sono intercettati prima di questo percorso; restano nei loro ambiti.
Le scritture dei tool vengono serializzate per account dopo l'approvazione. Le letture restano parallele.
Una scrittura scaduta non libera la coda finché l'operazione sottostante non termina; non viene ritentata
automaticamente. Operazioni in coda annullate/scadute non partono più tardi. La protezione è locale al processo:
non sostituisce revisioni, transazioni e idempotenza fra API, worker o repliche, né annulla effetti già avviati.
Il limite di tre è dell'app, non un limite globale fra diversi dispositivi dello stesso account.

### Prova del classificatore reale

Quattro prompt sintetici, Haiku 5.5 configurato, ragionamento aggiuntivo disattivato solo per questa analisi:

| Compito e nuovo messaggio | Esito verificato | Latenza |
|---|---|---:|
| Piano cena → siamo in quattro, uno vegetariano | precisazione | 2.348 ms |
| Diagnosi sito → meteo di domani | nuovo compito | 1.131 ms |
| Due liste → aggiungilo anche a quella lista | scelta | 1.186 ms |
| Riordina lista → rinomina la stessa lista | scelta | 963 ms |

33–64 token di output, zero token di ragionamento nei quattro casi; input 839–888 token. Il primo campione
con ragionamento implicito aveva raggiunto due volte la scadenza. Questa prova non misura l'accuratezza
generale; ampliare il corpus con dettatura, riferimenti misti, omonimi e correzioni arrivate a fine turno.

## Proattività e strumenti

La proattività utile anticipa un controllo pertinente alla richiesta, presenta alternative quando manca
un dato e propone il passo successivo. Non introduce polling AI, nuove notifiche, scritture o letture di
archivi privati non richieste. Restano i limiti già stabiliti per heartbeat e consolidamento del Brain.

Implementato `time_windows`: aritmetica deterministica su intervalli ISO con fuso, durata, margini espliciti,
sovrapposizioni e finestre libere. Non legge autonomamente calendari, non salva, non inventa trasferimenti
o disponibilità. Il modello raccoglie prima gli impegni pertinenti con i tool autorizzati e presenta le
alternative; i risultati dichiarano che la copertura dipende dagli intervalli ricevuti. Nessun LLM interno.

Prossimi strumenti da costruire, in ordine di rendimento atteso, non ancora implementati in questa versione:

| Strumento | Lavoro deterministico | Risparmio atteso / condizione |
|---|---|---|
| `day_snapshot` | Lettura parallela di impegni e Todo dell'intervallo richiesto, deduplica con ID, fuso, fonte e copertura | Una risposta compatta al posto di più chiamate; niente diario o chat importate |
| `resolve_target` | Ricerca fra liste, persone, luoghi o siti del catalogo autorizzato, candidati con ID e motivi | Evita tentativi su nomi inventati; mai unione automatica degli omonimi |
| `change_preview` / `change_apply` | Patch tipizzata su oggetti versionati, conflitti, differenza prima/dopo, applicazione idempotente | Meno riscritture complete e duplicati; versioni indispensabili per concorrenza fra dispositivi |
| `read_sources` | Lettura in batch di URL supportati con timeout, cache breve e limiti per fonte | Evita richieste sequenziali e reinvio di pagine intere; conserva provenienza e contenuto non fidato |
| `check_result` | Verifica dell'oggetto realmente salvato rispetto alla richiesta tipizzata | Evita «fatto» senza scheda; espone completato/parziale/non verificato senza una seconda lunga generazione |

Prima di aggiungere ogni tool: misurare chiamate, token e latenza nel relativo flusso; preferire estendere
un tool esistente a esporre molti sinonimi al modello. Non ridurre indiscriminatamente il modello per SSH
o le verifiche sui dati: l'utente ha richiesto accuratezza maggiore per le operazioni delicate.

## Interfaccia e verifiche

Stile condiviso per azioni primarie, secondarie e distruttive; area minima 44 punti, etichette a capo,
stati disabilitati/pressione distinguibili, font semantici e layout accessibili. Applicato a schede chat,
scelte, ricette, Todo, promemoria, Brain e Archivio chat. Native toolbar/menu mantengono il comportamento iOS.
Le palette dei travestimenti e la tipografia Borg rimangono. Il selettore dei compiti distingue stato e titolo.

111 test backend in dieci suite, TypeScript e Biome. 47 test iOS in cinque suite sul simulatore dedicato
del Mac Studio; rendering chiaro/scuro/Borg/caratteri accessibili, preservazione messaggi, isolamento sessioni,
cancellazione, risultato in ritardo, cronologia, voce e confini Archivio/diario.
La prova su iPhone fisico con dettatura e rete mobile resta una verifica del rilascio, non svolta qui.
