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
- In corso: verifica delle stesse suite in configurazione Release ottimizzata.
- Non ancora verificato su iPhone fisico. Apple non ha ancora esposto un rapporto
  del crash della build 97; l'evidenza riprodotta è il ciclo di focus nel simulatore.

## Distribuzione

Preparazione in corso. Commit dei sorgenti, archivio, firma e stato TestFlight
saranno registrati dopo la verifica. Nessun aggiornamento backend necessario.

Evidenze locali: `/tmp/ernie-terminal-crash-before-suite.log`,
`/tmp/ernie-terminal-crash-after.log`, `/tmp/ernie-terminal-crash-final-release.log`.
Rilascio: `/tmp/ernie-terminal-crash-20261023/`.
