# Build 102 — ErnieTRIX: campo e gravità

24 ottobre 2026. Rilascio in preparazione; distribuzione non ancora confermata.

## Correzione

Dopo «Gioca» lo stato della partita diventava attivo ma `SpriteView` conservava
la pausa iniziale. Il motore non riceveva frame: campo grigio e nessuna caduta,
mentre i pulsanti continuavano ad aggiornare il punteggio.

Un `SKView` con ciclo di vita esplicito ora presenta la scena, disegna un frame
anche nella schermata iniziale in pausa e riattiva davvero il rendering alla
ripresa. In pausa il ciclo si ferma; il clock viene azzerato e alla riapertura
si conserva il checkpoint. Nessuna modifica alle regole o ai salvataggi.
La preview Debug usa lo stesso avvio in pausa del gioco reale.

## Verifiche

- Riprodotto il difetto con un test nativo: stato playing, SKView e scena ancora
  in pausa, quota del pezzo invariata dopo due secondi.
- Verifica corretta di avvio, gravità senza input, pausa/ripresa, riapertura del
  salvataggio e pixel del campo visualizzato; test di regole, UI e integrazione.
- Rendering ispezionato sul simulatore iPhone 17, palette Borg/classica e
  controlli a 320 e 390 punti. Nessuna verifica sul telefono fisico dell'utente.
- Totale: 36 test verificati in 6 suite; suite UI finale 3/3 dopo aver
  corretto il campionamento pixel per evitare le linee colorate della griglia.
- Changelog e tutti e quattro i target aggiornati a 102.
- Nessun deployment backend richiesto.

## Tracciabilità

Il commit dei sorgenti, la verifica GitHub, l'archivio Mac Studio, le firme e
lo stato effettivo di TestFlight vengono registrati dopo i rispettivi controlli.
