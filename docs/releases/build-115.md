# Build 115 — Più compiti, meno attese

9 novembre 2026. **Sorgenti pronti; pubblicazione non ancora effettuata.**
Versione distribuita corrente: 114, riletta in App Store Connect come VALID.
API corrente: sorgenti `5734a281ebf09e716ff453bcc68ff6f8754ccb03`; nessuna modifica alla produzione in questa sessione.

## Modifiche

- Fino a tre compiti indipendenti nell'app; precisazioni indirizzate al lavoro corretto e scelte esplicite
  nei casi ambigui. Microfono utilizzabile durante il lavoro, senza cancellarlo; Stop distinto.
- Messaggi da assegnare conservati per account, ripresa delle sessioni e bozze separate. Solo il compito
  visibile parla; notifiche globali ricevute una volta. Cronologia protetta per i compiti in corso.
- Preparazione agente/contesto sovrapposta, caricamenti iniziali condivisi, frammenti di testo raggruppati
  senza ritardare il primo, salvataggi locali fuori dal main thread e rilascio tempestivo del turno.
- Tool `time_windows` per calcolare conflitti e spazi liberi su dati espliciti, senza salvare o notificare.
- Scritture dei tool in coda per account, letture parallele; timeout non ripete scritture con esito incerto.
- Pulsanti/font/spaziature condivisi nelle schede e raccolte, testi completi e compatibilità con temi e
  dimensioni accessibili. Non cambiano permessi, conferme o isolamento del diario e dell'Archivio chat.

Analisi, misure e limiti in [performance e concorrenza](../research/21-performance-concurrency.md).

## Verifiche

- 111 test backend, dieci suite: preparazione, protocollo, stream, annullamento, tool, coda delle scritture,
  calcolo intervalli, autorizzazione e classificazione. TypeScript e Biome verdi.
- 47 test iOS, cinque suite: coordinamento reale dell'app senza rete/account, scelte, tre sessioni,
  risultato in ritardo, messaggi in attesa, separazione voce, cronologia, font e layout accessibili.
  Simulatore Mac Studio «Ernie prova», Xcode 27.0. Anteprime native ispezionate.
- Classificatore reale su quattro casi sintetici: 4/4 corretti, 963–2.348 ms, 33–64 token output,
  zero reasoning; nessun dato personale inviato. Campione puntuale, non garanzia statistica.
- Nessuna migrazione, scrittura nel database reale, notifica o messaggio a terzi nelle prove.

## Rilascio

Sorgenti della build: da registrare dopo il push. Archivio/export: da verificare dal commit pubblicato.
Nessun caricamento TestFlight né deploy backend autorizzato per questa release finora.
Prima del deploy effettuare backup e aggiornare la sola API da Git; nessuna migrazione richiesta.
Worker, Redis, Postgres e configurazioni possono rimanere invariati. Un backend precedente mantiene le
scelte manuali ma non offre classificazione automatica e nuovo tool.

Le prove su iPhone fisico, durata batteria con tre connessioni, comportamento sotto sospensione iOS e
latenze con rete mobile non sono comprese nei test del simulatore. Non si promette esecuzione continua
dell'app in background; si mantiene il recupero delle richieste esistente.
