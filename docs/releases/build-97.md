# Build 97 — Skin Terminale

La chat dispone di uno stile alternativo attivabile da **Impostazioni → Aspetto
della chat → Skin Terminale**. Fondo scuro, verde fosforo, font monospaziato e
cursore a blocco; la preferenza è locale e conserva la bozza quando si cambia stile.
Le altre sezioni e i widget mantengono il proprio aspetto.

Dettagli: [skin Terminale](../ui/chat-terminal.md).

## Verifiche

- Quattordici test nativi superati nelle suite TerminalChatTests, ConfirmationTests
  e ReadabilityTests: inserimento, emoji, selezione, cursore, testo multilinea,
  scorrimento e cambio skin conservando la bozza.
- Rendering nativo ispezionato in tema chiaro/scuro, modalità classica e Terminale,
  con Dynamic Type accessibile; app e tre estensioni compilati per simulatore.
- Nessuna verifica su iPhone fisico. Nessun cambiamento backend richiesto dalla skin.

## Distribuzione

In preparazione. Tutti e quattro i target sono alla build 97. Il commit sorgenti,
manifest degli input, firma/IPA e stato effettivo TestFlight verranno registrati
qui dopo ciascuna verifica. Nessun upload prima della pubblicazione GitHub del
commit esatto usato per compilare.

Evidenze native: `/tmp/ernie-terminal-verified.log`.
Directory di rilascio prevista sul Mac Studio:
`~/Library/Caches/ernie-builds/build-97-20261023-terminal/`.
Rollback client: build 96.
