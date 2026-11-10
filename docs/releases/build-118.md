# Build 118 — ricerca e modifiche affidabili

10 novembre 2026. **Compilata, firmata e verificata; non pubblicata**. Build attualmente distribuita: 117.

Ambito: ricerca web con passaggi pertinenti/cache/letture batch, strumenti di contesto e patch Todo,
rimozioni inventario SSH con precondizione concorrente, date/riferimenti dei referti più precisi,
conteggio giornaliero automazioni nel loro fuso. Dettagli e limiti in
[ricerca 25](../research/25-open-features-wave1.md).

Sorgenti **`a56ea5533247fc7dea8e0de8ea334b356de2bb88`**, pubblicati su GitHub e SHA remoto verificato
prima dell'archivio. Tutti i **306 input iOS** identici al commit e ai test nativi; snapshot Git pulito
sul Mac Studio, senza usare le modifiche estranee presenti nel workspace.
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

## Archivio verificato, in attesa di autorizzazione

Archivio Release ed export Apple riusciti sul Mac Studio. Quattro firme **Apple Distribution** verificate
con `codesign --verify --deep --strict`, build 118 ed entitlement conformi ai sorgenti. Il gruppo privato
del diario rimane soltanto nell'app principale. Changelog nell'IPA identico a Git; nessuna chiave privata
copiata e nessuna modifica al Portachiavi. Export locale con `destination=export`, nessun upload.

IPA **82.132.756 byte**, SHA-256
`451e6049e1086d34b508ae4003bf56782df6e5d8e52b21a21591b13e99ced423`.
Artefatti sul Mac Studio: `~/Library/Caches/ernie-builds/build-118-20261110-open-features/`:
`source/`, `source-sha.txt`, `ios-inputs.json`, `Ernie-unsigned.xcarchive`, `Ernie-profile.xcarchive`,
`export-profile-api/Ernie.ipa`, `verified-ipa/`, `release-manifest.json`, log archive/export.
Preparazione firma tramite script versionato `apps/ios/scripts/prepare-cloud-signing.py`, profili validi
del precedente archivio 117, poi export Apple e verifica delle quattro componenti.

API/worker ancora alla versione pubblicata; migrazione 0051 non eseguita. Serve il via libera esplicito
per pubblicazione e scritture sul database, come richiesto in HANDOFF, sezione Server.
Database sintetico locale dei test eliminato dopo le verifiche; nessun dato reale toccato.

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
