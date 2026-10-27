# Build 107 — Suoni di Ernie

27 ottobre 2026. **Disponibile su TestFlight**, gruppo **Interni**.
Apple: **VALID**, **IN_BETA_TESTING**. Build ID `df71393a-c400-47c3-bb9d-4dc31614800f`.
Note italiane scritte dal changelog e rilette: **718 caratteri**.
Nessuna modifica o pubblicazione backend; nessuna installazione diretta su iPhone fisico.

## Comportamento

Sette effetti originali brevi: zampa all’invio scritto, brum al completamento, richiamo per le conferme,
doppia zampata all’approvazione, annullamento leggero, premio per le spunte e brontolio d’errore.
Suono di successo delle liste soltanto dopo la conferma REST; errore distinto se la scrittura fallisce.
Nessun suono a ogni token o tool, né loop di attesa. Solo turno attivo per completamenti/conferme;
identificativi stabili e cooldown evitano ripetizioni al replay e raffiche di effetti.

Impostazioni → Suoni di Ernie: interruttore, volume separato dalla voce e ascolto dei sette esempi.
Audio locale PCM sintetizzato in modo deterministico con lo script versionato: nessuna API o costo.
Categoria ambient, rispetto del silenzioso e miscelazione senza ducking. Stop in background, all’avvio
microfono e TTS (anche dettatura diario); nessuna riproduzione differita quando torna il primo piano.
Notifiche e sveglie conservano il comportamento precedente.

## Verifiche

Sul simulatore iPhone 17 Pro (iOS 26.5): **88 test** in 11 suite, tutti verdi.
Cinque test dedicati: integrità dei sette audio nel bundle, stop/soppressione con voce e background,
deduplica replay e cooldown, fine turno corrente, successo Todo soltanto dopo salvataggio e errore distinto.
Regressioni: Voice, Speech, DramaSpeech, SpeechPlaybackSession, ConversationSpeechLifecycle, Lifecycle,
PerformanceObservation, Todo, ShoppingCard, Confirmation. Escluso il test che registra dal microfono reale,
fermato sulla richiesta di permesso del simulatore; le altre tre prove di sessione AVAudioSession sono passate.
Rigenerazione Python: sette WAV identici byte per byte, picco 0.72, durate 0.16–0.36 s.
La resa sonora su altoparlante/cuffie e silenzioso richiede ancora una prova sul dispositivo fisico.

## Sorgenti e pacchetto distribuito

- Sorgenti **`bcbdae660a9820591d94453449efbbf8954d1b19`**, pubblicati e verificati su GitHub prima della
  compilazione da export Git pulito. **284 input iOS** con SHA-256; confrontati anche con i successivi commit
  di main: tutti identici. I commit successivi aggiungono soltanto procedura di firma e documentazione.
- `ARCHIVE SUCCEEDED` in Release per iPhone con `CODE_SIGNING_ALLOWED=NO`; app e tre estensioni alla 107.
  Questo archivio intermedio non è installabile. Manifest dell’archivio: 59 file.
- Preparazione per l’export con lo script già pubblicato in **`108ad26bef9688c90f111ff8b541ac5bdf2826a2`**.
  Profili locali validi della 106, appartenenti allo stesso team e compatibili con i bundle: mai aggiunti a Git.
- IPA finale con **firma Apple Distribution** verificata su tutte e quattro le componenti mediante
  `codesign --verify --deep --strict`. Verificati tutti gli entitlement rispetto ai sorgenti: push production,
  App Group per app/widget/condivisione, Keychain condiviso e **diario privato soltanto nell’app principale**.
  Sette WAV inclusi e identici ai sorgenti. Manifest IPA: 58 file.
- SHA-256 dell’IPA caricata:
  `686dd4036db197e9de0add7e7bff50c3c4a7aa56d5ec9cfd2f4447cc9cf90898`.
- Upload della **stessa IPA verificata** con `altool --upload-app`: `UPLOAD SUCCEEDED with no errors`, codice 0,
  80.927.722 byte. Delivery UUID uguale al Build ID sopra. Autenticazione API Apple già configurata;
  copia temporanea fuori dal repository, accesso ristretto, rimossa al termine.

## Procedura senza sbloccare il Mac Studio

La chiave Development del Mac dell’ufficio, utilizzabile per la 106, ora rifiuta l’operazione con
`errSecInternalComponent` / `CSSMERR_CSP_OPERATION_AUTH_DENIED`, pur con login sbloccato. Nessuna protezione
è stata modificata e nessuna chiave privata di firma è stata trasferita.

È stata ripresa la **firma gestita da Apple durante l’export API**, già usata nella 106. Per conservare
le capacità dell’app, `apps/ios/scripts/prepare-cloud-signing.py` richiede `--profiles-from <archivio precedente>`:
verifica team, scadenza e bundle prima di riutilizzare i profili; risolve AppIdentifierPrefix per componente.
Le notifiche hanno un prefisso legacy `QH3PSRG2YB` nel profilo Development: non bisogna sostituirlo alla cieca
con il Team ID. L’export Apple lo normalizza a `76X78MBPR3`, come nella 106.

1. Recuperare il commit pubblicato e verificare manifest e numero libero su App Store Connect.
2. Compilare Release senza firma e preparare **una copia** dell’archivio con lo script, indicando sorgenti
   pubblicati e archivio precedente con profili ancora validi. Confrontare gli entitlement intermedi.
3. Esportare con `xcodebuild -exportArchive`, autenticazione API già configurata, firma automatica e una copia
   di ExportOptions con `destination=export`. PATH di sistema, come nella procedura della 106.
4. Verificare l’IPA (firma, versioni, permessi, isolamento del diario, risorse), poi caricare **quella stessa IPA**
   con `altool`. Non caricare mai l’archivio intermedio con firma provvisoria.
5. Scrivere/rileggere le note con `asc.mjs whats-new`, verificare `VALID`, `IN_BETA_TESTING` e gruppo Interni.
   Interni ha `hasAccessToAllBuilds=true`: attendere l’associazione automatica. Il tentativo di aggiungerlo
   manualmente via API è stato rifiutato (422, nessuna modifica); poco dopo l’associazione era presente.

Le prove precedenti senza profili completi non sono state distribuite: una IPA ometteva gli entitlement,
un export successivo non avanzava ed è stato interrotto. Il percorso con i profili è invece verificato fino
alla disponibilità effettiva su TestFlight; non serve più attendere lo sblocco del Mac Studio per questa build.

Evidenze fuori da Git sul Mac dell’ufficio:
`~/Library/Caches/ernie-builds/build-107-20261027-sounds/` — manifest input/archivio/IPA, verifica permessi,
`export-profile-api.log`, `upload-verified-ipa.log`, `asc-status.json`, `asc-notes.json`.
Test: `/tmp/ernie-sounds-tests.log`, `/tmp/ernie-sounds-voice-tests.log`, `/tmp/ernie-sounds-xcode/Logs/Test/`.
