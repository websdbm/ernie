# Build 109 — Messaggi in famiglia

27 ottobre 2026. **In preparazione**, ultima disponibile verificata: 108.

## UX

Una sola superficie con destinatario/mittente, urgenza e ora nell’intestazione; testo in evidenza;
stato della conferma in fondo, separato da una linea sottile. Rimossi etichette esterne a forma di busta,
bordo rosso spesso e descrizione ripetuta del telefono che suona. Gli urgenti usano tutta la larghezza della chat.
Il rosso segnala l’urgenza, senza circondare l’intero messaggio. Dopo la conferma compare lo stato positivo con ora.
Il solo invio non viene presentato come consegna o lettura verificata.

Palette e tipografia seguono l’orso (Borg monospaziato incluso), in chiaro e scuro. Testo e nomi lunghi si
espandono; con Dynamic Type accessibile le azioni si dispongono in verticale. Pulsanti con altezza minima 44 pt.
Le foto mantengono le proporzioni, entro 240 pt di altezza. Testo selezionabile.
«Rispondi» apre il compositore esistente; «Apri e conferma» apre la schermata di conferma urgente esistente.
Nessuna nuova azione di invio, annullamento o conferma automatica.

Il risultato di `family_message_send` include una nota per il modello: riscontro in una sola frase breve,
dettagli nella scheda; nessuna affermazione che il telefono stia suonando o che la consegna sia verificata.
Non vengono riscritte le risposte di Ernie già presenti nello storico. API di invio, deduplica, notifiche,
ripetizioni e conferma di lettura conservano il comportamento precedente.

## Verifiche

- **27 test iOS verdi**: FamilyMessageCard (4), Lifecycle e Confirmation; simulatore iPhone 17 Pro iOS 26.5.
- Rendering nativo: Borg in attesa, chiaro in attesa, scuro confermato, ricevuto urgente, normale inviato/ricevuto,
  320 pt con caratteri grandi e accessibili. Nomi e messaggi lunghi aumentano l’altezza senza tagliare contenuto;
  foto panoramiche/verticali entro i limiti. Anteprima Borg a 390 pt: altezza totale 198,5 pt, margini inclusi.
- **10 test backend verdi**: family-message-tool, family-urgent e family-push. Invii soltanto simulati;
  nessun messaggio o push reale di prova. TypeScript e Biome riusciti.
- Nessuna migrazione né nuova credenziale. Pubblicazione sorgenti, API e distribuzione 109: in corso.

## Riproducibilità

Build 109 su app e tre estensioni. Sorgenti da pubblicare su GitHub prima di compilare Release da export Git
pulito; firma Apple API come nelle build 107/108. Evidenze: `/tmp/ernie-family-card-*`,
`~/Library/Caches/ernie-builds/build-109-20261027-family-cards/`.
