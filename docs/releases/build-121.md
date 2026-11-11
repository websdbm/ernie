# Build 121 — Conversazione e voce

11 novembre 2026. Sorgenti e dipendenze backend preparati. Pubblicazione API e distribuzione iOS in attesa.
106 test backend, TypeScript e Biome verificati. 37 test iOS passati; un test del microfono richiede hardware
audio non disponibile sul Mac usato per il simulatore, come descritto sotto.

## Archivio pronto

- Sorgenti iOS pubblicati e verificati su GitHub `ab51bba39238a17e6a868e5251d4818bbbd3c906`.
- Archivio Release da checkout pulito con Xcode 27.2; export Apple sul Mac Studio con Xcode 27.0.
- 318 input iOS verificati per SHA-256, quattro bundle 121 firmati Apple Distribution con entitlement e
  profili coerenti; gruppo privato Diario presente soltanto nell’app principale, APNs production.
- IPA 82.882.525 byte, SHA-256 `3fc324cd8051935bb515d5ca63be3a181f626dd932849f3f62479b7ee1a8d501`.
- Artefatti privati sul Mac Studio `~/Library/Caches/ernie-builds/build-121-20261111-voice/`,
  `release-manifest.json` e `export/Ernie.ipa`. Copia locale dell’archivio in `/tmp/ernie-build121.eZZD9m/`.
- Backend da pubblicare `791c2dc`, che aggiunge la protezione sulle conferme senza riferimento e la nota
  dei turni locali. Gli input iOS sono identici al commit dell’archivio. Nessuna migrazione SQL nuova.
- Export completato e verificato; upload TestFlight non avviato. Pubblicazione in attesa del via libera.

## Conversazione

La domanda conclusiva della risposta del modello viene conservata nella continuazione per account e sessione,
con scadenza di dieci minuti e consumo atomico. Un sì/no, un’opzione o un orario pertinente la riprendono
prima di un nuovo chiarimento di funzione. Una nuova richiesta esplicita resta autonoma. La nota riporta il
contesto della domanda e chiede di controllare gli impegni esistenti per evitare duplicazioni. Domande citate
all’interno di una risposta conclusa non vengono riaperte.
Una conferma senza una domanda valida chiede il riferimento all’utente. La nota interna dei turni locali
conserva la distinzione tra domande ancora aperte e azioni esplicitamente concluse.

Regressione sintetica di un impegno già corretto seguito dalla proposta su un altro, domanda oltre i primi
200 caratteri, risposta breve e riconnessione. Con il modello reale Sonnet 5.5 e strumenti soltanto simulati:
un nuovo avviso per il punto aperto, zero modifiche o duplicati dell’impegno già concluso (circa 0,011 USD).

## Voce e input

I tre stili vocali usano la stessa direzione naturale e un riferimento sintetico fisso, creato con Drama 3.
Il riferimento non è la registrazione di una persona. Quando TTS_VOICE_ID è configurato, si usa quella voce.
Asset `apps/api/static/ernie-voice.mp3`, SHA-256
`9c1a424d0dfefd3a44c4194c9af088bf1e2cbd25900739fa687aff1b00b15242`.
Trascritto e richiesta di riferimento in `speech.ts`. Nessun segreto o testo dell’utente nell’asset.
Una prova live ha verificato la generazione con riferimento tramite OpenRouter. Anteprima locale in
`/tmp/ernie-voice-coherent-preview.mp3`.
Contratto dei riferimenti e della sintesi nelle [API OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/tts).

Audio accelerato con atempo 1,25, mantenendo l’altezza. Compressione e livellamento delle variazioni interne,
normalizzazione per frase a circa -14 dB RMS e limitazione dei picchi. Il ripiego iOS è accelerato del 15%.
I test FFmpeg verificano durata, altezza, picchi e differenza inferiore a 1 dB fra segnali deboli e forti.

Modello STT e formato predisposti in anticipo con SpeechAnalyzer.prepareToAnalyze. Stato degli asset in cache
per cinque minuti, sessione di ingresso measurement e Voice I/O disabilitato durante l’ascolto alternato alla
sintesi. Attivazione asincrona su iOS 27 e attivazione fuori dal thread UI su iOS 26. I chiamanti Diario e
Archivio chat usano anch’essi la nuova attivazione. Log di avvio con tempi del modello e dell’ascolto, senza testo.

La prova del microfono reale sul simulatore non è riuscita: Core Audio del Mac non offre un ingresso
predefinito, e il nodo restituisce 0 Hz. I tempi di avvio e il comportamento con Bluetooth richiedono un iPhone
reale. Non dichiarare verificata una soglia di latenza. Le altre prove della sessione audio e della coda vocale
sono passate.

## Dipendenze

Include l’apprendimento degli orari dichiarati della revisione `3788508`, ancora da pubblicare sul backend.
Nessuna migrazione SQL nuova. Il writer Abitudini deve conservare il nuovo campo cifrato `declared`.
Prima di distribuire aggiornare il backend e rileggerne lo stato. Per il rilascio seguire AGENTS.md.
