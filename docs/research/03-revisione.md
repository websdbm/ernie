# Revisione dei report bibliografici 01, 02 e 04 — implicazioni per Ernie

> Revisore senior · 10 ottobre 2026 · Oggetto: `01-architettura-agenti.md` (133 fonti), `02-buone-prassi-agenti.md` (137 fonti), `04-avatar-3d-ios.md` (64 fonti). Confronto con `ARCHITECTURE.md` v0.1, `IMPLEMENTATION_PLAN.md` e `00-fonti-verificate.md`.

**Metodo.** Lettura integrale dei tre report; 53 verifiche a campione sulle fonti primarie (spec, advisory via API GitHub/NVD, endpoint JSON della documentazione Apple, full-text arXiv estratti dai PDF, docs Epic/Unity/Mastra), scelte tra le affermazioni con numeri, date, API o che toccano decisioni di v0.1. Esiti: 45 confermate, 6 imprecise o parziali, 2 non verificabili (pagine Epic in 403, come dichiarato dal report), **0 false**. Le implicazioni (§5) sono riferite a sezioni di ARCHITECTURE.md e a milestone.

---

## 1. Verdetto sintetico

| Report | Affidabilità | Accuratezza | Completezza | Utilità | Motivazione |
|---|---|---|---|---|---|
| **01 Architettura** | **4** | **5** | **4** | **4** | Fonti quasi tutte primarie con claim vendor marcati; 17/17 affermazioni campionate confermate e incoerenze delle fonti segnalate dall'autore. Mancano: cosa delle feature native dei provider (tool search, `input_examples`, context editing, effort per-messaggio) sopravvive passando da OpenRouter; scelta degli embeddings; come Mastra ordina tool e system prompt ai fini della cache. La raccomandazione più importante (prefisso stabile) mette in discussione un pezzo di v0.1 e va recepita. |
| **02 Buone prassi** | **4** | **5** | **4** | **5** | Primarie in larga maggioranza, secondarie dichiarate (nomi ASI OWASP, isolated-vm via stampa anziché l'advisory GHSA esistente, SWE-bench via Gigazine); 22/22 confermate con due sfumature (§2). Lacune: Firecrawl come caso specifico, injection vocale (dichiarata), portabilità dati. Checklist §3 e implicazioni trasformabili in criteri di accettazione; corregge un errore di v0.1 (`.voiceChat`). La proposta di protocollo è marcata "Opinione" e non va adottata in blocco. |
| **04 Avatar 3D** | **4** | **5** | **4** | **5** | Docs Epic/Unity/Apple/GitHub come primarie; dichiara i 403 di Epic e cita secondarie solo per royalty ed EULA MetaHuman; 14/14 confermate (una sfumatura su OVRLipSync). Nessun benchmark su dispositivo né stime di tempo (dichiarato). Rende decidibile la domanda "Unreal o equivalenti" con evidenze, ordina le opzioni di lip-sync e indica gli spike necessari. |

---

## 2. Verifiche a campione

Esito: ✅ confermata · ⚠️ imprecisa/parziale · ❔ non verificabile · ❌ falsa.

| # | Affermazione | Rep./§ | Fonte primaria aperta | Esito | Nota |
|---|---|---|---|---|---|
| 1 | MCP 2026-07-28 stateless (no `initialize`/`Mcp-Session-Id`), `server/discover`, MRTR, Tasks come estensione, `ttlMs`/`cacheScope`, `Mcp-Method`/`Mcp-Name`, JSON Schema 2020-12, `tools/list` deterministico; deprecati Roots/Sampling/Logging/HTTP+SSE/DCR con finestra ≥12 mesi | 01 §2.4; 02 §2.7 | modelcontextprotocol.io/…/2026-07-28/changelog | ✅ | Confermata anche la rimozione di `Last-Event-ID` (stream rotto ⇒ richiesta da rifare). |
| 2 | isolated-vm: escape sandbox→host nel binding C++, ago 2026, fix 6.2.0/7.0.1 | 02 §2.1 [29] | api.github.com/repos/laverdet/isolated-vm/security-advisories; npm | ✅ | GHSA-864f-rcv7-6rh4 **critical**, 2026-08-07; npm 7.0.1 (5 ago), 6.2.0 (6 ago). Il report cita solo CSO Online: la primaria esiste. |
| 3 | 12 difese aggirate con >90% da attacchi adattivi; red-teaming umano 100%; autori OpenAI/Anthropic/GDM | 02 §2.1 [13][3] | arxiv 2510.09023; Willison 2025/Nov/2 | ✅ | 100% e affiliazioni solo nel post di Willison; il report lo dichiara. |
| 4 | ~93% dei prompt di permesso approvati; gVisor/Seatbelt/bubblewrap/VM Cowork; dominio in allowlist usato per esfiltrare | 02 §2.1 [17] | anthropic.com/engineering/how-we-contain-claude | ✅ | Testuale (25 mag 2026). |
| 5 | Auto mode FPR 0,4% / FNR 17% / 5,7%; stress test FNR 81%, 36,8% via edit di file | 02 §2.1 [18][19] | anthropic.com/…/claude-code-auto-mode; arxiv 2604.04978 | ✅ | "81.0% (95% CI 73.8–87.4)". |
| 6 | Rule of Two di Meta (31 ott 2025); Willison critica l'etichetta "lower risk" su A+C | 02 §2.1 [4][3] | ai.meta.com; Willison | ⚠️ | Willison contestò l'etichetta originale **"safe"**; Meta la cambiò in "lower risk". |
| 7 | OTel GenAI: repo dedicato dal 2026-05-05 senza rilasci; costo non nella spec (PR #443 aperta) | 02 §2.4 [76][77] | api.github.com (repo, releases, tags, pulls/443) | ⚠️ | Repo, 0 release, PR aperta dal 2026-08-09: confermati. "Ultimo rilascio del repo principale che le contiene: v1.41.1" ❔: il repo principale è a **v1.44.0** (4 ago 2026). |
| 8 | SFSpeechRecognizer: "Plan for a one-minute limit"; limiti per dispositivo/giorno | 02 §2.6 [116] | developer.apple.com (JSON) | ✅ | **Assente in v0.1 §13.** |
| 9 | `.voiceChat` senza voice processing: niente AEC/AGC | 02 §2.6 [118] | developer.apple.com (JSON `voicechat`) | ✅ | **Contraddice v0.1 §13.** |
| 10 | `AudioRecordingIntent` richiede Live Activity | 02 §2.6 [119] | developer.apple.com (JSON) | ✅ | Testuale. |
| 11 | SpeechTranscriber: italiano "non verificato" | 02 §2.6 | slide WWDC25 sess. 277 (via blog.addpipe.com) | ⚠️ | Eccesso di prudenza: la slide Apple elenca l'italiano al lancio, come in `00-fonti`. Resta il controllo a runtime. |
| 12 | Prompt caching agentico −41–80% costo, −13–31% TTFT, 500+ sessioni; caching ingenuo può peggiorare la latenza | 01 §2.2 [8] | arxiv 2601.06007 | ✅ | Testuale. |
| 13 | Tool search ~77K→~8,7K ("85%", implica ~89%); MCP 49→74 e 79,5→88,1; PTC −37%; `input_examples` 72→90%; 58 tool ≈ 55K | 01 §2.4 [15] | anthropic.com/…/advanced-tool-use | ✅ | La nota del report sull'incoerenza 85/89% è corretta. |
| 14 | Audit LoCoMo: 6,4% di chiavi errate; giudice accetta 62,81% di risposte sbagliate | 01 §2.3 [35] | dev.to/penfieldlabs | ✅ | 99/1.540; fonte terza, classificata Secondaria. |
| 15 | LLMRouterBench: 400K+ istanze, 33 modelli; +4% o −31,7%; OpenRouter −24,7%; "includere sempre miglior modello singolo e oracolo" | 02 §2.5 [113] | arxiv.org/html/2601.07206 | ⚠️ | Cifre confermate ("up to"; nota 2 sul pool). La "raccomandazione" è una lettura: il paper usa Best Single e Oracle come proprie baseline. |
| 16 | Hindsight: HNSW pgvector + BM25 su GIN + grafo + temporale, RRF, cross-encoder; 83,6% LongMemEval con 20B open | 01 §2.3 [24] | arxiv.org/html/2512.12818 §4.2 | ✅ | Testuale (`cross-encoder/ms-marco-MiniLM-L-6-v2`; 91,4% con Gemini-3 Pro). |
| 17 | CVE-2026-25253 OpenClaw 8.8: `gatewayUrl` da query string + WS automatica con token | 01 §2.7; 02 §2.1 | NVD API; GHSA-g8p2-7wf7-98mq | ✅ | NVD 2026-02-01; GHSA 2026-02-02 (01 scrive 31 gen). |
| 18 | Jev (arXiv): 37 dataset, 27/37 vs Qwen3.8-27B, 37/37 vs Gemma-4-E4B; UNFAIR-ToS 0,50→0,75; 346k richieste <10 USD | 01 §2.5 [110] | arxiv 2609.37647 | ✅ | In più: le probabilità binarie (`noul`) "poorly placed relative to a 0.5 threshold" → soglie da tarare. |
| 19 | jev-bench: 72 esempi, run singola; Jev 94,4%/~185 ms/0,02 USD vs Haiku 4.5 vs Opus 5 | 01 §2.5 [111] | github.com/stern9/jev-bench | ✅ | Tabella identica; "directional". |
| 20 | TypeSafe "193.6x Faster, 444.6x Cheaper"; contesto 64k | 01 §2.5 [114][28] | typesafe.ai | ⚠️ | Claim confermato; il 64k non è in homepage (viene dal blog OpenRouter). |
| 21 | Harness study: 11 harness senza framework né embedding; "loop sophistication does not predict benchmark performance"; memoria persistente come frontiera | 01 §2.1 [2] | arxiv 2609.00006 + PDF | ✅ | Obs. 1 e §9.6 nel corpo. |
| 22 | Scaling agent systems: 260 configurazioni, +80,8%/−70,0% | 01 §2.1 [32] | arxiv 2512.08296 | ✅ | Testuale. |
| 23 | Skill misevolution 21/21, 15 trasferite, 35,3→8,7%; Regression Tax ~6.000 run, "description osmosis" | 02 §2.2 [47][49] | arxiv 2608.12851; 2607.22520 | ✅ | Testuali. |
| 24 | Mastra: `TokenCostControl` approssimato e fail-open; HITL `requireApproval`/"snapshot not found"; workspace skills agentskills.io (`skill`, `skill_read`, `skill_search`) da core 1.1.0; OM 84,23%/94,87% | 02 §2.1–2.2; 01 §2.3 | mastra.ai (4 pagine) | ⚠️ | Tutto confermato tranne la versione 1.1.0 (❔ non in pagina) e le soglie OM 30k/40k (non nella pagina research). |
| 25 | OpenRouter sticky routing via `session_id`, 10 min; cache 1,25×/0,1×; `cached_tokens`/`cache_write_tokens` | 01 [61]; 02 [84] | openrouter.ai/docs/features/prompt-caching | ✅ | Testuale. |
| 26 | Context editing: trigger 100k, keep 3, `clear_at_least`, `compact_20260112`; Hermes MEMORY.md 2.200/USER.md 1.375, snapshot congelato | 01 §2.2–2.3 [11][20] | platform.claude.com; hermes-agent docs | ✅ | Testuali. |
| 27 | Permessi: Claude Code deny→ask→allow, Bash rule "isn't a security boundary"; Agent SDK hooks→deny→ask→modalità→allow→`canUseTool`, tool già approvati non raggiungono il callback | 02 §2.1 [23][24] | code.claude.com (2 pagine) | ✅ | Testuali. |
| 28 | Managed Agents scheduled deployments (jitter ≤15%, 5 s–9 min, 1.000/org, budget per run, no backfill, DST); routines (1 h min, `<routine-fire-payload>`, 100/h e 30/h) | 02 §2.3 [52][53] | platform.claude.com; code.claude.com | ✅ | Tutte presenti. |
| 29 | OpenAI Evals: sola lettura 31 ott, spegnimento 30 nov 2026 | 02 §2.5 [110] | developers.openai.com/…/deprecations | ✅ | Testuale. |
| 30 | Turn detection italiano: LiveKit 14 lingue (TNR it 85,10% del modello testuale deprecato); Smart Turn v3 ~8M param., 23 lingue, "as little as 10ms" | 02 §2.6 [126][128] | docs.livekit.io; github pipecat-ai/smart-turn | ✅ | Smart Turn è alla v3.2. |
| 31 | Keepalive cache 12,5×, ~4 min, break-even ~46 min | 01 §2.2 [39] | arxiv 2607.19214 | ✅ | Preprint a singolo autore, 5 pagine. |
| **32** | "UE as a Library" solo UE 4.27, API Windows (`HINSTANCE`/`HWND`, `UELibrary_WndProc`), un'istanza, nessun riavvio; nessuna menzione di iOS | 04 §2.1 [2] | dev.epicgames.com (4.27) | ✅ | Testuale ("This is permanent; you cannot restart UE4"). |
| 33 | MetaHuman mobile: LOD max 3, texture 2048, capelli a card, no RT; LOD 3 = 2.500 vertici, 283 joint, no animated maps; 669 blendshape solo LOD 0 | 04 §1, §2.1 [4] | dev.epicgames.com/…/platform-support-and-lod-specifications | ✅ | Tabella identica. |
| 34 | `Compat.MAX_GPUSKIN_BONES=75`; la pagina non dichiara esplicitamente il supporto mobile | 04 §2.1 [5] | dev.epicgames.com/…/requirements-and-configuration-settings | ✅ | "maximum number of bones… on mobile GPUs in a single draw call". |
| 35 | Staff Epic, giugno 2025: lip-sync da audio non supportato a runtime | 04 §1 [8] | forums.unrealengine.com/t/…/2611561 | ✅ | M. Streatfield, 20 giu 2025: "we don't directly support audio driven animation at runtime". |
| 36 | UaaL iOS: solo schermo intero, un'istanza, 80–180 MB trattenuti, nessun reload dopo quit | 04 §1 [14] | docs.unity3d.com (UnityasaLibrary + -iOS) | ✅ | Testuali; nota: "Unity Industry customers may see different limitations". |
| 37 | Unity Industry: "not solely for games or entertainment"; runtime "subject to applicable fees and Unity's express authorization" | 04 §1 [17] | unity.com/legal/industry-terms-of-service (3 ago 2026) | ✅ | Testuale; status "Industry" a discrezione di Unity. |
| 38 | Unity vuoto ~20 MB / <12 MB con stripping; Godot 4.6 LibGodot solo Linux/Windows/macOS | 04 §2.1 [19][21] | docs.unity3d.com; godotengine.org/releases/4.6 | ✅ | Data di rilascio Godot non in pagina (❔ minore). |
| 39 | RealityKit: blendshape non si aggiornano durante `playAnimation`, luglio 2025, senza soluzione | 04 §1 [29] | developer.apple.com/forums/thread/793431 | ✅ | Segnalazione utente, nessuna risposta Apple: "problema aperto", non bug confermato (il report lo classifica Opinione). |
| 40 | SceneKit "soft-deprecated" | 04 §2.1 [27] | developer.apple.com (JSON) | ✅ | Testuale. |
| 41 | TalkingHead MIT; nessun modulo italiano; Fi >99,9% ~4k, En ~80% ~12k, CMUdict ~5 MB | 04 §1, §2.3 [32] | api.github.com + README + `modules/` | ✅ | Moduli: de, en, fi, fr, lt, pt_br. |
| 42 | `AVSpeechSynthesisMarker` iOS 16+, `Mark.phoneme` iOS 16, proprietà `phoneme`/`bookmarkName` iOS 17; emissione dalle voci di sistema non documentata | 04 §1, §2.3 [41] | developer.apple.com (JSON, 3 pagine) | ✅ | Disponibilità confermata; nessuna pagina Apple dice quali marker emettano le voci di sistema → spike necessario. |
| 43 | Ready Player Me: acquisita da Netflix 19 dic 2025, servizi offline dal 31 gen 2026; dominio non risolve | 04 §1 [38] | techcrunch.com; `dig readyplayer.me` | ✅ | Confermato anche il DNS. |
| 44 | Soul Machines in amministrazione controllata dal 5 feb 2026, debiti >19,5 M$ | 04 §2.4 [56] | NBR (via ricerca; pagina 403) | ✅ | Receiver KPMG dal 5 feb; 19,5 M (NZD presunti). |
| 45 | eSpeak NG GPL-3.0 | 04 §2.3 [51] | api.github.com/repos/espeak-ng | ✅ | SPDX GPL-3.0. |
| 46 | OVRLipSync senza supporto iOS ufficiale; licenza legata all'hardware Meta | 04 §1 [37] | developers.meta.com (docs Unity) | ⚠️ | Piattaforme: Android, Windows (+macOS), iOS assente ✅; il vincolo di licenza all'hardware non è nei docs (viene da un forum, Opinione). |
| 47 | Royalty Unreal 5% oltre 1 M$ per app runtime non-gioco | 04 §1 [10] | unrealengine.com/license | ❔ | 403 anche per me, come dichiarato dal report; resta su fonti secondarie. |

---

## 3. Contraddizioni e verdetti

**Tra i report.** (1) *Routing*: 01 cita i risparmi di RouteLLM/FrugalGPT, 02 cita LLMRouterBench dove i router commerciali non battono il miglior modello singolo. Non è una contraddizione (benchmark diversi; 01 stesso avverte che i router si trasferiscono male). **Verdetto:** il benchmark M9 include miglior modello singolo, economico fisso e router casuale, e misura a parte il valore di Jev nel decidere memoria/tool/skill. (2) *Memoria*: 01 "recall come tool + snapshot", 02 "memoria come possibile input non fidato": complementari.

**Interne.** (3) *Latenza vocale* (02): 800 ms vs 1.500 ms; il report la risolve ("<1,5 s, 800 ms ambizione"). **Verdetto:** condiviso; v0.1 non ha obiettivi (A.14). (4) *Italiano in SpeechTranscriber* (02 vs 00-fonti/v0.1): la slide WWDC25 lo elenca. **Verdetto:** v0.1.

**Con ARCHITECTURE.md v0.1.**
5. **Trasporto** — 02 §2.7 propone SSE + POST con `Idempotency-Key`, WS solo per l'audio; v0.1 §14 usa WS. **Verdetto: v0.1** (l'audio non lascia il dispositivo; WS già implementato), ma con le semantiche di 02 (A.9).
6. **Eco iOS** — v0.1 §13 si affida a `.voiceChat`; Apple: senza voice processing niente AEC/AGC. **Verdetto: 02** (A.13).
7. **Variazione per richiesta vs cache** — v0.1 cambia a ogni richiesta modello, set di tool, Context Soul e memorie iniettate; ognuna invalida il prefisso di cache (ordine tools → system → messages) [01 §2.2/2.5/2.6]. **Verdetto: 01, con misura**: stabilità a livello di sessione (A.3–A.6); cache hit rate come KPI del benchmark M9. Sfumatura: con TTL 5 min e turni sparsi il beneficio tra turni può essere limitato; dentro un turno con più step di tool è certo.
8. **Conferme per azioni sensibili** — v0.1 "oltre una soglia"; 02 deny→ask→allow fail-closed, approvazione legata ai parametri e monouso. **Verdetto: 02** (A.1).
9. **Sandbox** — v0.1 rinvia a M5; 02: mai nel processo Node, né `vm` né `isolated-vm` da solo. **Verdetto: 02** (B.1).
10. **Framework** — 01 "nessun harness usa framework" vs stack Mastra. 01 stesso ricompone: primitive Mastra, ma assemblaggio del prompt e limiti del loop in proprio. **Verdetto:** coerente con v0.1; attenzione a `instructions`/`tools` come funzioni del `requestContext`, che variano il prefisso per richiesta.
11. **Batch API** (01) non disponibile via OpenRouter (C.4). **Backfill** (02): nessuno per default, flag per automazione (B.6).
12. **Avatar: "Unreal Engine o equivalenti"** — v0.1 §13 elenca UE5/MetaHuman "in app SwiftUI esistente" tra le opzioni da confrontare; 04 mostra che **non esiste un percorso di embedding iOS documentato** (#32), che MetaHuman su mobile perde le blendshape (#33) e che il lip-sync da audio non è supportato a runtime (#35). **Verdetto: 04.** Il confronto è deciso dalle evidenze: Unreal entra in M10 solo come app "UE-first" o Pixel Streaming, entrambi incompatibili con i vincoli di Ernie (SwiftUI, on-device). Gli "equivalenti" sostenibili sono RealityKit (nativo) e three.js/TalkingHead in WKWebView; Unity solo con conferma scritta sulle fee "Industry".
13. **Lip-sync on-device** — v0.1 §13 elenca "visemi da fonemi/testo, audio-to-viseme, o ampiezza" senza ordine; 04 li ordina: callback di parola + G2P italiano (certo), marker fonemici (da verificare), ampiezza via `write()` (secondario). **Verdetto:** adottare l'ordine di 04 (B.11).

---

## 4. Lacune residue e come colmarle

| Lacuna | Perché conta | Come colmarla |
|---|---|---|
| **Passthrough OpenRouter** delle feature native (`cache_control`, effort/thinking, tool search, `input_examples`, context editing) | Metà delle ricette di 01 sono Claude-specifiche | Spike **M2** con richieste reali e lettura di `cached_tokens`; esito in `00-fonti`. |
| **Come Mastra costruisce la richiesta** (ordine tool, posizione di `instructions`, memoria) | Decide se il prefisso stabile è ottenibile | Log del payload in M2; se non controllabile, assemblaggio proprio e Mastra per storage/memoria/tool. |
| **Embeddings** e qualità in italiano (OpenAI 1536 vs fastembed 384) | Costo e recupero | Corpus etichettato in italiano in M4 con recall@k per modello. |
| **Firecrawl / web** come superficie specifica | Unico canale non fidato nelle prime milestone | Test di injection su pagine reali in M5; cap di token; stripping di URL immagine. |
| **Injection vocale** (02 la dichiara aperta) | Ernie legge ad alta voce contenuti esterni | Contenuti non fidati letti con prefisso attributivo; mute logico del riconoscitore già in v0.1. |
| **Portabilità, cancellazione, retention** | Memoria di anni | Specifica M4: export per utente, purge con retention. |
| **Turn detection semantica on-device** | Fine turno senza server | Spike M8: Smart Turn v3 in CoreML; fallback silenzio 500–800 ms. |
| **Jev: latenza e deriva** misurate | Timeout 1,5 s ipotetico; p50 ~185 ms su 72 esempi | Telemetria dal M3; soglie `noul` per domanda (#18). |
| **Marker fonemici con le voci italiane** (04 §5.1) | Decide l'intera pipeline di lip-sync | Spike S1 (§5.B.11) su dispositivo iOS 26. |
| **Prestazioni reali su iPhone** (RealityKit, WKWebView/WebGL, MetaHuman): FPS, batteria, termica, dimensioni binari | Nessun dato in 04 | Spike S2–S3 e App Thinning Size Report per ogni candidato. |
| **G2P italiano**: nessun benchmark di accuratezza | Qualità del lip-sync da testo | Set di valutazione contro un lessico fonetico italiano (S4). |
| **Studi longitudinali su assistenti personali** (assenti ovunque) | Non colmabile | Golden set personale dal M2. |

---

## 5. Implicazioni per Ernie

Priorità **P1** necessaria · **P2** importante · **P3** utile. Costo: basso / medio / alto.

### A. Adottare subito (M2–M3)

| # | Cosa cambiare (sezione / milestone) | Perché | Pr. | Costo |
|---|---|---|---|---|
| A.1 | **Policy Engine** (§15, M3): deny → ask → allow deterministico fuori dall'LLM, fail-closed per tool sconosciuti; approvazione legata a (tool, hash argomenti, utente, scadenza), **monouso** e consumata atomicamente; audit append-only con ID approvazione e versione policy; nessun controllo in punti scavalcabili da una regola allow. | 02 §2.1 [7][23][24]; #27 | P1 | medio |
| A.2 | **Rule of Two come taint di run** (§15, M3): tool etichettati `readsPrivate`/`ingestsUntrusted`/`externalEffect`; quando entra contenuto non fidato (web, webhook, MCP) la run è *tainted* e ogni tool `write|external` passa in `ask`; automazioni con payload esterno partono tainted. | 02 §2.1 [1][4][12]; #6 | P1 | basso |
| A.3 | **Prefisso stabile** (§4, §5, M2): ordine fisso tool (deterministico) → Core Soul → snapshot memoria → riassunto → turni → messaggio; data/ora e parti variabili in coda; JSON deterministico; `cache_control` sul blocco stabile; cache hit rate in `llm_calls`. | 01 §2.2 [7][9][55][57]; #12 #25 | P1 | medio |
| A.4 | **Set di tool stabile per sessione** (§9, M3/M5): core (memoria, web, orario) sempre presente; le categorie Jev non mutano l'array `tools` per turno ma abilitano categorie a livello di sessione oppure caricano definizioni via meta-tool `tool_search` + `call_tool`; la policy restringe. Verificare in M2 come Mastra ordina i tool. | 01 §2.2/2.4 [7][13][15][17]; #13 | P1 | medio |
| A.5 | **Classe di modello con isteresi di sessione** (§5, §11, M3): decisa a inizio sessione, cambia solo in salita (`heavy` per un turno con `deepReasoning`); `light` solo per chiamate ancillari fuori banda, mai per i turni conversazionali. Da validare con i dati di cache in M9. | 01 §2.5/2.6 [9][61][117] | P1 | basso |
| A.6 | **Context Soul e memoria fuori dal prefisso** (§7, §8, M2): Context Soul scelto a livello di sessione o dopo il breakpoint di cache; memorie recuperate nel turno utente; **profilo compatto (1–3k caratteri) come snapshot congelato per sessione**; `memory_search` come tool. | 01 §2.2/2.3 [20][26][55]; #26 | P1 | medio |
| A.7 | **Budget rigidi nel router** (§5, §12, M3): token non in cache, costo, step, profondità; stuck detector su hash(tool, argomenti, esito) con soglie più alte per tool di polling; non affidarsi a `TokenCostControl`. | 01 §2.1 [2][3]; 02 [27]; #24 | P1 | basso |
| A.8 | **`llm_calls` fonte di verità dei costi** (§12, M2): `cost_reported` (`usage.cost`), `cost_estimated`, `cost_source`, token input/cache read/cache write/output/reasoning, TTFT; riconciliazione su `GET /api/v1/generation`; test contro i doppi conteggi; `session_id` OpenRouter = sessione Ernie. | 02 §2.4 [76][84][88]; 01 [61]; #25 | P1 | basso |
| A.9 | **Protocollo v1.1** (§14, M2): `persist: bool`; `user.cancel` idempotente e disaccoppiato dalla disconnessione; snapshot + replay al ritorno in primo piano; campo `spokenThroughIndex` nel cancel (barge-in); auth e controllo `Origin` sull'upgrade WS; nessuna connessione verso URL da deep link/query string. | 02 §2.7 [35][64][66][67]; #17 | P1 | basso |
| A.10 | **Eventi `avatar.*` tipizzati** (§14, M2): `avatar.emotion {name, intensity}`, `avatar.gesture {name}`, `avatar.gaze {target}` ancorati a `charOffset` nel testo, con **vocabolario chiuso** (preset VRM o mood TalkingHead); prodotti dall'LLM via schema strutturato, mai da testo libero. | 04 §2.4 [32][34][54][55] | P2 | basso |
| A.11 | **Soglie Jev tarate, mai 0,5** (§6, M3); `noul` come segnale di rischio che può solo restringere la policy. | 01 §2.5 [28][110]; #18 | P1 | basso |
| A.12 | **RLS Postgres `FORCE`** sulle tabelle utente (§15, da M2), ruolo applicativo non owner e senza `BYPASSRLS`; namespace per utente su Redis/BullMQ. Limite: tabelle `mastra_*` gestite da Mastra, da verificare. | 02 §2.1 [33][7] | P2 | medio |
| A.13 | **Correzione §13 audio iOS**: `.playAndRecord` + `setVoiceProcessingEnabled(true)`; documentare il **limite di 1 minuto** di SFSpeechRecognizer (rotazione delle richieste nel fallback). | 02 §2.6 [116][118]; #8 #9 | P1 | basso |
| A.14 | **Obiettivo di latenza vocale in §13**: p50 < 1,5 s di latenza udibile, 800 ms ambizione; strumentazione per stadio. | 02 §2.6 [124][129][130] | P2 | basso |
| A.15 | **Riformulare §13 Avatar e M10**: traccia primaria RealityKit, alternativa three.js/TalkingHead in WKWebView; Unreal/MetaHuman declassati (C.13); contratto dell'asset **52 blendshape ARKit + 15 visemi Oculus**, sorgente Blender di proprietà (VRM/GLB/USDZ); l'avatar è **consumatore** della macchina a stati Swift (idle/ammiccamento/sguardo sul client; barge-in chiude la bocca entro un frame); modalità ridotta con Reduce Motion, stato termico, basso consumo; primo download < 200 MB. | 04 §2.2, §2.5, §2.6 [19][28][32][35][36][62][63]; #32–35 #43 | P1 (doc ora) | basso |

### B. Pianificare (M4–M10)

| # | Cosa cambiare | Perché | Pr. | Costo |
|---|---|---|---|---|
| B.1 | **Sandbox (M5)**: container dedicato con gVisor o microVM; nessuna rete per default; nessun segreto montato (proxy esterno allega il token alle sole operazioni approvate); capability droppate, `no-new-privileges`, tmpfs `noexec`, limiti CPU/memoria/tempo/processi; egress con allowlist per dominio trattata come capability. | 02 §2.1 [16][17][28][29][31][34]; #2 #4 | P1 | alto |
| B.2 | **Skill (M5)**: formato agentskills.io (compatibile con Mastra); stati `draft→proposed→tested→approved→active→deprecated`; versioni immutabili per hash; due classi di rischio; scansione alla scrittura **e al recupero**; eval con/senza skill contando guadagni e regressioni; suite ripetuta a ogni cambio di modello; run programmate non creano skill. | 02 §2.2 [39][41][43][45][47][49]; #23 #24 | P1 | medio |
| B.3 | **Memoria (M4)**: fatti con `valid_from/valid_to/created_at/expired_at`, FK all'episodio, `provenance.trust` (memoria da contenuto non fidato = gamba [A] al recupero); ibrido top-20+top-20 con RRF k=60; HNSW m=16/ef_construction=64; chunk con prefisso contestuale dal modello `light`; valutazione su LongMemEval S/M e golden set, non LoCoMo. | 01 §2.3 [21][22][23][24][35][82]; #14 #16 | P1 | medio |
| B.4 | **Observational Memory di Mastra** in A/B interno (M4). | 01 §2.3 [26]; #24 | P3 | basso |
| B.5 | **Tool (M5)**: Zod → JSON Schema 2020-12, strict mode dove supportato; `response_format` concise/detailed; paginazione; tetto di token per risultato con handle; errori azionabili `isError`; chiave di idempotenza; MCP solo Streamable HTTP senza Roots/Sampling/Logging; conferme via `requireApproval` di Mastra con storage. | 01 §2.4 [14][16][17][97]; 02 [26]; #1 #24 | P1 | medio |
| B.6 | **Automazioni (M6)**: `automations` con allowlist tool, budget per run, timezone IANA; `automation_runs` con stati `scheduled/claimed/running/succeeded/failed/skipped/budget_exceeded/awaiting_approval` ed esito strutturato distinto dal successo infrastrutturale; `jobId = automation_id:scheduled_at`; retry con backoff+jitter solo su errori transitori in un solo livello; dead-letter con alert deduplicato; anti-ricorsione; payload esterni non fidati; jitter; `catchUp: none|latest` (default none); evitare la fascia 1–3; azioni sensibili → `awaiting_approval`; risultati letti all'apertura dell'app. | 02 §2.3 [51][52][53][56][59][62]; #28 | P1 | medio |
| B.7 | **Client iOS (M7–M8)**: nessuna immagine markdown da URL esterni; step-up Face ID per azioni critiche; kill switch; sessione vocale in primo piano o `AudioRecordingIntent` + Live Activity; nessuna wake word; VAD + fine turno semantico (Smart Turn v3 in CoreML) con 500–800 ms iniziali; barge-in = stop locale + cancel con `spokenThroughIndex`; TTS incrementale per frase. | 02 §2.6 [115][119][124][128]; #10 #30 | P1 | alto |
| B.8 | **Valutazione (M9)**: test deterministici in CI (router, policy, skill, idempotenza); 20–50 scenari da fallimenti reali sullo stato finale; giudice LLM di famiglia diversa calibrato su ~100 esempi; **pass^k (k=3–5)** per automazioni e azioni sensibili; A/B appaiato router vs miglior singolo vs economico vs casuale con costo reale e IC; gate di regressione a ogni cambio. Nessuna dipendenza da OpenAI Evals. | 02 §2.5 [87][91][93][108][112][113]; #15 #29 | P1 | medio |
| B.9 | **Hardening (M9)**: Docker secrets anziché `ENV`; OTel opzionale con semconv **fissate**, token solo sugli span di inferenza, contenuti opt-in redatti; nessuna piattaforma di tracing come dipendenza. | 02 §2.1 [8]; §2.4 [76][80]; #7 | P2 | medio |
| B.10 | **Compressione a gradini (M4)**: clearing/masking degli output vecchi dei tool, poi riassunto con `light`, allineato ai confini di cache; handle per ripristinare. | 01 §2.2 [4][10][11]; #26 | P2 | medio |
| B.11 | **Spike avatar prima della decisione M10** (eseguibili da M7–M8, perché toccano il TTS): **S1** registrare tutti i marker di `speak()` e `write()` con le voci italiane compact/enhanced/premium su iOS 26 (decide se i marker fonemici sono usabili); **S2** scena RealityKit minima con USDZ (52 ARKit + visemi) da Blender: blendshape aggiornate durante un'animazione scheletrica su iOS 26; **S3** WKWebView + TalkingHead con GLB: FPS, CPU, batteria, stato termico per 10 min e latenza callback→visema; **S4** G2P italiano a regole (c/g contestuali, geminate, accento) valutato contro un lessico fonetico; **S6** App Thinning Size Report per ogni candidato. Decidere su RealityKit vs WKWebView solo dopo S1–S3. | 04 §2.3, §2.6, §5 [29][30][32][41][50]; #39 #41 #42 | P1 | medio |
| B.12 | **Pipeline lip-sync (M10)**: livello 1 callback di parola + G2P italiano a regole in Swift (kokorog2p Apache-2.0 come riferimento, **niente eSpeak NG** nell'app); livello 2 marker fonemici se S1 li conferma; livello 3 ampiezza RMS via `write()` per modulare la mascella; budget di sincronia: audio non più di ~45 ms in anticipo sulle labbra. Il G2P resta on-device: il backend continua a inviare solo testo ed eventi. | 04 §2.3 [40][41][50][51][53][60]; #42 #45 | P1 | medio |

### C. Respingere o attendere

| # | Proposta | Verdetto | Motivo |
|---|---|---|---|
| C.1 | SSE + POST con `Idempotency-Key`, WS solo audio (02 §2.7) | Respinta (semantiche in A.9) | Audio on-device; WS implementato; bozza IETF scaduta. |
| C.2 | Adozione di AG-UI (02 §2.7) | Respinta | Nessun SDK Swift, nessun ID/sequenza in `BaseEvent`. |
| C.3 | Durable execution (Temporal/Inngest) (02 §2.3) | Attendere | Sistema in più; BullMQ + idempotenza copre M6. |
| C.4 | Batch API notturna (01 §2.6) | Attendere | Non disponibile via OpenRouter. |
| C.5 | Keepalive della cache (01 §2.2) | Respinta per ora | Preprint singolo autore; break-even ~46 min; volume basso. |
| C.6 | Memoria come file git (Letta) (01 §2.3) | Respinta | Evidenze da coding/LoCoMo; Postgres fissato. |
| C.7 | Multi-agente (01 §2.1) | Respinta | Fino a −70% su compiti sequenziali; Ernie è un agente singolo. |
| C.8 | Langfuse self-hosted / Helicone (02 §2.4) | Respinta | ClickHouse in più; Helicone in maintenance. |
| C.9 | `input_examples`, tool search nativo, context editing server-side, effort per-messaggio (01) | Attendere lo spike M2 | Feature Anthropic-specifiche, passthrough OpenRouter da verificare. |
| C.10 | BM25 vero con estensione (01 §2.3) | Attendere | `tsvector` + RRF basta al volume iniziale; misurare in M4. |
| C.11 | Semantic cache di risposte/decisioni (01 §2.5) | Respinta | Falsi hit e collisioni (86%); solo cache esatta con TTL. |
| C.12 | S2S / GPT-Live (02 §2.6) | Attendere | Costi 3–5× (opinione); nessun controllo di policy prima del parlato. |
| C.13 | **Unreal Engine embedded / MetaHuman** (04 §2.1, §2.6 b) | **Respinta** come traccia M10 | Nessun embedding iOS documentato (#32); LOD 3 senza blendshape (#33); lip-sync da audio non a runtime (#35); nessun benchmark iPhone; ~300 MB (opinione); licenze non verificabili (#47). Riconsiderabile solo se l'utente accetta un'app "UE-first". |
| C.14 | **Pixel Streaming** (04 [12]) | Respinta | GPU server e video streaming contraddicono il vincolo on-device. |
| C.15 | **Unity as a Library** (04 §2.1) | Attendere | Solo schermo intero, un'istanza, 80–180 MB trattenuti (#36); classificazione "Industry" e fee runtime a discrezione di Unity (#37): serve conferma scritta prima di qualunque spike. |
| C.16 | **Godot / SwiftGodotKit** (04 [21][22]) | Attendere | LibGodot ufficiale solo desktop (#38); integrazione iOS da progetto della community. |
| C.17 | **Audio2Face-3D, OVRLipSync, modelli accademici audio→viso** (04 §2.3) | Respinte | GPU NVIDIA server; iOS assente (#46); incompatibili con TTS on-device. |
| C.18 | **Ready Player Me, Soul Machines, generatori SaaS** (04 §2.2) | Respinte | Servizi chiusi o in amministrazione controllata (#43–44); possedere l'asset sorgente. |
| C.19 | **eSpeak NG nell'app** (04 §2.3) | Respinta | GPL-3.0 (#45) incompatibile con la distribuzione App Store. |
| C.20 | **Export MetaHuman verso runtime non-Unreal** (04 §2.2) | Attendere | Licenza da fonti secondarie, fattibilità tecnica non verificata; eventuale spike S5 solo se S1–S3 falliscono. |
| C.21 | **Rive / Live2D (2D–2.5D)** (04 §2.4, §2.6 a3) | Attendere | Riserva se l'utente accetta un avatar non volumetrico; verificare la clausola Live2D "Expandable Applications". |

**Scenario sostenuto dalle evidenze (04 §2.6):** il report sostiene con fonti primarie sufficienti lo scenario **(a) MVP leggero**, nelle varianti RealityKit (a1) e three.js/TalkingHead in WKWebView (a2), e la sua evoluzione **(c) stilizzato su RealityKit** con asset ARKit+visemi. Lo scenario **(b) fotorealistico MetaHuman** non è sostenuto: le evidenze primarie sono tutte negative e quelle su licenze e peso sono secondarie o di community. Le varianti Unity e Godot di (c) sono bloccate rispettivamente da licenza e maturità. La scelta tra a1 e a2 non è decidibile sulla carta: dipende da S1–S3.

---

## 6. Conferme delle decisioni v0.1

Scelte che i report sostengono e **non vanno rimesse in discussione**: deterministico prima, LLM dopo (01 [1][2]); **Jev** come decision model con fallback e soglie tarate (01 [28][109][110][111]; #18–19); **Mastra** per storage/memoria/tool/HITL con API HTTP propria senza `@mastra/fastify` (01 [120][2]; 02 [26]); **Postgres+pgvector con ricerca ibrida e RRF**, contraddizioni che supersedono (01 [21][22][24][82]; Hindsight #16); consolidamento asincrono con `light` (01 [25][26][70]); catalogo tool filtrato e audit per chiamata (01 [13][14][15]); contenuti esterni come dati non fidati (02 [12][14], reso deterministico in A.2); **sicurezza non delegata ai modelli** (02: ASR >90%, FNR 81%, 93% approvazioni); BullMQ con scheduler, retry, dead-letter (02 [56][59]); **STT/TTS on-device**, nessun ascolto in background garantito, italiano incluso (02 [115][119][120]; #11); protocollo con `id`/`seq`/`correlationId`, replay, `audience` (02 [63][66][67][72]); nessuna dichiarazione di risparmio senza benchmark (01 [33][34]; 02 [87][91][113]); OTel opzionale e tardivo (#7); Firecrawl sostituibile (non contraddetto). Per l'avatar: **lip-sync on-device** e **backend che invia solo suggerimenti strutturati** `avatar.*` (04 §2.3–2.5 [32][40][54][55]: è lo schema di Convai, Inworld e TalkingHead); **decisione rinviata a dopo la ricerca e a uno spike comparativo** (04 §5: le lacune sono proprio quelle che solo uno spike su dispositivo chiude).

---

## 7. Testo a forma di istruzione nei report

I tre report contengono, per costruzione, molto testo imperativo: le sezioni "Implicazioni pratiche per Ernie", il sommario di 02, la **checklist §3 di 02** (voci "[ ] …") e le raccomandazioni di 04 ("Non incorporare eSpeak NG nell'app", "Prendere come contratto dell'asset…"). Le ho trattate come **proposte da valutare**, non come direttive: ciascuna compare in §5 con verdetto e motivazione, e diventa criterio di accettazione solo tramite questa revisione e l'aggiornamento di ARCHITECTURE.md v0.2. Non ho trovato testo anomalo o estraneo all'ambito (istruzioni a eseguire comandi, aprire URL, modificare configurazioni, ignorare istruzioni precedenti; contenuti codificati). Gli URL sono riferimenti bibliografici, usati come dati per le verifiche. 02 e 04 marcano le proprie sintesi come "Opinione"/"deduzione"; 01 lo fa con le etichette di affidabilità in bibliografia: la distinzione tra evidenza e raccomandazione è sempre ricostruibile.
