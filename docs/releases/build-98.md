# Build 98 — Scrittura stabile nella skin Terminale

Correzione della gestione del focus nella barra della chat. Il campo UIKit della
skin Terminale usava un binding ricavato da `FocusState`, senza un campo SwiftUI
collegato nella gerarchia attiva. Durante l'aggiornamento della bozza, il focus
poteva essere azzerato e generare cicli di aggiornamento.

La chat conserva ora lo stato di composizione in un normale `Binding`. Solo il
campo classico usa un `FocusState` locale, sincronizzato quando quella skin è
attiva. Le richieste UIKit di apertura/chiusura della tastiera vengono eseguite
fuori dall’aggiornamento SwiftUI, con cancellazione delle richieste superate e
rimozione del delegate quando si smonta il campo. Font e margini sono aggiornati
solo quando cambiano. Il cursore verde a blocco rimane.

## Verifiche

- Regressione prima della correzione: digitazione progressiva nella `InputBar`
  completa, con tastiera attiva; perdita del first responder e cicli AttributeGraph.
- Dopo la correzione: 16 test Debug superati, senza cicli AttributeGraph.
  Inclusi digitazione progressiva, emoji, selezione, cancellazione, composizione
  IME, testo multilinea, focus programmatico, cambio skin e rendering
  chiaro/scuro/accessibile.
- Quattro test della suite TerminalChatTests superati anche in Release ottimizzata,
  senza cicli AttributeGraph. `ENABLE_TESTABILITY=YES` è usato solo per eseguire
  i test `@testable`, non per l'archivio distribuito.
- Il controllo del focus attende il first responder entro un limite, anziché
  assumere che l'animazione della tastiera finisca esattamente entro 250 ms.
  Questo aggiustamento del solo test è successivo al commit dell'archivio;
  non modifica alcun sorgente compilato nell'app o nelle estensioni.
- Non ancora verificato su iPhone fisico. Apple non ha ancora esposto un rapporto
  del crash della build 97; l'evidenza riprodotta è il ciclo di focus nel simulatore.

## Distribuzione

Sorgenti dell'archivio: `c783c37e18d66d14032d1d973429a9f08a198ee7`, pubblicati
su GitHub prima della compilazione. Mac Studio ha verificato con SHA-256 i 257
file iOS dello snapshot pulito. Archive, export e upload riusciti.
Firma Apple Distribution, profili e entitlement verificati per app e tre estensioni;
536 fotogrammi e risorse condivise corrispondono ai pixel dei sorgenti.
SHA-256 IPA: `3889fcb8e1d2784fa57b1464f40613439157d1e522315c4679cf1708de190eef`.
TestFlight verificato il 23 ottobre 2026 alle 08:04 CEST: `VALID`,
`IN_BETA_TESTING`, gruppo «Interni» e note italiane corrispondenti al changelog.
Build ID: `99be5f3c-ca84-4c9c-8ff1-f9a640eef1b5`.
Nessun aggiornamento backend necessario.

Archivio sul Mac Studio:
`~/Library/Caches/ernie-builds/build-98-20261023-terminal-fix/`.
La build 97 contiene il difetto corretto qui: non usarla come rollback della skin;
lo stile classico resta disponibile dalle impostazioni.

Evidenze locali: `/tmp/ernie-terminal-crash-before-suite.log`,
`/tmp/ernie-terminal-crash-after.log`, `/tmp/ernie-terminal-crash-release-focus.log`.
Rilascio: `/tmp/ernie-terminal-crash-20261023/`.
