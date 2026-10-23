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

Inclusa nella build 97 in preparazione. Numero, changelog e progetto sono aggiornati;
la distribuzione sarà documentata in [build 97](../releases/build-97.md) dopo la
verifica del commit GitHub e di App Store Connect. Nessuna build 97 ancora dichiarata disponibile.
