# Build 118 — ricerca e modifiche affidabili

10 novembre 2026. **In preparazione; non pubblicata**. Build attualmente distribuita: 117.

Ambito: ricerca web con passaggi pertinenti/cache/letture batch, strumenti di contesto e patch Todo,
rimozioni inventario SSH con precondizione concorrente, date/riferimenti dei referti più precisi,
conteggio giornaliero automazioni nel loro fuso. Dettagli e limiti in
[ricerca 25](../research/25-open-features-wave1.md).

Sorgenti, SHA remoto e manifest finale saranno registrati prima della distribuzione.
**191 test backend in 21 suite superati**, inclusi test PostgreSQL su database temporaneo con RLS,
revisioni/idempotenza, revoche e operazioni concorrenti; TypeScript e Biome verdi.
Review indipendente completata: corretti stop durante verifica permessi, requisito modello avanzato
per la risoluzione di siti SSH e budget delle anteprime. Nove prove aggiuntive su testi lunghi/escaped:
massimo output osservato 6.524 caratteri su 8.000, prova e copertura integre.
**42 test iOS in sette suite superati** sul Mac Studio (Xcode 27.0), con snapshot dei 306 input iOS.
Verificate schede Salute in chiaro, scuro e caratteri accessibili; righe verticali e testo completo
anche per nomi/unità/riferimenti lunghi a 320 pt. OCR locale dei render con fixture sintetiche verifica
che date, unità e confronti siano realmente leggibili. Schede/conferme SSH già verificate nelle tre palette.
Nessuna chiamata a provider SSH/host reali, nessun dato medico reale utilizzato nei test.

Evidenze temporanee locali: `/tmp/ernie-open-features-verification-final.log` (187 test),
`/tmp/ernie-open-features-attack-final.log` (4 test), log `typecheck-final`/`biome-final` con lo stesso prefisso.
Nessuna nuova misurazione di latenza LLM o prova su iPhone fisico.
Test nativi e cinque render: `/tmp/ernie-open-features-118-20261110-r2/`; sul Mac Studio
`~/Library/Caches/ernie-checks/open-features-118-20261110-r2/Build118.xcresult`.
Manifest test SHA-256 `28904afaea9cf2495870eb3739e58d016bde35c8c67fb555455999524089a3eb`.

## Ordine e compatibilità

1. Backup verificato del progetto e del database; migrazione **0051** prima della nuova API.
2. Pubblicazione API e worker dal commit GitHub: la correzione del budget automazioni è usata dal worker.
3. Smoke con account sintetico, senza modificare account reali o collegarsi agli host gestiti.
4. Solo dopo API verificata: distribuzione iOS 118. Il backend precedente ignorerebbe la nuova
   precondizione DELETE, quindi non garantirebbe il controllo tra dispositivi della conferma.

Migrazione additive/nullable: vecchie date intatte. Prima di un eventuale rollback dell'API, verificare
se sono stati importati referti con data NULL: il vecchio codice non li gestisce. Non inventare date
per permettere un rollback; conservare i dati e correggere avanti o predisporre un recupero mirato.
Non eseguire `SET NOT NULL` con referti non datati. Nessuna migrazione applicata alla produzione in questa fase.

## Lavori non inclusi

Abitudini, HealthKit, cifratura integrale e consenso AI della nuova sezione Salute, analisi generale delle immagini,
importazione delle nove foto non reperite, collegamento Contabo/chiave YouTube e misure di latenza sul traffico reale.
Roadmap corrente in [IMPLEMENTATION_PLAN.md](../../IMPLEMENTATION_PLAN.md).
