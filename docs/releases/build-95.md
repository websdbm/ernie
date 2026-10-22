# Build 95 — Halloween, Borg e Jedi

Tre nuovi costumi selezionabili tenendo premuta la capsula e aprendo «Aspetto
di Ernie». La scelta manuale resta attiva durante ricette, ricerche e altre
attività. Nessun cambiamento alle regole del costume automatico o alla rotazione
dei widget Home/lock screen.

Ogni costume espone 40 fotogrammi: 20 espressioni e cinque sequenze da quattro
fotogrammi (pensiero, parlato, starnuto, sonno e cinque). I PNG generati sono
conservati senza ritocchi; coordinate e mappa dei fotogrammi sono nei metadati
condivisi. La riga extra di sonno non è esposta. Le mappe di Borg e Jedi escludono
pose incoerenti del gesto o del parlato. Proposte, prompt e selezioni sono in
`docs/assets/ernie-v3/costume-concepts/` e `costume-atlases/`.

## Verifica e distribuzione

Test nativi: 19 test superati in BearAnimationTests, BearPawTapTests e
WidgetLinkTests su simulatore iPhone 17 Pro, iOS 26.5. Verificati tutti i
fotogrammi, la selezione dei costumi, i bordi del ritratto a sette dimensioni,
le animazioni e i collegamenti del widget. Ispezionate le anteprime native dei
tre costumi in tema chiaro e scuro; uniformata l'inquadratura del cinque di
Halloween e Jedi. Nessun cambiamento al backend. Verifica su iPhone fisico
non eseguita.

Distribuzione in preparazione: registrare commit pubblicato, verifica dei pixel
del pacchetto firmato, hash IPA e stato effettivo TestFlight al completamento.

Rollback client: build 94.
