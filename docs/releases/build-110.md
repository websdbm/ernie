# Build 110 — Comandi rapidi con /

28 ottobre 2026. **Disponibile su TestFlight**, gruppo **Interni**.
Apple: **VALID**, **IN_BETA_TESTING**. Build ID `82f121a3-012f-423d-bffe-78f17cf0188e`.
Note italiane pubblicate e rilette: **698 caratteri**.

## Comportamento

Scrivere `/` nella barra apre il menu locale; continuare (`/mes`) filtra i suggerimenti.
`/messaggio` apre il compositore Famiglia. `/messaggio testo…` ne prepara il testo, mantenendo righe e punteggiatura:
il destinatario si sceglie nel modulo e l’invio avviene solo premendo Invia. Nessun invio automatico.

Comandi: `/messaggio`, `/famiglia`, `/todo`, `/ricette`, `/brain`, `/media`, `/promemoria`,
`/automazioni`, `/ssh`, `/impostazioni`, `/consumi`, `/aiuto`. Alias: `/msg`, `/attivita` (anche accentato),
`/memoria`, `/secondbrain`, `/impegni`, `/reminder`, `/help`, `/comandi`. Gli altri comandi aprono le schermate
esistenti e accettano solo il nome, senza argomenti. Consumi apre sempre il pannello personale.

Il menu e la pagina di aiuto mostrano solo le skill attive, rilette per account quando si apre il menu;
nessuna attivazione o aggiramento delle autorizzazioni. Le risposte a credenziali vecchie vengono scartate.
Il diario privato resta fuori dal catalogo; `/diario` non è un comando e non viene mandato all’AI.
Il percorso esistente «apri diario» mantiene sblocco e consenso separati.

Comandi sconosciuti, argomenti non supportati, messaggi oltre 2.000 caratteri e allegati in preparazione:
errore locale, mantenendo bozza e allegato. URL e normali frasi con slash restano testo ordinario.
Invio del comando riconoscibile dal simbolo Return e dall’etichetta accessibile «Apri il comando».
Nessuna chiamata al modello, consumo di token o modifica backend per usare le scorciatoie.

## Verifiche

Parser, alias, skill spente e non ancora caricate, testo multilinea, allegati, comandi sconosciuti,
nessun accesso admin dai consumi. Rendering in chiaro, Borg e Dynamic Type; menu a scorrimento con altezza
esplicita per evitare righe tagliate. Digitazione `/mes` con cursore Borg e focus mantenuto; compositore
con testo sintetico precompilato, senza account o connessioni di prova.

Una prima esecuzione mista ha mostrato il problema di focus già noto nel simulatore: due test usavano
finestre diverse contemporaneamente. Le nuove prove con finestre sono state riunite nella suite UIKit
serializzata, poi la verifica combinata è passata. **Verifica finale della 110: 16 test verdi in tre suite** (SlashCommand, TerminalChat, FamilyMessageCard).
Digitazione e precompilazione provate su finestre native, con correzione del viewport verificata in screenshot.
Pubblicazione GitHub e distribuzione TestFlight verificate.


## Riproducibilità

Sorgenti **`e7bd0f35a6771f95fa99fbea8fa6177d110c5b59`**, pubblicati e verificati su GitHub prima della
compilazione Release da export Git pulito. Build 110 su app e tre estensioni, 290 file iOS nel manifest SHA-256.
`ARCHIVE SUCCEEDED`, `EXPORT SUCCEEDED`. IPA Apple Distribution verificata su app e tre estensioni,
versioni 110 e permessi conformi ai sorgenti, diario privato solo nell’app principale. Changelog e WAV
confrontati con il commit; manifest IPA 59 file. Nessun deploy backend.
Upload della stessa IPA verificata: `UPLOAD SUCCEEDED with no errors`, codice 0, 81.076.688 byte.
Delivery UUID `82f121a3-012f-423d-bffe-78f17cf0188e`.
SHA-256: `f74fdf02b1a2f8c16eb397cd8d346deed06238000d06e8e82c05c9a10d8b48de`.
Credenziali API Apple temporanee rimosse dopo export e upload; nessuna chiave privata di firma trasferita.
Stato finale Apple verificato: `VALID`, `IN_BETA_TESTING`, gruppo Interni associato automaticamente.
Note italiane rilette: 698 caratteri. Nessuna installazione su iPhone fisici in questa sessione.
Artefatti privati: `~/Library/Caches/ernie-builds/build-110-20261028-slash-commands/`.
Log di prova: `/tmp/ernie-slash-110-tests.log`. Screenshot nativo della barra con `/mes` ispezionato:
suggerimento completo e cursore a blocco mantenuto.
