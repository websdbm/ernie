# Build 112 — Pulizia visiva della chat

1 novembre 2026. **In preparazione**, non ancora distribuita. Ultima TestFlight verificata: 111.

## Comportamento

`/clear` nasconde messaggi e schede già presenti sul telefono, come una pulizia dello schermo del terminale.
La sessione resta la stessa: nessuna richiesta al modello, nessun consumo di token, nessuna eliminazione
sul server o nel Second Brain. Il transcript locale conserva gli elementi e i payload delle richieste.
Coda, richieste attive, stato vocale e cursore di recupero non vengono azzerati o annullati.
I nuovi elementi appaiono normalmente; gli aggiornamenti di elementi già nascosti restano nascosti fino
al ripristino, disponibile con «Mostra la cronologia» anche mentre una risposta continua.

La scelta è salvata nel file locale della singola conversazione e sopravvive a riapertura/cambio chat.
Una nuova conversazione parte senza elementi nascosti. «Mostra la cronologia» ripristina gli elementi
ancora conservati dalla politica preesistente della chat (massimo 400 elementi locali); `/clear` non
introduce una cancellazione o un nuovo limite di conservazione. Nessuna sincronizzazione della scelta
sugli altri dispositivi. I transcript delle versioni precedenti, privi del campo opzionale, restano visibili.

Comando disponibile senza skill aggiuntive, riconoscibile anche con `/cl` nei suggerimenti; confronto
senza distinzione fra maiuscole/minuscole. Argomenti inattesi e allegati vengono bloccati localmente senza
perdere la bozza. Nessuna aggiunta di `/clear` alla conversazione né invocazione di strumenti.
Aiuto, descrizione e accessibilità spiegano che si tratta solo della schermata.

## Verifiche

26 test iOS verdi in cinque suite su Mac Studio: parser/comandi, cronologia Spesa, Todo, indice transcript e
anteprima nativa in una finestra UIKit.
Verificati contenuti integri prima/dopo clear, stessa sessione, richiesta attiva/coda, ripristino,
riapertura, cambio chat, aggiornamenti di risposta, cursore replay e formato precedente.
Le prove usano file temporanei e nessuna connessione a un account reale.
Anteprime native ispezionate in chiaro, Borg scuro e Dynamic Type accessibile a 320 punti: testo e azione
di ripristino leggibili. La cattura è dalla finestra UIKit; ImageRenderer da solo non disegna lo ScrollView.
25 test funzionali nel run principale, più il test nativo eseguito separatamente (selettore Swift Testing con parentesi).

## Riproducibilità e distribuzione

Tutti i quattro target aggiornati alla 112 in `project.yml` e progetto Xcode; changelog versionato.
Sorgenti e documentazione da pubblicare prima dell’archivio di distribuzione, compilato da Git pulito.
Nessun deploy backend o installazione su iPhone fisico in questa fase.
