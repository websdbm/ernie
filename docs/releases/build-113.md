# Build 113 — Clear senza testi né ripristino

1 novembre 2026. **Disponibile su TestFlight**, gruppo **Interni**.
Apple: **VALID**, **IN_BETA_TESTING**. Build ID `18e62402-c242-4585-80d9-73a80d916084`.
Note italiane rilette e confrontate con il changelog: **232 caratteri**.

`/clear` lascia l’area dei messaggi completamente vuota. Rimossi il titolo «Schermata pulita»,
la spiegazione e «Mostra la cronologia», insieme al metodo di ripristino. Aiuto del comando abbreviato.
La stessa pulizia resta anche alla riapertura e tornando a questa conversazione dal pannello laterale.
Il contesto di Ernie, la sessione e le richieste sono conservati come nella 112; nuovi messaggi visibili.
Nessun deploy backend, migrazione o eliminazione dei dati sul server.

**26 test verdi in cinque suite** sul Mac Studio: comandi e persistenza, regressioni Spesa/Todo/indice
transcript e prova nativa chiaro/Borg/caratteri grandi. Controllati tutti i pixel: solo sfondo uniforme.
Nessun account reale o nuova richiesta LLM nelle prove.
Tutti i quattro target alla 113. Sorgenti **`650ff4c0ae7c9837c603ca08caec93887c9f1c6f`** pubblicati su GitHub,
SHA remoto verificato prima dell’archivio Release da export Git pulito sul Mac Studio. **290 file iOS**
identici al codice testato, al checkout pubblicato e al manifest SHA-256. Archivio ed export riusciti.

IPA Apple Distribution verificata deep/strict su app e tre estensioni alla 113, permessi conformi,
Keychain del diario privato solo nell’app principale. Changelog e WAV identici ai sorgenti.
Esportazione con API Apple e profili precedenti validi, senza copiare chiavi o cambiare il Portachiavi.
**81.139.035 byte**, SHA-256 `2be6b1b27bcae61c1189b9f488f4986d923077b9833f2a6e9bcc7ee7a8b4f26b`.
Caricata la medesima IPA verificata: `UPLOAD SUCCEEDED with no errors`, codice 0.
Stato Apple riletto: **VALID**, **IN_BETA_TESTING**, associazione automatica a **Interni**.
Manifest aggiornato con ID e stato verificati; nessuna installazione diretta su iPhone.

Artefatti sul Mac Studio e copie dei manifest sull’ufficio:
`~/Library/Caches/ernie-builds/build-113-20261101-clear/`.
