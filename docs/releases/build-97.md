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

- Sorgenti iOS: `0a0171215d607c85039defad7ba7eb33151bb8b8`, pubblicati e
  verificati su GitHub prima dell'archive. Snapshot pulito dei 257 input iOS,
  tutti controllati con SHA-256 sul Mac Studio.
- Tutti e quattro i target sono alla build 97.
- Archive ed export App Store Connect riusciti. Firme Apple Distribution,
  profili ed entitlement verificati per app, widget, share e notification extension.
- Verificati 536 fotogrammi logici e corrispondenza dei pixel con i sorgenti,
  incluse risorse condivise e fallback dei widget.
- SHA-256 IPA esportata:
  `c91e2756e5e095959d91bf804ffb39979afb30c28620ffdbfee6ea529f824864`.
- Upload completato il 23 ottobre 2026 alle 06:12 CEST. Alle 06:15 CEST
  App Store Connect conferma `VALID`, `IN_BETA_TESTING`, presenza nel gruppo
  «Interni» e note italiane corrispondenti al changelog, con la normale
  rimozione dei simboli non ammessi da TestFlight effettuata da `asc.mjs`.
- Build ID: `7ea32187-5934-43bc-937a-fe3889727f97`.
- Nessun tester o gruppo aggiunto o modificato. Nessun deployment backend
  richiesto per rendere disponibile la skin.

Evidenze native: `/tmp/ernie-terminal-verified.log`.
Archivio, IPA e report di verifica sul Mac Studio:
`~/Library/Caches/ernie-builds/build-97-20261023-terminal/`.
Rollback client: build 96.

Evidenze di rilascio locali: `/tmp/ernie-terminal-release-20261023/`.
