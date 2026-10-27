# Build 108 — Lettura dei contenuti

27 ottobre 2026. **In preparazione**, non ancora distribuita. Ultima disponibile: 107.

## Comportamento

Impostazioni → Diagnostica → Lettura dei contenuti: stato dei metadati YouTube, sottotitoli,
analisi visiva e Instagram, limitato all’account autenticato. Configurazione distinta da una lettura riuscita;
ultimo esito, data e durata, con messaggi italiani per credito, budget, limiti temporanei e accessi bloccati.
Aggiornare il pannello legge solo Redis: nessuna sonda remota o chiamata AI. Gli esiti scadono dopo 24 ore,
non contengono URL, testi, cookie o errori grezzi. Le risposte di un vecchio account non riappaiono dopo il cambio.

Riassunti YouTube espliciti: prova una sola traccia pubblica di sottotitoli (italiano preferito), JSON3,
5 secondi, 500 kB e 32.000 caratteri massimi. Timestamp e controllo conservativo dell’estensione temporale;
nessun download audio, nuovo provider, cookie o aggiramento dei blocchi. Per blocchi/errori/limiti dei sottotitoli,
pausa di cinque minuti per account, poi lettura visiva esistente. I riassunti culinari e le richieste sulle immagini
usano sempre il video. Richieste negate o miste (riassunto e ricetta) conservano la ricetta completa.
Cache separata per account e per riassunto testuale, riassunto visivo, lettura completa.

L’output YouTube include provenienza comune: URL canonico, titolo/autore, metodo, lingua, data,
copertura e limiti. I sottotitoli non vengono presentati come immagini viste o audio ascoltato.
Il prompt di salvataggio richiede di mantenere metodo e limiti nel Brain; non è una migrazione delle note esistenti.
Budget, registrazione consumi, limite di 20 minuti e analisi visiva delle ricette restano applicati.
Gli errori HTTP del servizio AI sono distinti da quelli del contenuto.

Instagram resta **non collegato**, coerentemente con la scelta precedente. Nessuna installazione di Agent-Reach.

## Verifiche prima del rilascio

- TypeScript API e pacchetti dipendenti: compilazione riuscita.
- 47 test backend verdi: YouTube (31), sottotitoli (5), diagnostica (3), server (8).
  Contratto, accesso chat, isolamento account, input ostili, limiti, cache, fallback, credito e classificazione HTTP.
- Prova pubblica senza AI su tre link: due pagine pubbliche con durata ma sottotitoli non leggibili;
  terza pagina senza durata. **Il percorso sottotitoli non è verificato end-to-end con un video reale**;
  parser e analisi testuale sono coperti da fixture. Non è dimostrato un risparmio effettivo su quei link.
- Simulatore iPhone 17 Pro, iOS 26.5: **23 test verdi in tre suite** (ContentReaders, Confirmation, PerformanceObservation).
  Coperti contratto HTTP, server precedente, refresh concorrenti, cambio account e uscita durante una richiesta.
- Deploy e distribuzione: in corso; stato da aggiornare al termine.

## Riproducibilità

Build 108 su app e tre estensioni; sorgenti, risorse e progetto Xcode da pubblicare su GitHub prima della
compilazione Release pulita. Export e verifica dei permessi seguono il percorso Apple API della build 107.
Il backend richiede un deploy separato da Git; nessuna migrazione DB e nessuna nuova credenziale.
Evidenze temporanee: `/tmp/ernie-readers-*`; archivio previsto in
`~/Library/Caches/ernie-builds/build-108-20261027-content-readers/`.
