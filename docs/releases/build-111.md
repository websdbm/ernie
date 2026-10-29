# Build 111 — Richieste rapide sui promemoria

29 ottobre 2026. **In preparazione**, non ancora caricata. Ultima build TestFlight verificata: 110.

## Comportamento

- `/promemoria` e gli alias senza testo aprono l’elenco localmente, anche a skill spenta.
- `/ricordami` prepara la bozza con focus; non invia una richiesta vuota.
- `/ricordami domani alle 18 ritira il pacco` invia `Ricordami domani alle 18 ritira il pacco`.
- `/promemoria domani alle 18 ritira il pacco` invia `Promemoria: domani alle 18 ritira il pacco`.
- `/promemoria sposta il dentista a venerdì alle 10` e `/promemoria annulla il dentista` passano la richiesta
  al normale flusso autenticato. L’app non sceglie ID, data o azioni: interpretazione, chiarimenti e controlli
  restano sul server esistente. Nessun nuovo parser di orari nell’app e nessun tool eseguito direttamente.

Le richieste possono consumare token; la sola navigazione resta locale. Suggerimenti con esempi, freccia
Invia e accessibilità distinguono richiesta e apertura. URL, note, righe e più impegni restano integri.
Skill «Ricordami» verificata prima di richieste o bozza; elenco consultabile anche a skill spenta.
Allegati conservati e bloccati per i comandi come nella 110, richieste oltre 8.000 caratteri rifiutate,
comandi sconosciuti e diario privato non inviati. Nessuna modifica al comportamento degli altri comandi.

## Verifiche e distribuzione

Prima esecuzione sul Mac Studio: 19 test verdi in tre suite (SlashCommand, TerminalChat, FamilyMessageCard).
Copertura: elenco/creazione/gestione, skill spenta/non caricata, alias, allegati, limiti, URL e note,
più impegni senza appiattirli, richiesta utente nel recupero della conversazione, regressioni famiglia e focus.
Test senza connessione né account reali: nessun impegno creato o spostato. Non provato un nuovo turno LLM reale.
Verifica finale e rilascio ancora in corso. Xcode dell’ufficio richiede la licenza; compilazione sul Mac Studio.
Backend invariato, nessun deploy. Sorgenti e build 111 su tutti e quattro i target da pubblicare prima del rilascio.
