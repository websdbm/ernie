# Build 101 — ErnieTRIX

24 ottobre 2026. Preparazione del rilascio; non ancora distribuita.

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

Il commit dei sorgenti verrà pubblicato su GitHub prima della compilazione
di distribuzione. Risultati definitivi e stato TestFlight da registrare dopo
compilazione, verifica e caricamento; nessuna prova su iPhone fisico ancora.
