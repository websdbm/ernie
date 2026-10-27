# Build 107 — Suoni di Ernie

27 ottobre 2026. Modifica iOS; nessuna dipendenza o pubblicazione backend.
Stato: preparazione e verifiche; build 106 resta quella pubblicata finché non è verificata la distribuzione Apple.

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

Prima della distribuzione: pubblicazione del commit sorgenti su GitHub main, compilazione pulita
da quel commit, verifica firma/versioni delle quattro componenti, upload e rilettura stato Apple.
La resa sonora su altoparlante/cuffie e silenzioso richiede una prova sul dispositivo fisico.

## Firma senza sbloccare il Portachiavi: verifica in corso

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
