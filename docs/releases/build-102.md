# Build 102 — ErnieTRIX: campo e gravità

24 ottobre 2026. **Disponibile su TestFlight**, verificata alle 04:20 CEST.
`VALID`, `IN_BETA_TESTING`, gruppo «Interni» e note italiane verificati.

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

- Commit sorgenti: `7d642f02c54b49c3bdd0ff97d94f6e9ab7c9da8c`, pubblicato e
  verificato su GitHub `main` prima di compilare.
- Mac Studio: checkout pulito aggiornato in fast-forward; snapshot `git archive`
  del commit e SHA-256 verificati per tutti i 264 file iOS.
- Archive Release iPhone ed export completati. Firme Apple Distribution,
  profili ed entitlement verificati per app e tre estensioni, tutte build 102.
- Verificati il nuovo renderer `TRIXSceneHost`, lo sprite `ErnieTRIXFur`,
  changelog 102 e assenza degli hook Debug nel binario Release.
- Verificati anche i pixel dei 536 fotogrammi logici degli avatar condivisi.
- SHA-256 IPA esportata:
  `d49602c5e60ea2ae6582941823200ee1cbca736fd85e67bb5e2341fabb5f2c94`.
- Evidenze private sul Mac Studio:
  `/Users/alessandro/Library/Caches/ernie-builds/build-102-20261024-ernietrix-pause`.
- Upload completato con codice 0. App Store Connect build ID:
  `7e859320-a87f-41b8-8ff1-9705d9cef536`.
- TestFlight: `VALID`, `IN_BETA_TESTING`; gruppo «Interni» con accesso
  alla build, note italiane conformi al changelog (verifica 04:20 CEST).

Il commit finale della documentazione non modifica i sorgenti della build.
