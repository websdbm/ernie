# Build 116 — Promemoria, con più chiarezza

10 novembre 2026. Implementazione approvata dopo le tre proposte visive.
**Disponibile su TestFlight**, gruppo **Interni**, Apple **VALID / IN_BETA_TESTING**.
Nessun cambiamento backend o migrazione. Ricerca web, Abitudini, Apple Salute, Maximize e analisi
immagini discusse durante il rilascio restano specifiche separate, non funzionalità nuove della 116.

- Scheda Essenziale nella chat e nella raccolta: titolo unico, ora/data, stato e un solo pulsante Modifica.
- Timeline avviso/appuntamento soltanto con `at` e `eventAt` validi, distinti e coerenti; nessun orario
  inventato da frasi come “giovedì mattina”. Titoli generici duplicati e riquadro arancione rimossi.
- Menu secondario con annullamento confermato; editor condiviso con interruttori Sveglia/Email.
  I canali si aggiornano immediatamente e questo è dichiarato; gli altri campi usano Salva.
- Conservati luoghi, destinatario/mittente familiare, ricorrenze, link, indirizzi, note ed errori.
- Palette dell’avatar e caratteri accessibili, disposizione verticale quando serve. Nessun cambiamento
  alla programmazione degli avvisi, alle notifiche o ai dati salvati.

## Verifiche

18 test nativi in tre suite (`ReminderCardTests`, `EventsCodingTests`, `ActionStyleTests`), tutti verdi.
Simulatore «Ernie prova», Xcode 27.0 sul Mac Studio. Verificati dati temporali, compatibilità del protocollo,
PATCH dei dettagli, area dei pulsanti, contrasti e testo lungo/accessibile. Rendering nativo UIKit/SwiftUI
di undici casi di scheda e due editor: chiaro, scuro, Borg, 320/390 pt, caratteri grandi, stati e casi speciali.
L’ImageRenderer usato per misurare produce un segnaposto per Menu UIKit: le immagini ispezionate sono
acquisite dalla gerarchia UIKit reale e mostrano correttamente il menu ⋯.

Evidenze: `~/Library/Caches/ernie-checks/reminders-20261110/`, file `tests-final.log` e `previews/`.
Nessuna prova con promemoria reali, notifica inviata o installazione su iPhone fisico.
Il Mac dell’ufficio ha una nuova licenza Xcode non ancora accettata: compilazione sul Mac Studio senza
modificare licenze, Portachiavi o impostazioni del computer dell’ufficio.

## Distribuzione

Sorgenti **`603cf6e8316db29b90f31c207b295ae8fce58fc2`**, pubblicati su `main` e SHA remoto verificato prima
dell'archivio. Numero 116 in tutti i target, changelog e progetto Xcode versionati. Export Git pulito sul
Mac Studio: **302 file iOS** identici al manifest Git e al codice dei test nativi.

Archivio Release riuscito, preparazione della copia tramite `prepare-cloud-signing.py` e profili validi
della build 115, export Apple con autenticazione API e `destination=export`. Verificate prima dell'upload
le firme Apple Distribution di app e tre estensioni, `get-task-allow=false`, entitlement conformi ai
sorgenti (APS production) e gruppo privato del diario soltanto nell'app. Changelog dell'IPA identico a Git;
36 risorse confrontate con l'archivio. Nessuna chiave privata copiata né modifica al Portachiavi.

Caricata la stessa IPA verificata: **81.936.255 byte**, SHA-256
`be3351b2e4e13ab0e5638511049197831f337c797edc25daa4d9303553a2665f`.
Upload riuscito senza errori il 10 novembre. Build ID **`e9642d54-9cb7-4660-83fe-1a433c1a354d`**.
App Store Connect: `VALID`, `IN_BETA_TESTING`, gruppo interno `Interni`; nessun invio a revisione beta
esterna. Note italiane rilette: **823 caratteri**, identici al changelog incluso nella build.

Artefatti sul Mac Studio: `~/Library/Caches/ernie-builds/build-116-20261110-reminders/`, con `source/`,
archivi, `export-profile-api/Ernie.ipa`, manifest input/verifica/rilascio, log archive/export/upload e
letture ASC. `release-manifest.json` registra l'esito finale; hash IPA verificato anche dopo l'upload.
API staging3 resta alla revisione della 115 (`a2f50e5`), nessun deploy richiesto.
