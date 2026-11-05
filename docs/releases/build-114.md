# Build 114 — Archivio chat

5 novembre 2026. **Disponibile su TestFlight**, gruppo **Interni**. API pubblicata e sana.
Apple **VALID**, **IN_BETA_TESTING**, Build ID `1bf03f8d-f095-43b5-bed4-9d97486cbf17`.
Note italiane rilette e confrontate con il changelog: **899 caratteri**.

Skill attivabile per account, distinta dal Second Brain. Testi e indice sul backend Ernie, separati per utente
(RLS forzata e chiavi composite) e chat. L’app importa TXT o TXT contenuto nello ZIP di WhatsApp, fino a 8 MB
per file/16 MB di testo estratto; non legge media. Report di nuovi, già presenti e anomalie prima/dopo import.
Originali e provenienza mantenuti. Nome uguale non equivale alla stessa chat: confronto di sequenze, proposta
di destinazione e scelta manuale. Reimportazione identica senza duplicati; import concorrenti serializzati.

Raccolta con ricerca, categoria/tag, descrizione, tipo privata/gruppo, partecipanti osservati e tre stati distinti:
ultimo import, ultimo messaggio disponibile, revisione/data dell’indice. Ricerca full-text PostgreSQL con filtri
per mittente/periodo e messaggi vicini; nessun embedding automatico o elaborazione AI all’importazione.
Q&A e modalità rapide (24 ore, settimana, decisioni, attività, date e brief), fonti apribili nel contesto originale.
Analisi isolata senza strumenti, memoria, altre chat o profilo generale. Consenso AI esplicito a ogni analisi,
budget/consumi ordinari; risposta e follow-up restano nella sezione, non nel transcript principale.
Contesto limitato (300 risultati con eventuali messaggi vicini, entro 90.000 caratteri), copertura parziale dichiarata e ID delle fonti validati:
questo non garantisce da solo la correttezza semantica di ogni affermazione generata.

`/archivio`, menu laterale e «apri archivio chat» aprono la raccolta. Un riferimento esplicito dalla chat principale
viene intercettato prima della cronologia e apre una ricerca separata; selezione di conversazione se ambigua.
Il risolutore usa solo metadati, senza LLM. Scansione limitata a 1.000 schede, poi ricerca paginata manuale:
nessuna autoselezione su cataloghi incompleti. Nessun trasferimento automatico al Brain. «Salva nel Second Brain…»
mostra testo modificabile, provenienza e inclusione facoltativa delle fonti, poi richiede conferma esplicita.

Condivisione iOS di TXT/ZIP instradata a una coda separata, protetta e legata alle credenziali di destinazione.
Un file archivio riconosciuto ma illeggibile non ricade mai nella condivisione generica verso il Brain.
Dettatura locale della domanda, lettura locale della risposta, arresto a uscita/blocco e annullamento analisi.
WhatsApp: numero internazionale inserito dall’utente per `wa.me` con bozza; gruppi/canali tramite link ufficiale
salvato e condivisione/copia della bozza con scelta manuale del destinatario. L’app non invia messaggi.
[Documentazione ufficiale click-to-chat](https://faq.whatsapp.com/5913398998672934).

## Verifiche e pubblicazione

- Database di prova PostgreSQL/pgvector 17 isolato, tutte le 50 migrazioni; ruolo applicativo non proprietario.
  Import 100→reimport 0→15 nuovi, omonimi, ripetizioni nello stesso minuto, prepend storico, FTS e filtri,
  RLS fra utenti, chiavi composite, cancellazione, import concorrenti e coerenza revisione/indice verificati.
- Test HTTP/servizio con consenso, permessi, account/chat estranei, fonti inventate, copertura, indice arretrato,
  risoluzione solo metadati e redazione di errori contenenti testo sensibile.
- **56 test backend verdi**, inclusi 7 PostgreSQL reali; TypeScript/Biome verdi.
- **23 test iOS verdi in tre suite** sul simulatore dedicato «Ernie prova» del Mac Studio, inclusi
  10 del nuovo modulo. Rendering nativo chiaro, scuro, Borg e caratteri accessibili ispezionato;
  sorgenti finali ricompilati dopo la correzione di import e invalidazione risposte.
- Prova reale Haiku 5.5 → Sonnet 5.5 su soli messaggi sintetici: proposta, modifica e conferma distinte,
  fonti valide, nessuna esecuzione del testo ostile importato. Due chiamate: 963+1.497 token di input,
  231+656 di output. È una verifica puntuale, non una misura generale di accuratezza.
- Smoke HTTPS pubblico con due account temporanei: attivazione skill, anteprima senza salvataggio,
  reimportazione idempotente, nuovi messaggi, RLS fra account, ricerca, descrizione, selezione archivio,
  consenso e cancellazione verificati. Zero sessioni principali create. Account e chiavi di prova eliminati.
- Nessuna chat reale importata nelle prove; database isolato di test rimosso dopo i test.

## Deployment e artefatti

Sorgenti **`5734a281ebf09e716ff453bcc68ff6f8754ccb03`**, pubblicati su GitHub e SHA remoto verificato
prima dell’archivio iOS e del deploy. **297 input iOS** verificati per SHA-256 rispetto all’export Git pulito;
**19 file iOS cambiati** identici alla copia effettivamente testata sul Mac Studio.
Archivio Release ed export riusciti. IPA Apple Distribution deep/strict, quattro target alla 114,
entitlements conformi, gruppo Keychain del diario privato solo nell’app principale. Changelog e WAV conformi.
IPA **81.749.896 byte**, SHA-256 `c76e684df029a34350a684a2fc9ed01885f86ae79eb65bf4b07004891abafd6d`.
Caricata la stessa IPA verificata, `UPLOAD SUCCEEDED with no errors`;
Delivery UUID `1bf03f8d-f095-43b5-bed4-9d97486cbf17`. Apple **VALID**, **IN_BETA_TESTING**, assegnata automaticamente a **Interni**; note italiane verificate.
Nessuna installazione diretta su iPhone, chiave copiata o modifica al Portachiavi.

API staging3 dalla stessa revisione, immagine
`sha256:ae6ff1f360740985a9b495ef16bc3a5405830444ad4756cfd76585cf9d452936`,
avvio `2026-11-05T11:13:33.677463870Z`. Migrazione **50 soltanto**, 50 totali, health HTTPS `ok`,
container `healthy`; sei moduli compilati identici al codice locale testato. Worker/Postgres/Redis invariati.
Il campo versione del health mantiene l’etichetta preesistente della 106 dal `.env`: identificare il deploy
tramite commit/immagine/hash. Configurazioni `.env` e override identiche al backup; nessun riavvio VPS.
Backup protetto `/srv/staging3/backups/ernie-pre-chatarchive-20261105/checkout`, dump PostgreSQL verificato
(7,7 MB), immagine `ernie-app:pre-chatarchive-20261105`. Rollback API possibile con l’immagine precedente:
le tabelle aggiunte sono compatibili con il codice precedente, non eliminarle insieme ai dati.

Manifest e log sul Mac Studio: `~/Library/Caches/ernie-builds/build-114-20261105-chatarchive/`.
Evidenze sull’ufficio: `~/Library/Caches/ernie-checks/chatarchive-20261105/`; sul server:
`/srv/staging3/checks/chatarchive-20261105/`. Nessun testo di chat reale o credenziale aggiunto al repository.
Le descrizioni sono modificabili dall’utente (o salvabili da un brief AI richiesto): nessuna sintesi automatica
all’import. I nomi dei mittenti sono etichette dell’esportazione, non identità verificate o contatti collegati.
