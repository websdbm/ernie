# Maximize — scelta del modello e dello sforzo

10 novembre 2026. Richiesta dell'utente durante la preparazione della build 116.
**Implementato per la build 117, rilascio in preparazione. Nessuna impostazione utente cambiata.**
La sezione finale registra l’implementazione; le sezioni precedenti conservano analisi e decisioni.

## Comportamento richiesto

Skill **Maximize** attivabile per account. Da spenta Ernie continua la selezione automatica ordinaria;
da accesa compare un selettore compatto nella chat. Attivare la skill non sceglie subito un modello costoso:
**Automatico** rimane il valore iniziale. L'utente può scegliere anche modelli più potenti non usati dal
router automatico, e il livello di ragionamento dove disponibile.

Scelta proposta: preferenza **per conversazione**, applicata al prossimo turno; una nuova conversazione
parte in Automatico. Non modificare a metà un turno/azione già in corso. Disattivare Maximize ripristina
Automatico per i turni successivi e invalida override ancora in coda, senza ripetere il task in corso.
Mostrare una riga «Automatico» oppure «GPT-6.1 Sol · Alto» sopra il compositore, senza alterare la capsula
dell'avatar. Il tap apre il pannello; supportare temi, testo grande e lettore schermo.

Pannello:
- Automatico, consigliato per l'uso ordinario, e ricerca per nome del modello.
- Nome effettivo, fornitore, supporto di allegati/strumenti e costo indicativo con data del listino.
- Sforzo «Predefinito del modello» oppure i soli livelli realmente accettati; niente controlli fittizi.
- Modello/effort selezionati visibili; comando per tornare in Automatico.
- Modello non compatibile/non disponibile: motivazione e alternativa esplicita, senza sostituzione
  silenziosa. Una voce nel catalogo pubblico non prova autorizzazione/credito sul conto dell'utente.

Lo sforzo governa il ragionamento, non la lunghezza della risposta; uno sforzo maggiore può aumentare
tempo e costo. Le chiamate interne leggere (instradamento, etichette, revisioni) non passano tutte al
modello scelto: l'override riguarda il modello principale che conduce quel compito.

## Stato attuale verificato

- `packages/model-gateway/src/models.ts`: classi `light`, `standard`, `heavy`; ragionamento fisso per
  classe, tipo limitato a `off/none/low/medium/high`, budget per classe. Prezzi stimati statici.
- `packages/model-gateway/src/provider.ts`: Anthropic diretto, con OpenRouter di riserva. La risoluzione
  attuale prova Anthropic ogni volta che c'è la chiave: non è pronta a ricevere indifferentemente un ID
  OpenAI o di altri autori. Il fallback deve essere deciso per ID/provider, non dalla sola presenza chiave.
- `packages/agent-core/src/agent.ts`: risoluzione della classe all'avvio dell'agente. Servono preferenza
  di sessione, snapshot al turno e metadati effettivi, senza cambiare il singleton globale per un account.
- Il ragionamento `off` oggi viene mappato su `minimal` in OpenRouter per una compatibilità specifica
  Sonnet: non generalizzare questo comportamento agli altri modelli.

Catalogo pubblico OpenRouter letto il 10 novembre tramite `GET /api/v1/models`: sono presenti
`openai/gpt-6.1-sol` e `openai/gpt-6.1-sol-pro`, con strumenti, output strutturati e parametri di reasoning.
La verifica è di catalogo/documentazione, **non una chiamata di inferenza sul conto Ernie**. Non sono stati
spesi token né importati modelli/configurazioni. I nomi di Codex non diventano ID validi senza questa verifica.

### Anthropic diretto: verifica autenticata su staging3

Il 10 novembre, su richiesta dell'utente, verificati configurazione effettiva e `GET /v1/models` usando la
chiave già nel container API, senza stamparla o copiarla. Risposta **HTTP 200**, 15 modelli, paginazione
esaurita. Nessuna generazione a pagamento, modifica del provider o verifica del credito residuo.

Configurazione corrente: `LLM_PROVIDER=auto`, chiavi Anthropic/OpenRouter presenti. La via principale è
Anthropic diretto; OpenRouter è il fallback previsto dal gateway per errori iniziali.

