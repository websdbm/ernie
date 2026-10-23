# Build 100 — Timeline Todo in chat

23 ottobre 2026. **Disponibile su TestFlight**, verificata alle 11:53 CEST.
`VALID`, `IN_BETA_TESTING`, accesso al gruppo «Interni» e note italiane verificati.

## Modifiche e verifiche

- Scheda chat oraria con timeline, tutte le sessioni e sezione Orario da definire.
- Colori coerenti con l’orso e supporto tema scuro/testo ingrandito.
- Nessuna attivazione di avvisi, modifica backend o modifica dei dati personali.
- Debug: 23 test Todo in 4 suite passati; regressione riprodotta prima del fix.
- Release: 3 test della scheda passati, testability attiva solo per i test.
- Rendering nativo 320/390 punti, chiaro/scuro, classico/Borg e accessibilità.
  Nessun ciclo AttributeGraph nei log finali; nessuna prova su iPhone fisico.

Dettagli: [timeline chat](../ui/todo-chat-timeline.md).

## Tracciabilità

- App Store Connect build ID: `591d6295-d5b6-4407-92dc-0f28f7648dea`.

- Sorgenti: `6c6ca732017e8b41e1549427d491da5f75680bf3`, pubblicato e verificato
  su GitHub `main` prima della compilazione.
- Mac Studio: checkout pulito aggiornato, snapshot `git archive` con 257 input
  iOS verificati mediante SHA-256.
- Archive Release iPhone riuscito; export Apple Distribution verificato per app
  e tre estensioni: numero 100, firme, profili ed entitlement di distribuzione.
- Verificati anche 536 fotogrammi logici e pixel delle risorse degli avatar.
- IPA locale verificata: SHA-256
  `6b677eae8dbc1160f71585e977ad062dab79b6edf6bd6c8aa22286ad72cbf7cb`.
- Evidenze sul Mac Studio:
  `/Users/alessandro/Library/Caches/ernie-builds/build-100-20261023-todo-timeline`.

Il commit di documentazione finale non cambia i sorgenti della build.
