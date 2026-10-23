# Build 99 — Orso e palette, cursore Borg

Data: 23 ottobre 2026. Rilascio in preparazione; TestFlight non ancora caricato.

## Modifiche

- Dodici palette, una per costume, con varianti chiare/scure. Borg usa Bash verde.
- Un unico selettore Orso e palette nelle impostazioni e scelta dalla capsula.
  Rimosso l'interruttore Terminale; la precedente preferenza non viene più letta.
- In Automatico avatar e colori condividono lo stesso costume risolto.
- Cursore verde rettangolare effettivamente disegnato e pulsante, senza prompt `>`.
  Selezione e IME conservano gli indicatori nativi; Riduci movimento evita il lampeggio.
- Preservata la gestione del focus separata UIKit/SwiftUI della build 98.

## Verifiche

- Debug: 18 test in 3 suite (`TerminalChatTests`, `ConfirmationTests`, `ReadabilityTests`), passati.
- Nessun ciclo AttributeGraph nel log Debug.
- Ispezione visiva delle 24 schermate native dei dodici costumi e della barra
  con cursore realmente visibile. Contrasti principali almeno 4,5:1.
- Release: 6 test della suite `TerminalChatTests` passati; nessun ciclo AttributeGraph.
- Nessuna prova su iPhone fisico in questa sessione.

[Dettagli e anteprime](../ui/chat-terminal.md).

Nessuna modifica backend. Il rilascio deve usare il commit pubblicato su GitHub;
SHA, firma dell'IPA e stato TestFlight saranno registrati dopo la verifica.
