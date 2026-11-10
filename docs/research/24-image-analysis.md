# Analisi immagini — Jev e modello visivo

10 novembre 2026. L'utente chiede di mettere in cantiere analisi di fotografie con Jev, una serie di
domande e un modello LLM. **Specifica, non implementazione; nessuna immagine personale inviata nei test.**
Integrare la raccolta Media, i documenti, le ricette e i collegamenti al Brain già presenti.

## Esperienza prevista

Skill **Analisi immagini**, attivabile per account secondo la richiesta comune sulle nuove funzioni.
Da spenta niente nuove analisi automatiche né job AI ancora in coda di questa skill; foto e risultati
precedenti rimangono consultabili. I flussi esplicitamente richiesti di altre skill (es. una ricetta)
seguono i rispettivi permessi: definire chiaramente la proprietà di ogni chiamata per non aggirare lo stop.

L'utente scatta o seleziona una o più foto. Ernie mostra una lettura iniziale e permette domande successive
sulla stessa immagine, mantenendo visibile quale foto sta analizzando. Poche azioni concrete, ad esempio
«Leggi il testo», «Analizza un dettaglio», «Collega a un luogo». La richiesta esplicita guida l'analisi;
non forzare la foto in Ricette o Schema per la sola cronologia precedente.

Esempi:
- Foto di un cartello: leggere il testo, spiegare gli orari e associare al luogo indicato/verificato.
- Etichetta di un oggetto: identificare marca/modello se leggibili e usare il web per cercare il manuale,
  indicando la fonte; nessun manuale specifico dedotto soltanto dall'aspetto.
- Foto di una preparazione o ricetta: distinguere piatto da istruzioni scritte; non inventare dosi o
  procedimenti dalla sola foto di un piatto finito.
- Foto di un luogo: elementi visibili e collegamento attraverso posizione della foto/dichiarazione
  dell'utente. La posizione attuale del telefono non è automaticamente quella di una foto vecchia.

## Base verificata

- `packages/model-gateway/src/media-labels.ts` invia già immagine e OCR al modello light per titolo,
  descrizione, categoria e tag. Non è un sistema generale di domande sull'immagine.
- `apps/api/src/routes/media.ts` cataloga la miniatura, gestisce foto/hash/duplicati e metadati; le scritture
  manuali prevalgono sul risultato AI arrivato dopo. Riutilizzare archivio e identità, non duplicarli.
- `apps/api/src/ws/connection.ts` fornisce a Jev **solo i metadati** degli allegati nel percorso corrente,
  poi istruisce il modello a leggere il contenuto prima di scegliere la skill.
- `packages/jev-router` usa lo schema Decisions con domande `noul/choice/score` e default `jev-1.13`.
  Il client non prepara immagini. Non dichiarare che Jev stia già analizzando i pixel in Ernie.

La documentazione OpenRouter verificata descrive immagini nella Decisions API; il catalogo presenta
`typesafe/jev-1.14` come modello testo+immagini con risposte strutturate. Usare una versione verificata
e testarla, senza cambiare globalmente il router esistente soltanto per abilitare questa skill.

## Percorso proposto

1. **Preparazione locale/deterministica:** orientamento, formato, dimensioni, hash, OCR dove disponibile,
   identificativo della foto e metadati consentiti. Salvare la foto una sola volta; proteggere gli originali.
   Servono risoluzione/ritagli adeguati per caratteri piccoli, non soltanto la miniatura della galleria.
2. **Domande strutturate in batch:** tipo di contenuto (compreso altro/ambiguo), presenza e leggibilità del
   testo, elementi utili alla richiesta, necessità di un ritaglio o dettaglio. Jev può guardare i pixel,
   oltre al testo e alla domanda dell'utente; non deve dedurre il tipo da un titolo generato in precedenza.
3. **Domande adattive:** modelli di domande per casi comuni; il LLM può proporne altre su uno schema
   validato e con numero/budget limitati. Jev risponde alle domande chiuse/strutturate; non è il generatore
   di descrizioni libere. Non eseguire obbligatoriamente entrambi per una richiesta già risolta con certezza.
4. **Analisi visiva:** per descrizioni, trascrizione e domande aperte il modello visivo riceve la foto o
   ritagli pertinenti, la richiesta e le evidenze, mantenendo distinta l'informazione OCR da quella visiva.
5. **Chiarimenti:** una domanda breve se ambigua («Vuoi leggere il cartello o sapere cos'è l'oggetto?»);
   se sfocata dichiarare cosa non si legge. Confidenza del classificatore non equivale a verifica fattuale.
6. **Risposta e collegamenti:** dati visibili, interpretazioni e fatti forniti dall'utente distinti. I
   collegamenti a luogo/ricetta/documento usano ID dell'account e provenienza; niente copie incoerenti.
   I fatti utili possono seguire il consolidamento locale dell'area; le ipotesi non diventano confermate.

Letture successive riusano analisi/versione quando pertinente, ma tornano alla foto originale per domande
su dettagli non descritti. Chiave cache: account, hash foto, versione analisi/modello, ritaglio e domanda.
Batch con ID per ogni foto, ordine e completamenti parziali espliciti: quattro foto non devono diventare
silenziosamente una sola. Collegare follow-up all'ID corretto; se ci sono più candidate, chiedere la scelta.

Jev non va usato per aritmetica, controlli di permesso o lookup certi: eseguirli in codice. Misurare se il
passaggio aggiuntivo riduce chiamate/costi o migliora instradamento prima di renderlo obbligatorio.
Maximize può scegliere il modello dell'analisi principale solo se compatibile con immagini e vincoli
del dominio. Nessuna escalation costosa automatica senza budget o ripetizione incontrollata.

## Confini e prove

Testo nelle immagini/OCR = contenuto da analizzare, mai istruzioni autorizzate. Nessuna pubblicazione
di URL permanenti per far leggere immagini private al provider; usare trasferimento autorizzato e limitato.
Riconoscere un documento medico instrada a Salute e ai suoi consensi, non lo sparge nel Brain ordinario.
Identità personali dichiarate dall'utente, non attribuite dal volto o dal semplice luogo fotografato.

Prima del rilascio: immagini senza testo, ricette/etichette/cartelli, testo piccolo/sfocato/ruotato,
domande ambigue, prompt injection visiva, più allegati e foto precedenti, upload duplicato/retry,
interruzione/disattivazione, isolamento account, consenso sanitario, costi e confronto con annotazioni
umane su un campione rappresentativo. Prova reale con fixture non personali dopo test del contratto.

Fonti ufficiali:
- [Decisions multimodali](https://openrouter.ai/docs/guides/community/multimodal-decisions)
- [Jev 1.14](https://openrouter.ai/typesafe/jev-1.14/)
- [Invio immagini al modello visivo](https://openrouter.ai/blog/tutorials/send-image-to-llm/)
