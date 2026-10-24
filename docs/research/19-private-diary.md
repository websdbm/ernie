# Diario personale

## Esperienza

Skill `diario_personale`, distinta dal diario operativo `diario`/«Cosa ho fatto».
Accesso da Impostazioni → Area privata, menu del Second Brain oppure «Apri diario».
Non compare nell'indice delle note, nei widget o nelle notifiche. L'app intercetta
localmente i comandi espliciti prima di creare un messaggio o un turno remoto.

Dopo Face ID/Touch ID si scrive con data e ora automatiche. Le bozze vengono
salvate cifrate; «Conserva originale» produce una pagina immutabile. Ogni pagina
mostra Originale, Riordinato e Punti; le elaborazioni successive sono versionate.
Ricerca locale su originali ed elaborazioni. Un intervallo di date seleziona fino
a 31 pagine per un riepilogo. Il diario locale funziona anche senza rete; l'AI
richiede skill attiva e backend disponibile.

## Confine di sicurezza

- AES-256-GCM con nonce casuale e autenticazione dell'account/server nel ciphertext.
- Chiave casuale per archivio/generazione, nel solo access group Keychain
  `$(AppIdentifierPrefix)com.websdbm.ernie.private-diary`, assente dalle tre estensioni.
- ACL `WhenPasscodeSetThisDeviceOnly` + `biometryCurrentSet`, senza fallback al codice.
  La rimozione del codice o il cambio delle biometrie può rendere inaccessibile la chiave.
- File nell'Application Support privato, protezione completa e cartella esclusa
  dai backup automatici. Nessun contenuto nell'App Group, UserDefaults, database
  server, Git del Brain, indici, notifiche, telemetria o chat.
- Al blocco, uscita/inattività/cattura schermo: chiave e documento non sono più
  esposti dallo store; elaborazione annullata e risultati tardivi scartati.
  Non è una garanzia di azzeramento fisico di tutte le copie RAM di Swift/iOS.
- iOS non impedisce screenshot manuali a diario sbloccato. Sono esclusi dal
  modello di minaccia un dispositivo compromesso e una modifica malevola del client.
- La dettatura **interna** richiede riconoscimento sul dispositivo e non ripiega
  su un servizio remoto. Dalla chat pronunciare soltanto «Apri diario»: la voce
  generale può utilizzare servizi Apple remoti prima di conoscere l'intento.
  Tastiere di terze parti e dettatura della tastiera restano sotto il controllo iOS.
- Se la scrittura fallisce, l'interfaccia segnala le modifiche non salvate.
  Al blocco non si conserva plaintext per aggirare un disco pieno: le modifiche
  non persistite possono essere perse e viene mostrato un avviso esplicito.

La prima versione è locale al dispositivo, senza sincronizzazione automatica.
Esportazione cifrata con password di almeno 12 caratteri, PBKDF2-HMAC-SHA256
600.000 iterazioni, sale casuale e AES-GCM. Password non memorizzata.
Importazione autenticata e limitata nelle dimensioni; sbloccata aggiunge le pagine
mancanti senza sovrascrivere gli originali. Il recupero da archivio bloccato richiede
password e biometria e usa una nuova generazione di chiave. Il vecchio ciphertext
resta nel contenitore privato come `.previous-<UUID>.sealed`, senza esportarlo.
Una copia vecchia non contiene le pagine successive; senza chiave valida o copia
recuperabile Ernie non può ripristinare i testi.

## AI con consenso esplicito

Ogni elaborazione richiede diario sbloccato e conferma delle pagine/caratteri da
inviare. Il consenso è monouso, legato a ID e digest canonico degli originali;
non vale per nuove selezioni o tentativi. Nessun invio al salvataggio, nessuna
elaborazione periodica automatica. L'originale non viene sostituito.

`GET /v1/private-diary/capabilities` e
`POST /v1/private-diary/transform` sono autenticati. POST richiede `consent:true`,
`operation:entry|period`, 1–31 pagine e massimo 60.000 caratteri complessivi.
Il backend vede il testo in chiaro durante l'elaborazione autorizzata: non è una
cifratura end-to-end verso il modello. Il servizio usa direttamente OpenRouter,
modello standard configurato, senza agent/tools/memoria/log dei contenuti, senza
retry automatico o fallback. Richiede routing ZDR e `data_collection:deny`;
se non disponibile fallisce invece di allentare il vincolo. Restano applicabili
le impostazioni e condizioni del proprio account OpenRouter/provider.

Timeout, abort del client, un'elaborazione simultanea per account e sei richieste
al minuto per processo; limiti di budget esistenti. Registro consumi limitato a
contatori numerici, modello configurato, account e ID interno casuale. Nessun ID
provider, testo di errore esterno o contenuto nei metadati registrati. La conferma
biometrica è applicata dal client: il backend non la attesta crittograficamente.

## Verifica

Test Swift: integrità/tamper/account binding, backup/password/parametri, digest,
comandi locali, consenso monouso e selezione esatta, conservazione originali,
risposte tardive dopo lock, recupero, overflow e fallimento persistenza.
Test backend: consenso/scope/skill/budget/rate limit, canary nei log anche su errori
JSON, timeout/disconnessione reale con provider mock, metadati consentiti.
Preview nativa del cancello in chiaro/scuro; test biometrici con key access mock.
Face ID fisico, invalidazione dell'enrollment e Data Protection hardware richiedono
collaudo su iPhone: il simulatore non ne prova il funzionamento.

Fonti: [Apple Keychain accessibility](https://developer.apple.com/documentation/security/ksecattraccessiblewhenpasscodesetthisdeviceonly),
[biometryCurrentSet](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset),
[OpenRouter ZDR](https://openrouter.ai/docs/guides/features/zdr).
