# Raindrop

Skill personale, spenta per impostazione predefinita. I segnalibri restano su Raindrop: nessuna
importazione, indicizzazione, sincronizzazione o consolidamento nel Second Brain. La consultazione
invia al modello configurato soltanto i risultati richiesti, come dichiarato nel pannello.

## Collegamento nell’app

Impostazioni → Raindrop, oppure Skill → Raindrop → Account e segnalibri.

1. Attivare la skill per il proprio account Ernie.
2. Aprire [Raindrop → Integrazioni](https://app.raindrop.io/settings/integrations), creare un’app personale,
   aprirne le impostazioni e copiare il **Test token**. È il percorso ufficiale per usare solo il proprio
   account; non serve inserire la password in Ernie né inviare il token in chat.
3. Incollare il token nel campo protetto e collegare. Ernie verifica `/rest/v1/user` prima di conservare
   la credenziale. Questa operazione legge il profilo, senza importare né modificare i segnalibri.
4. Cercare nella raccolta o chiedere «cerca in Raindrop…», «riassumi questo segnalibro»,
   «salva questo link in Raindrop». Per una raccolta omonima Ernie deve chiedere quale usare.

### Dopo il login su iPhone

La pagina «Integrazioni» di Raindrop è la destinazione prevista: il login con username e password
vale per il sito Raindrop e non completa automaticamente il collegamento con Ernie nella build 122.
Scorrere fino a **Per sviluppatori → Crea nuova app**, darle un nome riconoscibile (per esempio
«Ernie personale»), aprirne le impostazioni e copiare **Test token**. Tornare quindi a
**Ernie → Impostazioni → Raindrop**, incollarlo in **Token personale Raindrop** e premere
**Collega account**. Non usare Client ID, Client Secret o password al posto del Test token.
Non inviare il token in chat. Il collegamento OAuth con ritorno automatico all’app non è implementato.

Ogni utente collega la propria credenziale. Spegnere la skill blocca richieste HTTP e strumenti,
interrompe le operazioni locali in corso e conserva il collegamento. Scollegare elimina la credenziale
dal database corrente di Ernie, anche con skill spenta; non revoca il token presso Raindrop né elimina
la libreria. Revocarlo nelle integrazioni Raindrop se non serve altrove. I backup precedenti seguono
la retention operativa del server.

La build 122 distribuita usa il token manuale. L’incremento OAuth è implementato nei sorgenti ma
**non ancora pubblicato o configurato in produzione**. Non modifica i collegamenti manuali esistenti.
La guida MCP segnala che i client ospitati potrebbero richiedere abilitazione dal provider.

## Accesso automatico — incremento non ancora rilasciato

L’utente preme **Accedi con Raindrop**, accede e autorizza sul sito del provider; la sessione nativa
`ASWebAuthenticationSession` intercetta il ritorno `ernie://raindrop-auth` e il pannello rilegge
profilo e raccolte. La password resta nel sito Raindrop. Nessun access/refresh token passa negli URL
né arriva all’app; lo scambio del codice è eseguito dal backend autenticato.

Prerequisiti del gestore, una volta per ciascun backend Ernie:

1. Registrare un’app OAuth Ernie nel pannello Raindrop; configurare il redirect esatto
   `ernie://raindrop-auth`. **Accettazione di questo redirect e ritorno reale dello state vanno
   verificati con il client registrato prima di dichiarare il flusso funzionante in produzione.**
   La documentazione ufficiale descrive OAuth e redirect registrati, ma non costituisce una prova
   del comportamento del nostro specifico client nativo.
2. Configurare privatamente `RAINDROP_OAUTH_CLIENT_ID` e `RAINDROP_OAUTH_CLIENT_SECRET` nel backend.
   Il secret non viene distribuito nell’iPhone. Nessun valore di credenziale va versionato.
3. Pubblicare l’API e una nuova build iOS dopo il normale via libera al rilascio, poi provare accesso,
   annullamento, rinnovo e scollegamento su iPhone. Non è necessaria una nuova migrazione SQL.

Senza entrambe le variabili il backend dichiara `oauthConfigured: false`: resta disponibile il token
manuale. La vecchia build ignora il nuovo campo; il nuovo client gestisce anche server senza quel campo.
Il nuovo pulsante appare solo quando l’API dichiara OAuth configurato e la skill è accesa.
Il collegamento manuale resta in una sezione espandibile. Un account già collegato continua a funzionare.

Protocollo: POST autenticata `/v1/raindrop/oauth/start` con prova casuale del dispositivo;
risposta URL di autorizzazione e state casuale. POST `/v1/raindrop/oauth/complete` con codice,
state e prova, senza possibilità di scegliere un altro userId. Un solo tentativo per account,
scadenza 5 minuti; Redis contiene solo hash di state/prova e fingerprint della configurazione.
Consumo atomico monouso, confronto prima della cancellazione: tentativi sbagliati non consumano
quelli validi. DELETE `/v1/raindrop/oauth` annulla il tentativo; spegnimento skill, kill switch,
scollegamento e collegamento manuale lo invalidano. Il ritorno deve avere origine, state e codice
attesi; URL di autorizzazione e callback sono verificati anche nell’iPhone.

Access token, refresh token e scadenza restano nell’envelope cifrato già dedicato alla connessione.
Alla prima lettura dopo la scadenza imminente il servizio rinnova l’accesso prima di chiamare Raindrop.
Nessun polling in background, nessun rinnovo per i Test token. Rinnovi/collegamenti/scollegamenti sono
serializzati per account nell’unico processo API attuale. Un futuro deployment con più repliche API
richiederà anche un lock distribuito del rinnovo prima di abilitarle.
Nessun tentativo automatico di ripetere uno scambio incerto; errori provider depurati, payload limitati,
HTTPS e redirect di rete rifiutati. La prova locale di binding non è PKCE del provider: la documentazione
Raindrop consultata non lo descrive. Client secret resta necessario allo scambio sul backend.

Verifiche locali dell’incremento: 49 test backend passati (incluso Redis reale isolato e consumo
concorrente), una precedente integrazione PostgreSQL non rieseguita; 6 test iOS passati e compilazione
simulatore. Provider OAuth simulato nei test; **login reale e ritorno dal provider non ancora verificati**.

## Come usare la skill

Attivare Raindrop e collegare il proprio account. In Impostazioni → Raindrop si possono scegliere
raccolta e ricerca, aprire i segnalibri e consultarne note ed evidenziazioni. Nella chat principale:

- «Mostrami le raccolte che ho in Raindrop».
- «Cerca in Raindrop gli articoli sugli agenti AI».
- «Cerca i segnalibri con tag WordPress nella raccolta Lavoro».
- «Riassumi questo segnalibro e dammi il link originale».
- «Confronta questi due articoli salvati in Raindrop».
- «Salva questo link in Raindrop nella raccolta X, con tag Y».
- «Salva nel Second Brain questo punto dell’articolo, citando la fonte» (trasferimento esplicito).

La lettura integrale e la ricerca semantica dipendono dal piano/funzioni disponibili presso Raindrop.
L’estratto non equivale al testo completo; Ernie deve segnalare il limite. Non sono esposti strumenti
per cancellare, spostare o riorganizzare in massa i segnalibri. Nessuna scansione preventiva dell’intera
libreria, nessun trasferimento automatico nel Second Brain.

## Backend e sicurezza

- Migrazione **0055**: `raindrop_connections`, una riga per account con `FORCE ROW LEVEL SECURITY`,
  policy proprietario, cancellazione a cascata. Token e metadati account nell’envelope AES-256-GCM.
- `RAINDROP_ENCRYPTION_KEYS`: keyring dedicato, formato
  `{"activeKeyId":"v1","keys":{"v1":"<32 byte casuali in base64>"}}`.
  Generare su host autorizzato, non in chat, e conservare backup privato separato dal database.
  Assenza della chiave blocca il collegamento; non riusare chiavi Salute, Abitudini o SSH.
- Si riusa soltanto la primitiva crittografica già verificata (`health-protection/crypto.ts`), con
  chiave distinta, chiave derivata per account e AAD `raindrop_connection/account/1`.
  Cifratura a riposo nel backend, non cifratura end-to-end: il backend deve decifrare per le API.
- Credenziali fuori da `users.settings`, memoria, contesto LLM e log. La risposta pubblica contiene
  soltanto stato, nome, ID e piano del proprio account; nessun token.
- Gating aggiornato dal DB (skill disponibile e accesa, controllo genitori e kill switch) prima
  delle richieste e prima della consegna dei risultati. Gestione dei risultati tardivi dopo scollegamento.
- Trasporto soltanto verso `api.raindrop.io`, HTTPS, redirect rifiutati, timeout e risposta limitata
  a 1,5 MB. Errori del provider depurati, nessun corpo remoto nei log o negli errori pubblici.

## API e strumenti

REST autenticata con la normale chiave Ernie, scope `chat`, `Cache-Control: no-store`:

| Metodo | Percorso | Funzione |
|---|---|---|
| GET | `/v1/raindrop` | Stato senza chiamare Raindrop |
| PUT | `/v1/raindrop/connection` | Verifica e cifra `{token}` |
| DELETE | `/v1/raindrop/connection` | Scollega senza toccare la libreria |
| GET | `/v1/raindrop/collections` | Raccolte principali e annidate |
| POST | `/v1/raindrop/search` | `{query,collectionId,page,limit}`; massimo 25 risultati |
| GET | `/v1/raindrop/bookmarks/:id` | Metadati, note, evidenziazioni |

Strumenti agente: `raindrop_search`, `raindrop_get`, `raindrop_collections`, `raindrop_read_tools`,
`raindrop_read`, `raindrop_save`. Disponibili solo a skill accesa, con controllo ripetuto nel servizio.
`raindrop_collections` filtra per nome/percorso con `query`, pagina con `offset`/`limit` e restituisce
`total`, `matches`, `items`, `nextOffset`: le raccolte omonime si distinguono dal percorso dei genitori.
Le letture hanno provenienza privata/non fidata; query e scritture sono canali verso l’esterno e
rispettano il motore delle conferme esistente. Il modello non può collegare token.

Ricerca e consultazione base usano REST ufficiale. Per semantica e contenuto completo il modello legge
gli schemi MCP correnti con `raindrop_read_tools` e passa argomenti conformi a `raindrop_read`.
L’allowlist permette soltanto `find_bookmarks`, `fetch_bookmark_content`, `find_highlights`:
nessuna scrittura generica o cancellazione MCP. Inizializzazione, SSE, ID di risposta e chiusura
sessione gestiti nel provider; nessuna sessione MCP condivisa fra account.
Il salvataggio di un link usa REST dedicata, nessun ritentativo automatico per una scrittura incerta.

La [guida aggiornata](https://help.raindrop.io/integrations/mcp) distingue piano gratuito limitato
da Pro con ricerca testuale/semantica. La pagina developer conserva la precedente indicazione
«beta solo Pro»: il comportamento effettivo va verificato dopo l’autorizzazione dell’account reale.
Un estratto o un errore non dimostrano di avere letto il testo completo.

## Confine con la memoria

Nessun tool chiama i repository Brain, memoria, ricette o profilo. Il consolidatore e il riepilogo di
sessione escludono le risposte dell’assistente dal primo uso di un tool `raindrop_` nella conversazione,
anche se i passaggi successivi riutilizzano il testo senza chiamare un altro tool. I messaggi diretti
dell’utente restano fonti personali; `brain_write` esplicitamente richiesto resta un’azione distinta.
Occorre pubblicare **API e worker insieme**: il worker precedente non ha questo filtro.
Il normale storico della chat conserva le risposte per la conversazione, senza trasformarle in memoria.

## Verifica riproducibile

`pnpm typecheck`; `pnpm exec vitest run apps/api/src/raindrop packages/skills/src/raindrop.test.ts
packages/skills/src/catalog.test.ts packages/memory/src/external-library.test.ts`.

Integrazione RLS: impostare `RAINDROP_TEST_DATABASE_URL` esclusivamente su un database dedicato
locale `127.0.0.1:62205/ernie`; il test usa migrazioni e credenziali sintetiche. Non usare un database reale.
Test iOS: `ErnieTests/RaindropTests` (contratto autenticato, paginazione e URL sicuri).
Prima di dichiarare il collegamento personale completato verificare con l’account reale: profilo,
raccolte e ricerca in sola lettura, piano e disponibilità MCP. Un salvataggio reale richiede un link
scelto dall’utente; non creare segnalibri per una verifica non richiesta.

Fonti: [autenticazione](https://developer.raindrop.io/v1/authentication/token),
[REST segnalibri](https://developer.raindrop.io/v1/raindrops/multiple),
[server MCP](https://developer.raindrop.io/mcp/mcp).
