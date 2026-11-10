# Salute — protezione, consenso e migrazione

10 novembre 2026. **Nota storica della prima fase**, conservata per documentare le decisioni.
La successiva integrazione è ora pubblicata: **build/API/worker 119**, migrazioni 0052/0053 e passaggio dati
verificati, nessun referto legacy trovato da trasferire. Le diciture «non pubblicato» e i passi futuri qui
sotto descrivono la fase iniziale. Stato definitivo e limiti in [integrazione 27](27-health-vault-integration.md)
e [rilascio 119](../releases/build-119.md), inclusa l’assenza di una prova di ripristino integrale e su iPhone fisico.

## Decisioni confermate

- Archivio consultabile in Ernie; esportazione leggibile soltanto su richiesta esplicita.
- Nessuna nuova sincronizzazione di referti leggibili in Obsidian. La scelta sostituisce il precedente
  requisito delle note automatiche `Salute/*.md`; i percorsi attuali vanno sostituiti prima del rilascio.
- Consenso AI continuativo, specifico per Salute, revocabile e distinto dall'abilitazione della skill.
- Revocare l'AI non cancella il proprio archivio né impedisce lettura ed esportazione manuale.
- Salute prima di Abitudini e HealthKit; nessun accesso implicito a Diario o Archivio chat.

## Componenti implementati, ancora non collegati al runtime

`apps/api/src/health-protection/crypto.ts`: cifratura autenticata AES-256-GCM, nonce casuale di 12 byte,
chiave di 32 byte derivata con HKDF per account e dominio Salute. ID/revisione della risorsa, formato e
ID della chiave sono autenticati; sostituire account, record o revisione rende il payload illeggibile.
Chiavi precedenti leggibili durante una rotazione; scritture soltanto con la chiave attiva. Limite 16 MiB
per record, errori uniformi senza contenuti. Non è E2EE: il backend autorizzato possiede la chiave e può
leggere i dati. Nessuna chiave è stata creata/configurata in produzione in questo incremento.

`store.ts`: implementazione del contratto `HealthStore` su tabelle dedicate. Data del referto, laboratorio,
tipo, valori/unità/riferimenti e testo degli avvisi sono tutti nel payload cifrato. Colonne esterne limitate
ad account, ID/associazioni, revisione e timestamp operativi. Niente fallback alle vecchie tabelle e nessuna
scrittura nel vault. Ogni scrittura può controllare il consenso nella stessa transazione; lettura manuale
separata. Le associazioni esterne sono verificate contro la copia autenticata nel payload.
Aggregazioni decifrano l'archivio dell'account in memoria: oltre 2.000 referti o 64 MiB cifrati restituiscono
un errore, mai un riepilogo parziale scambiato per completo. Prima di volumi superiori servono paginazione
con copertura esplicita e controllo della capacità in scrittura.

`consent.ts`: consenso inizialmente negato, versione del testo mostrato e revisione per account.
L'accettazione richiede la revisione corrente, evitando conferme da schermate arretrate. La revoca è sempre
possibile, senza precondizione di revisione. Ogni concessione/revoca lascia un evento senza dati clinici;
il ruolo applicativo non può riscrivere o eliminare questi eventi. I ticket di elaborazione sono creati
sul server, scadono e diventano inutilizzabili dopo revoca o nuova concessione. Controlli prima e dopo
il lavoro; annullamento locale immediato e rilevazione su altre istanze mediante controllo periodico.
Il provider deve ricevere l'AbortSignal: se ignora l'annullamento, il risultato resta comunque scartato.
Il controllo delle scritture blocca la revisione fino a fine transazione, evitando una revoca tra verifica
e persistenza. Il checker della skill usa la medesima connessione; non occupa un secondo slot del pool.

La revoca non può ritirare ciò che è già stato inviato al provider. I chiamanti devono controllare il ticket
**prima di ogni nuova chiamata esterna**, proteggere tutte le scritture derivate e invalidarlo anche alla
disattivazione della skill. Questi agganci, la UI e la configurazione delle chiavi sono ancora da completare:
un helper isolato non rende revocabile la versione pubblicata.

`0052_health_protection.sql`: quattro nuove tabelle, RLS forzata e privilegi minimi per gli eventi consenso.
Migrazione solo strutturale, senza copia/cancellazione di dati e senza attivare consensi sugli account.
Applicata esclusivamente a database sintetici locali. Non applicata su staging3.

## Correzione prerequisito: cancellazione documenti

`documents.remove` elimina ora anche titolo, prodotti, schemi e frammenti; ripulisce anche i vecchi record
che risultavano già eliminati. Salvataggi tardivi di prodotti/schemi non possono riportare in vita un documento.
L'indicizzazione verifica proprietà/stato prima di chiamare il provider e di nuovo, con lock, prima di
salvare il risultato: una cancellazione durante l'AI impedisce di ricreare i frammenti. Le ricerche testuali,
vettoriali e per sezioni escludono i documenti eliminati anche se hanno indici residui preesistenti.
Questo non cancella ancora immagini, note, referti, copie nei messaggi o backup: occorre collegare le risorse.

## Sequenza per chiudere R4

1. Collegare esplicitamente originale, OCR, media, documento, referto e derivati. Percorso di caricamento
   Salute cifrato fin dall'ingresso, senza passare prima da Media/documenti generici leggibili.
2. Integrare store/consenso nelle API, nei job e negli strumenti. Impedire vie alternative tramite embedding,
   ricerca Brain/documenti, catalogazione Media e avvisi nel contesto. Schermata Salute dedicata con stato
   consenso, revoca, consultazione e export esplicito. Nessun consenso dedotto dalla semplice skill accesa.
3. Proteggere le copie nei turni/chat, riepiloghi, replay, cache iOS e anteprime dei tool; la cifratura delle
   sole tabelle `health_secure_*` non basta. Contesto per LLM solo con consenso corrente, verificato anche
   quando un turno era partito prima della revoca.
4. Inventario per account e migrazione verificata dei referti esistenti, documenti, media e note, inclusa la
   cronologia Git del vault locale/remoto. Non eliminare un originale prima di averne verificato la copia
   cifrata e la rilettura. Copie non collegabili con certezza richiedono riconciliazione, non eliminazione
   per somiglianza. Censire backup/WAL e recupero chiavi; nessuna promessa di cancellazione retroattiva non provata.
5. Backup, verifica di ripristino, confronto conteggi/contenuti, test di isolamento/revoca/retry, UI nativa,
   sorgenti GitHub e autorizzazione al rilascio. Soltanto allora dichiarare R4 completato e iniziare R5/R6.

## Verifiche

Test sintetici su PostgreSQL/pgvector locale, mai dati medici reali o servizi AI. Prove negative crypto,
RLS, riferimenti manomessi, atomicità consenso/scrittura, revoca tra processi, eventi non riscrivibili,
confronti con date ignote/unità diverse, duplicati concorrenti e limiti senza risultati parziali.
Migrazioni 1–52 applicate da zero a un secondo database: seconda esecuzione senza modifiche, quattro
nuove tabelle con RLS e divieto UPDATE/DELETE degli eventi verificati.
49 test in otto suite superati, TypeScript/Biome verdi. Quattro regressioni falliscono sul codice
precedente e passano sulla correzione; review indipendente con due difetti corretti e coperti da test.
Risultati finali e stato GitHub in HANDOFF; nessuna build iOS nuova né pubblicazione implicita.
