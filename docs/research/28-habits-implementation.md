# Abitudini — implementazione e revisione

10 novembre 2026. Skill separata, inizialmente spenta. Sorgenti in lavorazione; nessuna pubblicazione
API, migrazione remota o build distribuita per questa funzione. Apple Salute resta un passo successivo.

## Flusso

Attivazione skill per account e consenso esplicito **sul singolo iPhone**. Il permesso Sempre di iOS
abilita le visite Core Location: soste approssimative, non percorsi GPS continui. Un nuovo dispositivo
non inizia la raccolta perché l'account o iOS hanno già autorizzato un altro uso della posizione.
La coda locale AES-GCM ha chiave ThisDeviceOnly nel gruppo privato dell'app, escluso dalle estensioni;
file esclusi dai backup. La pausa viene persistita prima della cancellazione per impedire la ripresa
anche se file o Portachiavi risultano temporaneamente inaccessibili. Lease locale di 24 ore senza server.
La revoca offline sugli altri dispositivi viene recepita alla sincronizzazione: non è istantanea.

Backend: archivio per account cifrato con chiave **HABITS_ENCRYPTION_KEYS**, distinta da Salute,
formato keyring uguale a HEALTH_ENCRYPTION_KEYS. Non generare o versionare chiavi nei sorgenti.
AES-256-GCM/HKDF, AAD account/risorsa/revisione, RLS forzata e transazioni serializzate per account.
Migrazione **0054_habits.sql**, ancora solo locale. Il backend può decifrare: **non è E2EE**.
Retention selezionabile 7/30/90 giorni; manutenzione oraria e inferenza deterministica al massimo una
volta al giorno (giorno stabile Europe/Rome). Visite scadute e luoghi non confermati orfani vengono rimossi;
le descrizioni confermate rimangono finché eliminate. Le aree escluse mantengono coordinate per poterle
ignorare. Per eliminare anche queste, usare Elimina tutti i dati.

Le visite equivalenti tra dispositivi si fondono; gli alias conosciuti sono conservati per impedire che
un retry faccia ricomparire una visita dimenticata. Tombstone di soli ID per 90 giorni, poi eliminate.
Osservazioni imprecise o brevi non generano luoghi/routine. Una routine richiede almeno tre giorni distinti,
lo stesso giorno settimanale, un intervallo di almeno 14 giorni e orari sufficientemente vicini.
Le ipotesi sono separate dalle descrizioni confermate; nessun impegno o promemoria creato automaticamente.

## App e contesto

Sezione Abitudini nel pannello: stato, pausa, retention, consenso AI separato, luoghi modificabili,
mappa approssimativa, ipotesi e soste recenti, rinvio/esclusione/cancellazione. Invito discreto in chat;
massimo una domanda al giorno, budget proattivo e fasce di silenzio già esistenti. Nessun push per visita.
I suggerimenti geografici da luoghi del profilo sono proposte, non conferme del significato.

AI: consenso continuativo revocabile. Recupero limitato a domande esplicite su abitudini/routine e a
massimo tre luoghi confermati corrispondenti al testo; niente coordinate grezze o cronologia completa.
Contesto marcato privato/non fidato; nessun caricamento del testo nel sistema di ricerca generico.
Le risposte rimangono nella chat ordinaria: revoca e cancellazione non ritirano dati già inviati a un provider.
Non sono ancora disponibili classificazione semantica generale delle domande, modifica dei luoghi via voce,
proposte automatiche di tragitti o sincronizzazione HealthKit.

## Revisore Copilot

Copilot CLI aggiornato via npm da 0.0.335 a **1.0.108**. Prova effettiva sul provider GitHub Copilot,
modello scelto da Auto **GPT-6.1 Sol**, completata: **due richieste**, circa **8,32 AI credits** complessivi (4,7 + 3,62).
Revisione di snapshot sorgenti senza credenziali/dati personali, nessun tool di scrittura/esecuzione/MCP,
nessuna modifica a produzione, budget massimo sessione 30 crediti, nessuna modifica al budget account.
È un revisore esterno coordinato da Codex, non un trasferimento di crediti ai subagenti Codex.

Riscontri accolti: retention di luoghi/inferenze, alias dei retry dopo cancellazione, pausa alla revoca
localizzazione, blocco persistente dopo errori di cancellazione, fuso stabile dei limiti giornalieri,
ordine deterministico delle visite, pruning prima delle domande, invalidazione delle richieste al cambio
account. Seconda lettura: correzione degli alias già noti dopo raffinamento della posizione e della
retention aumentata dopo scadenza delle evidenze. Correzioni verificate con test riproducibili; il rapporto AI da solo non prova il funzionamento.

## Verifiche eseguite

- 106 test backend in nove suite, di cui 21 Abitudini: osservazioni, deduplicazione/alias, inferenza,
  retention, consenso/revoca, cifratura/isolation RLS con ruolo applicativo reale, HTTP autenticato.
- Tutte le 54 migrazioni applicate da zero a PostgreSQL/pgvector **temporaneo locale**. Nessun dato reale.
- TypeScript e Biome verificati. Nessuna chiamata a provider LLM nei test dell'applicazione.
- 9 test nativi sul Mac dell'ufficio con Xcode 27.2/iOS Simulator: contratto, coda protetta/pausa,
  cambio account con risposte ritardate, divieto di opt-in implicito, invio senza metadati server.
  Render chiaro/scuro con caratteri accessibili, OCR per evitare snapshot vuoti e ispezione visiva.
- Evidenze temporanee: `/tmp/ernie-habits-all-tests.log`, `/tmp/ernie-habits-local-tests.log`,
  `/tmp/habits-light.png`, `/tmp/habits-dark.png`, `/tmp/ernie-habits-copilot-review-20261110/`.

## Limiti di rilascio

Prima di pubblicare: verifiche native e backend finali, revisione delle modifiche, chiave dedicata e backup,
migrazione 0054 autorizzata, runtime sintetico su server e successiva build riproducibile da GitHub.
Su iPhone reale verificare autorizzazioni, precisione ridotta, arrivo/partenza, revoca, offline e riavvio;
misurare batteria. Il simulatore non dimostra la consegna delle visite in background da parte di iOS.
