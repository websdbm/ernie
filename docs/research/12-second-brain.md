# 12 — Second brain: proposta da discutere

> Stato: **proposta** (13 ottobre 2026). Nessun codice scritto. Richiesta dell'utente: «una seconda memoria esplicita che può comunicare con la memoria di Ernie e travasare da lì contenuti, o posso metterci io contenuti in vari modi, ad es. caricando file; struttura di un wiki, navigabile sia da me che da Ernie».

## 1. L'idea in una frase

La memoria di Ernie è **implicita**: fatti estratti in automatico dalle conversazioni, che Ernie usa senza che tu li veda. Il second brain è **esplicito**: pagine di un wiki che tu vedi, scrivi e correggi, e che Ernie legge, cita e propone di arricchire.

| | Memoria di Ernie | Second brain |
|---|---|---|
| Chi scrive | Ernie, da solo, dopo ogni turno | Tu; Ernie con le regole del §5 |
| Forma | Fatti brevi, con date e affidabilità | Pagine con titolo, testo, collegamenti, fonti |
| Visibilità | «Cosa ricordi di me?» (A4) | Navigabile nell'app come un wiki |
| Autorità | Può sbagliare, va in dubbio (M1) | È la tua versione dei fatti: vince sui fatti in conflitto |

## 2. Struttura del wiki

- **Pagina**: titolo, testo in markdown, sezione, etichette, data, autore (tu o Ernie), stato (bozza o confermata).
- **Sezioni**: un albero semplice a due livelli, per esempio Persone, Casa, Scuola, Ricette, Salute, Progetti. Ne propongo alcune all'inizio e le puoi rinominare.
- **Collegamenti** `[[Nome pagina]]` tra pagine, con l'elenco dei rimandi in fondo a ogni pagina («citata da»).
- **Fonti** attaccate a ogni pagina: file caricato, documento, pagina web, conversazione, fatto della memoria. Ogni affermazione portata da Ernie dice da dove viene.
- **Versioni**: ogni modifica è una revisione, con «annulla» e confronto. Copre anche la proposta C7 della ricerca 11.
- **Pagina «Da sistemare»**: dove finisce quello che Ernie non sa dove mettere, da smistare quando vuoi.

## 3. Come entrano i contenuti

1. **Scrivendo nell'app**: editor markdown semplice, con un pulsante per collegare un'altra pagina.
2. **A voce o in chat**: «salva nel second brain che la verifica di storia è sul capitolo 3», «aggiungi alla pagina Giorgio che il dentista è il dottor Rossi». Ernie mostra l'anteprima prima di salvare.
3. **Caricando file**: foto, PDF, scansioni. Si riusa la catena dei documenti già pronta: testo letto sul telefono, pezzi con pagina, citazioni verificate. Il file diventa una pagina con riassunto oppure la fonte di una pagina esistente.
4. **Da un link**: Ernie legge la pagina web e ne fa un ritaglio con la fonte. Il contenuto web resta marcato come non fidato.
5. **Travaso dalla memoria di Ernie**: vedi §4.

## 4. Il travaso tra le due memorie

**Dalla memoria al wiki.** Ernie raggruppa i fatti che parlano della stessa cosa (tutti quelli su Giorgio, sulla casa, sulle allergie) e propone una pagina o un'aggiunta: «Ho 12 cose su Giorgio: ne faccio una pagina?». Tu accetti, correggi o scarti. I fatti travasati restano nella memoria con un rimando alla pagina.

**Dal wiki a Ernie.** Ernie non copia le pagine nella memoria, le legge quando servono:
- nel prompt c'è solo l'**indice dei titoli** (poche centinaia di token, nel prefisso che resta in cache);
- quando la domanda tocca una pagina, Ernie la cerca e la legge con un tool, e cita la pagina come cita le pagine dei documenti;
- se un fatto della memoria contraddice una pagina confermata, vince la pagina e il fatto va «in dubbio» con il giudice M1 già in esercizio.

## 5. Cosa può fare Ernie nel wiki

Propongo questa regola:
- **Leggere e cercare**: sempre.
- **Creare bozze e aggiungere in fondo a una pagina**: sì, con revisione visibile e notifica nel diario «Cosa ho fatto».
- **Riscrivere o cancellare** testo scritto da te: mai senza conferma.
- **Contenuti da web o file**: entrano come bozza con la fonte, mai mescolati in silenzio al tuo testo. La Rule of Two già attiva impedisce che un testo ostile muova dati privati verso l'esterno.

## 6. Come si naviga

**Tu, nell'app**: una scheda «Second brain» con sezioni, ricerca, pagina con collegamenti e fonti, pulsante «Chiedi a Ernie su questa pagina». Anche il widget potrebbe mostrare una pagina fissata.

**Ernie, con i tool**: `wiki_search` (ricerca ibrida come per i documenti), `wiki_read`, `wiki_list` per sezione, `wiki_propose` per bozze e aggiunte. Sono tool di sola lettura tranne l'ultimo, che passa dalle regole del §5.

## 7. Dove stanno i dati

Consiglio Postgres, come il resto: pagine, revisioni e pezzi con vettori, con isolamento per utente già garantito dalla RLS. Così si riusano ricerca ibrida, citazioni e backup. In più, un'**esportazione in cartella markdown** compatibile con Obsidian, per non restare chiusi dentro Ernie.

L'alternativa è tenere i file markdown in una cartella sincronizzata (Obsidian, iCloud) come fonte primaria. È più aperta ma complica conflitti, ricerca e permessi. La terrei come seconda fase, solo se ti serve modificare da computer.

## 8. Fasi proposte

1. **B1, il minimo utile**: pagine, sezioni, revisioni; salvataggio da chat e da file; ricerca e citazioni per Ernie; scheda iOS per leggere e modificare.
2. **B2, il travaso**: proposte dalla memoria, collegamenti e rimandi, pagina «Da sistemare», precedenza del wiki sui fatti in conflitto.
3. **B3, apertura**: pagine condivise in famiglia, esportazione markdown, eventuale sincronizzazione con Obsidian.

## 9. Decisioni da prendere insieme

1. **Quanta libertà dai a Ernie**: solo bozze da approvare, oppure aggiunte libere con revisione visibile come propongo al §5?
2. **Travaso**: Ernie propone da solo ogni tanto, oppure solo quando glielo chiedi?
3. **Struttura**: sezioni proposte da me, oppure parti da zero con sole etichette e collegamenti?
4. **Famiglia**: le pagine restano solo tue, oppure alcune sezioni (per esempio Casa) si possono condividere con Giorgio?
5. **Obsidian**: ti serve modificare il wiki anche dal computer? Cambia la scelta del §7.
6. **Nome nell'app**: «Second brain», «Quaderno», «Wiki» o altro?
