# Build 113 — Clear senza testi né ripristino

1 novembre 2026. **In preparazione**; ultima TestFlight disponibile: 112.

`/clear` lascia l’area dei messaggi completamente vuota. Rimossi il titolo «Schermata pulita»,
la spiegazione e «Mostra la cronologia», insieme al metodo di ripristino. Aiuto del comando abbreviato.
La stessa pulizia resta anche alla riapertura e tornando a questa conversazione dal pannello laterale.
Il contesto di Ernie, la sessione e le richieste sono conservati come nella 112; nuovi messaggi visibili.
Nessun deploy backend, migrazione o eliminazione dei dati sul server.

**26 test verdi in cinque suite** sul Mac Studio: comandi e persistenza, regressioni Spesa/Todo/indice
transcript e prova nativa chiaro/Borg/caratteri grandi. Controllati tutti i pixel: solo sfondo uniforme.
Nessun account reale o nuova richiesta LLM nelle prove.
Tutti i quattro target alla 113; sorgenti e changelog da pubblicare prima dell’archivio di distribuzione.