| Classe di Ernie | Modello configurato | Impostazione corrente |
| --- | --- | --- |
| light | Claude Haiku 5.5 | default del provider |
| standard | Claude Sonnet 5.5 | `standardReasoning=off` |
| heavy | Claude Opus 5.5 | `high` |

Il catalogo autenticato include anche **Claude Fable 5.2**, Fable 5.1 e precedenti. Fable 5.2 risulta
attivo e accessibile al catalogo della chiave, ma non è fra le tre classi configurate e non è stato
provato in inferenza. I quattro modelli recenti dichiarano input immagini/PDF e output strutturati;
livelli `low`, `medium`, `high`, `xhigh`, `max`. Ernie deve estendere il tipo e la validazione per offrire
gli ultimi due in Maximize; la versione precedente non li rende selezionabili.

Nota di compatibilità da verificare con una prova sintetica prima di modificare il runtime: il catalogo
attuale dichiara `thinking.disabled.supported=false` per Sonnet 5.5, Opus 5.5 e Fable 5.2; l'impostazione
standard esistente manda invece `thinking=disabled` a Sonnet. Non conclude da sola che le richieste
stiano fallendo: non sono stati consultati i log né effettuata una generazione in questa verifica.
Maximize deve distinguere predefinito, spento e minimo secondo capacità/provider, senza ereditare
il workaround specifico OpenRouter. Conservare l'impostazione corrente finché non verificata.

**Il catalogo Maximize comprende entrambi i servizi**, non solo OpenRouter. Preferenza proposta per
Claude: API Anthropic già collegata; per Sol e altri autori: OpenRouter compatibile. Mostrare il servizio
effettivo, disponibilità e prezzi separati, con fallback coerente con consensi e scelta dell'utente.
Il catalogo pubblico o autenticato non prova che il conto abbia credito per una nuova generazione.

## Catalogo e compatibilità

Catalogo letto dal backend, cache con data/aggiorna e filtro per modelli chat realmente utilizzabili dal
gateway e dall'account. Nessuna chiave nel client. Modelli batch, embedding, soli audio/immagini o privi
degli strumenti richiesti non diventano opzioni equivalenti al modello chat principale.

Usare `supported_parameters`, modalità di input/output, limiti di contesto/output e dati `reasoning`
del modello; il catalogo può indicare livelli accettati e ragionamento obbligatorio. Quando mancano
metadati affidabili, mantenere il valore predefinito verificato, senza inventare una scala universale.
Adattatori e validazione server per provider; i livelli avanzati vanno rappresentati nel protocollo.
«Nuovo» significa comparso nel catalogo, non automaticamente affidabile/idoneo a qualsiasi azione:
minimo controllo di streaming/tool e disponibilità prima di abilitarlo all'agente.

Aggiornare il catalogo non cambia silenziosamente una scelta fissa. Alias «latest», se proposti, devono
essere chiaramente tali e il modello effettivo va registrato. Se l'ID scompare, proporre alternativa/Auto.
Un modello può supportare il ragionamento ma non tutte le sue impostazioni o modifiche durante una
generazione: il controllo UI si applica al prossimo turno, non è un comando live al provider.

## Contratto di esecuzione

- Preferenza autenticata per account/sessione e autorizzazione skill controllata anche sul backend.
- Creare uno snapshot immutabile per richiesta con selezione richiesta/effettiva, sforzo, provider,
  versione catalogo e policy. Richieste parallele non condividono override mutabili.
- Tenere skill, strumenti, autorizzazioni, isolamento Brain/diario/archivio invariati. Un modello più
  potente non ottiene più permessi. La soglia di capacità per interventi SSH rimane valida anche se
  l'utente seleziona un modello piccolo; chiarire l'eventuale modello effettivo richiesto dalla skill.
- Conservare la storia visibile, risultati strumenti e stato dei task quando cambia il modello; adattare
  formato e limite di contesto senza reinviare blocchi interni incompatibili di ragionamento del provider
  precedente, né rieseguire strumenti già completati.
- Retry e provider alternativi solo se compatibili con la scelta e i consensi; vietati downgrade silenziosi.
  Per Salute, i vincoli specifici del servizio/provider prevalgono sul modello scelto in Maximize.
- I limiti di output devono lasciare spazio alla risposta oltre al ragionamento. Riconoscere budget
  esaurito/risposta vuota e proporre un recupero senza duplicare scritture o riprovare senza limiti.
