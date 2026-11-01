# Build 112 — Pulizia visiva della chat

1 novembre 2026. **Disponibile su TestFlight**, gruppo **Interni**.
Apple: **VALID**, **IN_BETA_TESTING**. Build ID `6f729ecb-4a51-424f-aa01-0fb3ae7eefde`.
Note italiane rilette: **674 caratteri**.

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
Sorgenti **`c90cacd9d7e0d6236754bc8829513005a67c6fef`** pubblicati su GitHub prima dell’archivio;
SHA remoto verificato dal Mac Studio e dall’ufficio. Compilazione Release da export Git pulito sul Mac Studio.
**290 file iOS** identici al codice testato, ai sorgenti pubblicati e al manifest SHA-256; verificati di nuovo
dopo l’export. `ARCHIVE SUCCEEDED` e `EXPORT SUCCEEDED`, con la procedura API Apple già usata per la 111.
Profili precedenti validi su una copia dell’archivio senza firma, poi firma Apple Distribution definitiva.
Nessuna chiave copiata, nessun cambiamento al Portachiavi. Non distribuiti gli intermedi.

IPA verificata deep/strict su app e tre estensioni alla 112, permessi esatti rispetto ai sorgenti e al
profilo di distribuzione, diario privato solo nell’app principale. Changelog e WAV corrispondenti ai sorgenti.
**81.143.540 byte**, SHA-256 `6044f40a137ae1c95c1d3158ce809a29d9283d13b4469c5b02544330a5d5131f`.
Caricata la medesima IPA verificata: `UPLOAD SUCCEEDED with no errors`, codice 0.
Ricevuta di consegna `6f729ecb-4a51-424f-aa01-0fb3ae7eefde`; lo stesso ID è stato riletto come build
Apple **VALID**, **IN_BETA_TESTING**, associata automaticamente a **Interni**. Note italiane pubblicate
e rilette; manifest del rilascio aggiornato con stato e ID verificati.

Artefatti e log sul Mac Studio, copie dei manifest anche sull’ufficio:
`~/Library/Caches/ernie-builds/build-112-20261101-clear/`.
Test temporanei in `~/Library/Caches/ernie-builds/clear-20261101-tests/` sul Mac Studio.
Nessun deploy backend o installazione diretta su iPhone fisico. Backend resolver resta quello già pubblicato.
