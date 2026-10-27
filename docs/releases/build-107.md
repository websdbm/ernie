# Build 107 — Suoni di Ernie

27 ottobre 2026. Modifica iOS; nessuna dipendenza o pubblicazione backend.
Stato: **implementata, testata e compilata Release per iPhone; distribuzione in sospeso**.
TestFlight resta alla **106**. Nessuna IPA della 107 è stata caricata.

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

## Verifiche e rilascio

Verifiche completate sul simulatore iPhone 17 Pro (iOS 26.5): **88 test** in 11 suite, tutti verdi.
Cinque test dedicati: integrità dei sette audio nel bundle, stop/soppressione con voce e background,
deduplica replay e cooldown, fine turno corrente, successo Todo soltanto dopo salvataggio e errore distinto.
Regressioni: Voice, Speech, DramaSpeech, SpeechPlaybackSession, ConversationSpeechLifecycle, Lifecycle,
PerformanceObservation, Todo, ShoppingCard, Confirmation. Escluso il test che registra dal microfono reale,
fermato sulla richiesta di permesso del simulatore; le altre tre prove di sessione AVAudioSession sono passate.
Rigenerazione Python: sette WAV identici byte per byte, picco 0.72, durate 0.16–0.36 s.
Evidenze locali: `/tmp/ernie-sounds-tests.log`, `/tmp/ernie-sounds-voice-tests.log`,
`/tmp/ernie-sounds-xcode/Logs/Test/`. `git diff --check` pulito.

Commit sorgenti pubblicato e verificato prima della compilazione:
**`bcbdae660a9820591d94453449efbbf8954d1b19`**. Export Git pulito, 284 input SHA-256.
`ARCHIVE SUCCEEDED` con firma disabilitata, tutte e quattro le componenti alla 107, sette WAV inclusi.
Manifest archivio (59 file) e input conservati fuori da Git. I 284 input sono identici anche al successivo
`10b58bc` pubblicato, che aggiunge soltanto lo script sperimentale e la nota di rilascio; nessun sorgente
compilato o risorsa cambiato. Checkout Mac Studio allineato. Backend invariato, nessun deployment.

Restano necessari firma ordinaria, verifica IPA, upload e rilettura stato Apple prima di distribuire.
La resa sonora su altoparlante/cuffie e silenzioso richiede una prova sul dispositivo fisico.

## Impedimento alla firma e prova alternativa (non distribuita)

Il primo archive firmato si ferma su `CodeSign ErnieNotifications.appex`, `errSecInternalComponent`.
Il Portachiavi login dell'ufficio risulta sbloccato, ma securityd rifiuta l'operazione della chiave
(`CSSMERR_CSP_OPERATION_AUTH_DENIED`); sul Mac Studio login risulta bloccato. Nessuna protezione modificata.
Archivio Release senza firma riuscito dal commit `bcbdae660a9820591d94453449efbbf8954d1b19`:
284 input SHA-256 verificati, app e tre estensioni alla 107, sette WAV presenti.

Un export automatico Apple dell'archivio grezzo produce un'IPA Distribution valida **senza gli entitlement
necessari**: NON caricata. Per questo `scripts/prepare-cloud-signing.py` prepara una copia dell'archivio
con firma ad hoc senza chiavi, usando esattamente gli entitlement versionati e il team in ExportOptions.
Il pacchetto intermedio non è installabile né distribuibile. Solo dopo l'export Apple e il controllo dell'IPA
(firma, App Group, push, Keychain condiviso, diario soltanto nel principale) si può caricare.
Evidenze fuori da Git: `~/Library/Caches/ernie-builds/build-107-20261027-sounds/`.

L'export della copia con gli entitlement completi è rimasto senza avanzamento per oltre cinque minuti
ed è stato interrotto. Nessuna IPA di questa prova è stata caricata. `prepare-cloud-signing.py` resta
**sperimentale**, verificato soltanto nella preparazione ad hoc: non usarlo come procedura di rilascio
ordinaria finché l'export completo non è validato. Non inferire la causa del blocco dall'assenza di log.
La copia temporanea della credenziale API Apple è stata rimossa dopo ogni tentativo. Nessuna chiave di firma
trasferita, nessun permesso del Portachiavi cambiato. Chiesto all'utente di sbloccare direttamente login sul
Mac Studio per riprendere la procedura ordinaria. Il pacchetto senza firma non è installabile.

Per riprendere sul Mac Studio: recuperare `main` senza sovrascrivere modifiche, verificare il numero
successivo disponibile su App Store Connect, ricompilare dal commit pubblicato e usare la normale
`CURRENT_PROJECT_VERSION=107 apps/ios/scripts/testflight.sh` con l'autenticazione Apple già configurata.
Verificare realmente upload, stato `VALID`, gruppo Interni e note italiane; poi aggiornare HANDOFF e questa
nota. Non riutilizzare le IPA di prova prive di entitlement o gli archivi ad hoc sperimentali.

## Ripresa richiesta dall'utente: stessa esportazione API della 106

Confrontati i log conservati della 106: il suo export API firma tramite Apple e normalizza il prefisso
legacy `QH3PSRG2YB` delle notifiche al prefisso finale `76X78MBPR3`. Il nuovo helper accetta
`--profiles-from <archivio 106>`: verifica team, scadenza e bundle prima di copiare i profili locali;
risolve AppIdentifierPrefix per componente, senza supporre che sia sempre uguale al Team ID.
Solo profili già presenti sul Mac, mai aggiunti a Git. Export di revisione e verifica IPA prima di ogni upload.
La firma ordinaria con chiave Development dell'ufficio resta rifiutata al nuovo controllo; non è lo stesso
stato osservato al momento dell'archive della 106. Ultima build Apple verificata: ancora 106 VALID.
