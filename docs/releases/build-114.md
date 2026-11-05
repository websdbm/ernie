# Build 114 — Archivio chat

5 novembre 2026. **In preparazione: non ancora distribuita.**

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
Contesto limitato (300 messaggi e 90.000 caratteri), copertura parziale dichiarata e ID delle fonti validati:
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
- Nessuna chat reale importata nelle prove. Distribuzione e prova LLM reale ancora da completare.
- Deployment richiede migrazione additiva `0050_chat_archives.sql` e API nuova; worker invariato.
- Sorgenti da pubblicare e SHA GitHub da verificare prima di archiviare/distribuire la build 114.
