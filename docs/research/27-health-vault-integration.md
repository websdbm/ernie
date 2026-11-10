# Salute — integrazione protetta e passaggio dei dati

10 novembre 2026. Segue [la decisione di protezione](26-health-protection.md): archivio in Ernie,
esportazione leggibile solo esplicita, consenso AI continuativo revocabile; nessuna nuova sincronizzazione
Obsidian. Abitudini e Apple Salute restano successive.

## Percorso nell'app

Salute è raggiungibile dal pannello laterale anche con skill disattivata. Documenti e valori hanno viste
separate; PDF, foto, scansioni e testo si importano esplicitamente qui. OCR sul dispositivo, invio diretto
all'API protetta, nessuna coda Media. Un controllo locale intercetta referti riconoscibili anche dal composer;
il backend rifiuta i documenti sanitari riconosciuti sulle rotte generiche prima di archiviazione/indicizzazione.
Il riconoscimento OCR è una difesa aggiuntiva, non garantisce qualsiasi immagine sanitaria: per questi documenti
usare Salute. Testi volontariamente scritti nella chat generale restano soggetti alle regole della chat.

Schermate, risposte e allegati sono tenuti in memoria; chiusura, cambio account e passaggio in background
annullano richieste e svuotano lo stato. URLSession effimera senza cache/cookie. Esportazione JSON leggibile
con conferma: copia temporanea protetta/esclusa dal backup e rimossa alla chiusura. Le copie esplicitamente
salvate in altre applicazioni rimangono sotto il controllo dell'utente. Nessuna nuova autenticazione biometrica
è richiesta per Salute; il Diario mantiene la propria protezione e non è consultato.

## Backend e AI

`/v1/health/*` usa l'account autenticato, scope chat, RLS e risposte no-store. Titoli, OCR, immagini, nomi file,
valori e copie legacy sono cifrati con AES-256-GCM e chiavi derivate per account; ID/relazioni/tempi tecnici
rimangono nel database. Il backend possiede la capacità di decifrare: **non è cifratura end-to-end**.

La lettura manuale, l'importazione e l'esportazione non richiedono consenso AI. Analisi e domande richiedono
skill attiva, consenso della versione corrente, budget e ticket vivo. Revoca/disattivazione invalidano i ticket;
la riattivazione non resuscita operazioni precedenti. Le cancellazioni bloccano salvataggi tardivi. Revocare
non può ritirare dati già inviati al fornitore. Il consenso non è attivato dalla migrazione.

`health_open` nella chat mostra solo un collegamento alla sezione; i vecchi tool clinici non sono registrati.
L'AI dedicata non ha strumenti, memoria conversazionale o Brain. Prompt/output esclusi dai trace e logger
Mastra disabilitato per questi due agenti; contabilità LLM conserva solo metadati di costo. Le risposte non
vengono salvate in chat, replay o riassunti. Se non si selezionano fonti, si consultano gli ultimi 10 referti,
oppure 3 documenti in assenza di analisi; la UI esplicita questa copertura. Fonte esplicita non aggiunge
referti estranei. Contesto massimo 60.000 caratteri; estrazione fino a 40.000, errore chiaro invece di troncamento.

## Chiavi, migrazione e recupero

Variabile riservata `HEALTH_ENCRYPTION_KEYS`: JSON con `activeKeyId` e mappa `keys` di chiavi casuali da
32 byte in base64 canonico. Non usare password o chiavi SSH. Assente: Salute indisponibile, nessun fallback
in chiaro. Non valida: avvio rifiutato con errore privo di segreti. Conservare copia protetta delle chiavi
separata dai dump; perdere la chiave rende illeggibili gli archivi. Per rotazione conservare le vecchie
chiavi finché tutti i record e i backup da ripristinare le richiedono. Nessuna rotazione automatica in questa versione.

Migrazioni 0052/0053 additive prima dell'API nuova. Backup verificato, blocco vecchi writer, inventario e
trasferimento sono passaggi distinti. `node apps/api/dist/cli/migrate-health.js` produce per default un inventario
senza modifiche e senza contenuti/identificativi personali. `--apply --writers-stopped` è ammesso soltanto
durante manutenzione, con vecchi API/worker fermati e backup disponibile. Il migratore usa fingerprint,
transazione serializzabile, verifica di decifratura e ricevuta cifrata; retry ripetibile, nessuna duplicazione.

Referti legacy sono conservati cifrati con originali/derivati disponibili; vecchie righe diventano segnaposto
privi di dati, senza cascade tra account. Copie dubbie non vengono cancellate. Copie in note/vault/storia,
trascrizioni o media non correlati bloccano la CLI e richiedono inventario separato e trattamento esplicito:
non dichiarare conclusa una migrazione dalla sola riuscita delle tabelle SQL.

Ricognizione **in sola lettura** su staging3: zero referti/valori/avvisi legacy, zero note Salute e zero chiamate
ai vecchi tool sanitari. Nessun candidato sanitario riconosciuto nei documenti, OCR Media o estratti Brain.
21 vault controllati: nessuna cartella Salute corrente o nella cronologia Git. L'inventario non equivale a
una ricerca semantica di ogni conversazione/testo libero. Va ripetuto dopo lo stop dei writer al rilascio.
Non eliminare backup storici indiscriminatamente; eventuali copie pregresse vanno trattate separatamente.

Dopo il passaggio, evitare rollback alla vecchia API: riabiliterebbe importazioni in chiaro e nasconderebbe
il nuovo archivio. In caso di problemi lasciare Salute indisponibile e correggere avanti; ripristino integrale
solo con verifica delle scritture avvenute dopo il backup. API pronta prima della build iOS 119.
