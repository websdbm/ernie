# Build 116 — Promemoria, con più chiarezza

10 novembre 2026. Implementazione approvata dopo le tre proposte visive.
**Sorgenti e test pronti; archivio e distribuzione ancora da effettuare.**
La versione distribuita resta la 115. Nessun cambiamento backend o migrazione.

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

Numero 116 in tutti i target, changelog e progetto Xcode versionati. Pubblicare e verificare il SHA GitHub
prima di compilare l’artefatto distribuito, verificare gli input e firme/entitlement prima dell’upload.
API staging3 resta alla revisione della 115 (`a2f50e5`), nessun deploy richiesto.