- Registrare costo reale e modello/provider effettivi. Se manca il costo reale, stimare con il listino
  aggiornato e tutte le componenti note; costo ignoto non deve apparire come gratuito. Il listino per
  milione di token non è una previsione certa del costo del turno. Rispetto dei limiti di spesa esistenti.

## Incrementi e verifiche

1. Catalogo/cache e resolver per modello/provider con fallback e parametri verificati.
2. Skill, preferenza per sessione e protocollo versionato con default compatibile ai client precedenti.
3. Pannello iOS, badge della selezione e consumi coerenti.
4. Test di streaming/strumenti su più provider, confronto di modello richiesto/effettivo e rilascio separato.

Regressioni richieste: skill spenta anche con payload forgiato, due utenti/sessioni parallele, disattivazione
con turni in coda, nessun override sulle chiamate di servizio, incompatibilità allegati/tool/effort,
catalogo irraggiungibile/scaduto, credito negato, risposta priva di testo, retry senza duplicare azioni,
costi ignoti, tema chiaro/scuro/Borg e scelta modello durante turno attivo.

Fonti ufficiali:
- [Catalogo modelli](https://openrouter.ai/docs/api/api-reference/models/get-models)
- [Reasoning e livelli per modello](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [GPT-6.1 Sol](https://openrouter.ai/openai/gpt-6.1-sol)
- [Catalogo Anthropic e capacità](https://platform.claude.com/docs/en/api/models/list)
- [Modelli Claude](https://platform.claude.com/docs/en/models/overview)
- [Claude Fable 5.2](https://platform.claude.com/docs/en/models/fable-5-2/overview)


## Implementazione del 10 novembre — build 117

Catalogo `GET /v1/models` solo per skill attiva, con modello/provider/sforzi e tariffe base; refresh condiviso,
TTL 15 minuti, retry catalogo guasto dopo 30 secondi. Solo modelli testuali con strumenti e almeno 64k contesto;
Anthropic diretto richiede capacità adaptive/structured e tariffa nota (Haiku/Sonnet/Opus 5.5, Fable 5.2).
Gli altri modelli compatibili entrano dal catalogo OpenRouter. Disponibilità nel catalogo non certifica credito.

Scelta salvata nella cronologia locale della conversazione, insieme ai messaggi; nessun valore globale che
contamini altri task. Il payload opzionale `modelSelection` fotografa la scelta prima della coda. Il server
rilegge i permessi effettivi e valida modello/sforzo; una richiesta manuale già in coda dopo revoca viene
rifiutata con istruzione di tornare ad Automatico, senza consumo del modello scelto. Nessuna sincronizzazione
nuova delle conversazioni fra telefoni introdotta qui.

Override limitato al companion principale. Niente cambio silenzioso di provider/model ID, limite output
16k o 32k secondo sforzo (entro il limite del catalogo); limiti passi e budget esistenti conservati.
Solo Opus 5.5/Fable 5.2 espliciti sono ammessi agli strumenti SSH, sempre con classe heavy e autorizzazioni.
Gli altri override non ricevono tool SSH; l'intento SSH riconosciuto chiede di cambiare selezione. La cronologia
inviata conserva testo e risultati/tool call, esclude blocchi di ragionamento opachi legati a provider/modello.
Una risposta manuale senza testo né strumenti non viene dichiarata riuscita, né rilanciata automaticamente.

Verifica reale: il vecchio gateway Sonnet risponde `OK` (1.963 ms, 22 token, zero reasoning), mentre il corpo
HTTP grezzo `thinking=disabled` riceve 400: è l'SDK 4.0.79 a convertirlo in `between_tools`. Mapping ora
esplicito. Smoke con nuovo adattatore in memoria, nessun deploy: Fable 5.2 diretto 2 step/1 tool/risposta 7
(6.461 ms, 1.022 token); Sol 6.1 OpenRouter 2 step/1 tool/risposta 7 (4.033 ms, 209 token).
Sono prove sintetiche di compatibilità, non benchmark di qualità/velocità. Catalogo: 292 opzioni compatibili,
4 Anthropic dirette. Fable 5.2 cache-read corretto $0,20/M; informazione sulla conservazione 30 giorni visibile
nel selettore. Fonte: https://platform.claude.com/docs/en/models/fable-5-2/overview .
