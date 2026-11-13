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

Ogni utente collega la propria credenziale. Spegnere la skill blocca richieste HTTP e strumenti,
interrompe le operazioni locali in corso e conserva il collegamento. Scollegare elimina la credenziale
dal database corrente di Ernie, anche con skill spenta; non revoca il token presso Raindrop né elimina
la libreria. Revocarlo nelle integrazioni Raindrop se non serve altrove. I backup precedenti seguono
la retention operativa del server.

Non è ancora implementato l’OAuth interattivo integrato nell’app. Il token personale evita un nuovo
client secret globale; un futuro flusso OAuth richiederà registrazione e callback dell’app Ernie.
La guida MCP segnala che i client ospitati potrebbero richiedere abilitazione dal provider.

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
