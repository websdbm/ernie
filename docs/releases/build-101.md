# Build 101 — ErnieTRIX

24 ottobre 2026. **Disponibile su TestFlight**, verificata alle 04:00 CEST.
`VALID`, `IN_BETA_TESTING`, accesso al gruppo «Interni» e note italiane verificati.

## Contenuto

- Gioco locale 10 × 20 con sette forme pelose in pixel art, rotazioni,
  righe, punteggio, livelli, prossimo pezzo e sagoma di atterraggio.
- Apertura da testo o voce («Voglio giocare a ErnieTRIX») e dal pannello.
- Quattro comandi touch, pressione prolungata e caduta rapida.
- Partita e record locali per account, pausa automatica e ripresa esplicita.
- Accenti coerenti con l'orso, tema scuro e Riduci movimento.
- Nessun deployment backend, costo LLM o modifica ai server gestiti da Ernie.

Specifiche: [ErnieTRIX](../ui/ernietrix.md).

## Verifiche e tracciabilità

- Debug: 35 test in 6 suite passati, incluse regole, persistenza, grafica,
  comandi touch e regressioni voce/liste/widget.
- Layout a 320 e 390 punti; palette classica/Borg. Verificato anche il rendering
  SpriteKit reale su simulatore iPhone 17 e il colore/alpha dello sprite.
- Controllo aggiuntivo: aprire il gioco durante un turno non reinvia né annulla
  la richiesta già in corso.

- Sorgenti: `05a360d1f3e4b6b194ff2807194ec39e35def695`, pubblicati e
  verificati su GitHub `main` prima della compilazione.
- Mac Studio (`mac-studio-di-alessandro`, Tailscale `100.103.139.85`): accesso
  SSH come `alessandro`, checkout pulito aggiornato in fast-forward, snapshot
  `git archive` del commit pubblicato e 264 file iOS verificati con SHA-256.
- Archive Release iPhone riuscito; export Apple Distribution verificato per
  app e tre estensioni: numero 101, firme, profili ed entitlement corretti.
- Sprite ErnieTRIX presente in Assets.car, changelog 101 presente e hook di
  anteprima `ERNIE_DEBUG_TRIX` assente dal binario Release.
- Verificati anche 536 fotogrammi logici e pixel degli avatar condivisi.
- IPA esportata e verificata: SHA-256
  `d6eb88f28591006e89a9e6a6ce0bee78613e92d4b5eca5b7d5f27bba78751a77`.
- Upload concluso con codice 0. App Store Connect build ID:
  `c6f9e73d-ad37-4295-999d-50afd06f49df`.
- Evidenze private sul Mac Studio:
  `/Users/alessandro/Library/Caches/ernie-builds/build-101-20261024-ernietrix`.
- Nessuna prova su iPhone fisico; layout e comandi verificati in simulatore.

Il commit finale di documentazione non modifica i sorgenti della build.

## Regressione rilevata dopo la distribuzione

La prova grafica iniziale usava una sessione già attiva e non copriva il
passaggio reale da pausa a «Gioca». La build 101 può quindi mostrare un campo
grigio senza gravità: lo stato del gioco cambia ma `SpriteView` resta sospeso.
La build 102 corregge il ciclo di vita e aggiunge la regressione nativa per
avvio, rendering, gravità, pausa/ripresa e riapertura del salvataggio.
