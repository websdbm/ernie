# Palette della chat associate all'orso

Dal 23 ottobre 2026, build 99, il costume e lo stile della chat sono una sola scelta:
**Impostazioni → Aspetto di Ernie → Orso e palette**, oppure pressione prolungata
sulla capsula → Aspetto di Ernie. Il vecchio interruttore Skin Terminale è rimosso;
la vecchia preferenza `ernie.chat.terminal` non influenza più l'interfaccia.
Si conserva la scelta del costume in `ernie.bearCostume`, locale al dispositivo.

| Orso | Palette |
| --- | --- |
| Ernie classico | Viola e lilla |
| Cappello da notte | Indaco e lavanda |
| Occhiali scuri | Grafite e menta |
| Occhiali da aviatore | Petrolio e rame |
| Cuoco | Crema e terracotta |
| Detective | Seppia e ambra |
| Tecnico | Ardesia e ciano |
| Esploratore | Bosco e salvia |
| Astronauta | Blu spazio e ghiaccio |
| Halloween | Prugna e arancio |
| Borg | Nero e verde fosforo, caratteri monospaziati, cursore a blocco |
| Jedi | Sabbia e verde |

Le palette seguono il tema chiaro/scuro del dispositivo. Borg mantiene un proprio
fondo scuro. Sfondo, fumetti, barra d'inserimento, capsula, avatar galleggiante e
pannello laterale condividono la palette. I colori semantici delle skill e degli
errori restano distinti. Le sezioni dedicate e i widget mantengono il loro tema.

In Automatico `ChatView` risolve il costume una volta per avatar e palette, usando
ora, attività e umore. L'ambiente passa la stessa scelta a `PixelBearView`, evitando
che volto e colori divergano. L'ora e la scadenza del costume legato all'attività
si aggiornano ogni 15 secondi mentre la scena è attiva. L'animazione dell'orso
mantiene il proprio ritmo, senza ridisegnare la chat a ogni fotogramma.

## Cursore e stabilità

La sola modifica a `caretRect(for:)` della build 98 produceva una geometria ampia,
ma su iOS il cursore visibile rimaneva sottile. `TerminalTextView` ora disegna un
rettangolo verde nella posizione indicata da UITextInput e usa Core Animation per
la pulsazione, senza timer SwiftUI. Il cursore nativo è trasparente soltanto con
selezione collassata; durante selezione e composizione IME torna la UI di sistema.
Il rettangolo scompare perdendo il focus, uscendo dalla finestra o passando in
background. Con Riduci movimento è fermo. Nessuna API privata.

Selezione, emoji, dettatura, più righe e scorrimento restano affidati a UITextView.
Dynamic Type arriva da SwiftUI; l'editor cresce fino a sei righe (massimo 180 punti).
La bozza resta condivisa passando tra Borg e gli altri costumi. Il focus UIKit è
separato dal FocusState del campo SwiftUI, preservando la correzione della build 98.

Riferimento API: [UITextInput.caretRect](https://developer.apple.com/documentation/uikit/uitextinput/caretrect(for:)).

## Verifica

`TerminalChatTests` verifica la barra completa con digitazione progressiva,
selezione, IME, emoji, righe, scroll, focus, cambio stile e bozza. Il test del
cursore verifica anche la vista dipinta e la pulsazione, non solo la geometria.

I dodici costumi sono renderizzati con componenti nativi in entrambi i temi; i
contrasti principali (testi, testi secondari, fumetti e accenti su superficie)
sono verificati con rapporto minimo 4,5:1. Le anteprime usano dati sintetici offline.

- [Palette chiare](bear-palettes-light.jpg)
- [Palette scure](bear-palettes-dark.jpg)
- [Cursore Borg durante la scrittura](borg-block-cursor.png)

Build 99 disponibile su TestFlight, verificata il 23 ottobre 2026 alle 08:42 CEST.
Per commit, prove e stato del rilascio: [build 99](../releases/build-99.md).
