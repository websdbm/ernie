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

## Sorgenti e pacchetto

- Commit dei sorgenti: `aca1bc6a4489ecd26207f9f26baf6f58e6d769e7`, pubblicato
  e verificato su GitHub prima della compilazione e distribuzione.
- Compilazione sul Mac Studio da `git archive` del commit, manifest SHA-256 dei
  252 file iOS, senza includere modifiche locali del backend.
- Archive Release ed esportazione App Store Connect riusciti. Firma Apple
  Distribution e profili verificati per app, widget, share extension e notification
  extension; tutti con numero build 95 e gli entitlement previsti.
- Verificati 536 fotogrammi logici: 520 ritratti e 16 gesti della zampa. I pixel
  decodificati di ogni atlas dell'IPA coincidono con quelli dei sorgenti; verificati
  anche risorse condivise e fallback dei widget.
- SHA-256 IPA esportata:
  `770a70af82d48b9b3c0dcacc41d82ea6e92fc0be6585f77cbaaf11cc20059025`.
- Upload completato il 22 ottobre 2026 alle 11:28 CEST. Alle 11:33 CEST
  App Store Connect conferma `VALID`, `IN_BETA_TESTING`, inclusione nel gruppo
  «Interni» e note italiane corrispondenti al changelog. Build ID:
  `80932741-6a74-4904-8183-03714284fa29`.

Evidenze locali: `/tmp/ernie-costumes-95/Verified.xcresult`, anteprime in
`/tmp/ernie-costumes-95/previews-final/`. Archivio, IPA e report sul Mac Studio
in `~/Library/Caches/ernie-builds/build-95-20261022-costumes/`.

Rollback client: build 94.
