# Promemoria — proposte visive del 10 novembre 2026

Richiesta: proporre schede più professionali prima di modificare l’app. **Solo anteprima**:
nessuna modifica SwiftUI/backend, build o distribuzione. Versione pubblicata: 115.

Aprire [il prototipo offline](reminder-cards-20261110.html): tre varianti, temi chiaro/scuro/Borg,
modifica simulata di titolo/ora/canali e annullamento con conferma. Nessuna rete, persistenza o collegamento
con promemoria reali. Le date sono fixture fisse, non un calcolo relativo all’ora di apertura del prototipo.

- **A · Essenziale (consigliata):** titolo unico, fascia con ora/data, stato dei canali e un pulsante Modifica.
- **B · Compatta:** data a sinistra e footer basso, per raccolte/chat con più promemoria.
- **C · Due momenti:** separa avviso e attività quando il contenuto li distingue esplicitamente.
  Non crea un secondo promemoria e non attribuisce un’ora esatta a “giovedì mattina”.

Regole comuni proposte: niente titolo generico “Promemoria” duplicato; icone lineari; font di sistema
e palette dell’avatar; “Annulla promemoria” nel menu secondario con conferma. Modifica apre anche i canali,
che qui sono indicatori di stato (non pulsanti mascherati). Stato leggibile con testo e simboli oltre al colore.
Pulsanti di almeno 44 px nel prototipo; nessuna area interattiva sull’intero contenitore.

Per l’eventuale implementazione conservare condizioni per luoghi, familiari, ripetizioni, note, URL,
avvisi già scattati/annullati, errori e dimensioni accessibili. La dicitura del momento dell’attività deve
provenire dai dati espliciti, non dal solo titolo ricostruito. L’attuale ReminderItem/eventAt non va
convertito implicitamente in un orario inventato.

Verifiche della sola proposta: rendering delle nove combinazioni variante/tema; ispezione visiva di
A/B/C chiaro e A scuro/Borg; nessuno scorrimento orizzontale a 320/390/406/1280 px; interazioni locali
modifica canali e annullamento confermato/non confermato. Nessuna verifica nativa iOS di questi nuovi layout.

PNG in `reminder-cards-20261110/`. Render e controlli locali in
`~/Library/Caches/ernie-design/reminders-20261110/`.

Approvata il 10 novembre: implementata A, con C soltanto quando esistono due istanti strutturati coerenti.
La B resta una proposta alternativa. Stato implementazione e distribuzione in [build 116](../releases/build-116.md).
