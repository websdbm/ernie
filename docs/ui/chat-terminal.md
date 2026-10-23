# Skin Terminale della chat

Implementazione del 23 ottobre 2026. Attivabile da **Impostazioni → Aspetto della chat → Skin Terminale**. Disattivata inizialmente; la scelta si conserva sul dispositivo in `ernie.chat.terminal` e non richiede chiamate al server.

La chat usa fondo quasi nero, testo verde fosforo, font monospaziato, bordi verdi per barra di inserimento, capsula, pulsanti, schede e attività. Orso, foto e colori semantici di errore restano riconoscibili. La skin ha un proprio fondo scuro anche quando iOS usa il tema chiaro. Le altre sezioni e i widget mantengono il loro aspetto.

Il cursore a blocco viene disegnato da un `UITextView` attraverso `caretRect(for:)`: coincide con il punto di inserimento, senza animazioni o timer sovrapposti. La barra supporta selezione, emoji, composizione del testo, dettatura di sistema e più righe; fino a sei righe (massimo 180 punti), poi scorre internamente. Dynamic Type viene passato da SwiftUI al carattere UIKit. Il testo della bozza resta nella stessa proprietà della chat, anche cambiando skin. Microfono, invio e allegati mantengono le azioni già presenti.

`ChatPalette` è un valore d'ambiente confinato al contenuto della chat. I componenti condivisi hanno un valore predefinito classico; non consultano preferenze globali durante il rendering. Anche l'estensione di condivisione compila le definizioni necessarie senza attivare la skin.

## Verifica

- Compilazione nativa iOS Simulator, app e tre estensioni.
- `TerminalChatTests`: inserimento di emoji e a capo, sostituzione della selezione, posizione e dimensioni del cursore, testo lungo con scorrimento, cambio skin conservando la bozza, svuotamento del campo.
- Rendering nativo dei componenti di chat con dati sintetici: skin terminale su sistema chiaro/scuro, aspetto classico chiaro/scuro, Dynamic Type accessibile.
- Regressione: suite `ConfirmationTests` e `ReadabilityTests`; 14 test passati nelle tre suite.

[Anteprima della skin](terminal-chat.png).

Le schermate di anteprima mostrano componenti reali con una conversazione sintetica. Non costituiscono una prova su iPhone fisico, né una prova di richieste LLM; il backend non cambia.

## Distribuzione

Disponibile nella **build 98 su TestFlight**, verificata il 23 ottobre 2026 alle
08:04 CEST: `VALID`, `IN_BETA_TESTING`, gruppo «Interni» e note italiane aggiornate.
Sorgenti compilati: `c783c37e18d66d14032d1d973429a9f08a198ee7`, pubblicati su GitHub
prima dell'archive sul Mac Studio. La build 98 corregge la gestione del focus
introdotta nella 97. La verifica su iPhone fisico resta da eseguire.

Dettagli e verifiche del rilascio: [build 98](../releases/build-98.md).

## Correzione della scrittura (build 98)

La prima integrazione usava un `FocusState` senza un corrispondente campo SwiftUI
nella skin Terminale. Il test del solo editor non intercettava il problema della
barra completa: la digitazione progressiva perdeva il focus e generava cicli
AttributeGraph. La gestione del focus ora è distinta tra editor UIKit e campo
classico, con una bozza condivisa. Verifiche e distribuzione nella
[build 98](../releases/build-98.md).
