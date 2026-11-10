# Build 119 — Salute protetta

10 novembre 2026. Pubblicazione autorizzata dall’utente. **API e worker119 pubblicati e sani;
migrazioni0052/0053 e passaggio dati completati. Build119 caricata su Apple, elaborazione in corso.**

Archivio Salute dedicato: documenti/OCR/originali/valori cifrati per account, consultazione manuale indipendente
dall'AI, consenso continuativo revocabile, elaborazioni isolate dalla chat e dal Second Brain, esportazione
leggibile soltanto esplicita. Nessuna integrazione Abitudini o Apple Salute in questa build.
Contratti, limiti e procedura di recupero in [ricerca 27](../research/27-health-vault-integration.md).

## Verifiche

**117 test backend in 16 suite superati**, inclusi PostgreSQL isolato con ruolo RLS, migrazioni, HTTP,
revoca durante provider in corso, cancellazione durante elaborazione, selezione esplicita fonti,
assenza di scritture negli archivi generici e rifiuto di ingressi sanitari prima dell'indicizzazione.
TypeScript e Biome verificati. Nessun provider AI reale o referto personale usato nei test.

**48 test iOS in 7 suite superati** su Mac Studio/Xcode27.0. Verificati UI completa, consenso,
revoca in corso, upload manuale senza AI, export/cleanup, deep link e decodifica eventi. Render chiaro,
scuro, Borg e accessibility3 a375pt, con scorrimento e titoli multilinea. Manifest r10
`328e05e5b77add87333a9dfa6eb3293ac1b736ef8cee1a887e5b4277c5d3c9d0`; rispetto al test,
release differisce solo per numeri build/progetto generato, changelog e label italiana health_open.

Review indipendente: corretto possibile log del prompt sanitario nelle eccezioni provider Mastra
(regressione sintetica riprodotta, due test passati con logger disabilitato); ricontrollo ticket dopo
attesa del lock; indice legacy Salute.md incluso nella barriera di migrazione.
Migrazione 0053 provata da zero con le precedenti; trasferimento/idempotenza e conservazione copie
incerte testati. Inventario reale in sola lettura: nessun referto/valore/avviso legacy, candidato nei
documenti/Media/Brain o cartella Salute nella storia dei 21 vault. Ripetere dopo stop writer al cutover.

Evidenze temporanee: `/tmp/ernie-health-final-tests.log`, `typecheck-final.log` con lo stesso prefisso,
`/tmp/ernie-health-vault-20261110/`. Nessuna prova su iPhone fisico; la protezione hardware iOS dei
file esportati non è dimostrabile dal solo simulatore.

## Artefatti pronti

Sorgenti finali **`203542a5753092c6a641e45a03f4ddb014484ef6`**, pubblicati su GitHub e SHA remoto
verificato prima dell'archivio. Tutti i 313 input iOS corrispondono al commit; 14 overlay dei test nativi
identici ai sorgenti pubblicati. Il precedente archivio 56b9d2b è superato e non è stato distribuito.

Archivio Release ed export Apple completati sul Mac Studio. Quattro firme Apple Distribution verificate
con `codesign --verify --deep --strict`; build119/entitlement corretti e gruppo Diario soltanto nell'app.
Changelog nell'IPA identico a Git. Nessuna modifica al Portachiavi o copia di chiavi private.
IPA **82.588.585 byte**, SHA-256 `3424070bb0c113930a0f293127500504a3b145ff874d1c2e241409b17ef59121`.
Artefatti: `~/Library/Caches/ernie-builds/build-119-20261110-health/`, `source/`, `source-sha.txt`,
`ios-inputs.json`, `Ernie-final-unsigned.xcarchive`, `Ernie-profile.xcarchive`,
`export-profile-api/Ernie.ipa`, `release-manifest.json`, log archive-final/export.

Immagine backend **`sha256:f317e2d6e25834df1fa4ef68a199de87bde9dbe1b087dd5b617bb8ae4305a92b`**
costruita sul server dallo stesso commit recuperato da Git. 20 moduli compilati identici ai test;
smoke cifratura nell'immagine con rete disabilitata superato. API e worker attivi dalla stessa immagine;
Postgres/Redis invariati. Il campo versione descrittivo dell'ambiente mantiene l'etichetta storica:
usare SHA immagine/commit per identificare il backend.

Database locale sintetico e relative credenziali temporanee rimossi dopo i test. La configurazione originale
è conservata byte per byte con la sola aggiunta di `HEALTH_ENCRYPTION_KEYS`; ownership e modi invariati,
override invariato. Chiave casuale dedicata con copia privata sul server, separata dal dump, e copia di
recupero sul Mac dell'ufficio fuori dal repository; checksum delle copie verificati senza esporre il segreto.

## Pubblicazione backend e migrazione verificate

Vecchi API/worker fermati durante il cutover. Backup aggiornato `database-cutover.dump` e indice
`pg_restore --list` verificati in `/srv/staging3/backups/ernie-pre-119-20261110/`.
Applicate **0052_health_protection.sql e0053_health_sources.sql**, 51 migrazioni precedenti riconosciute.
Inventario ripetuto a writer fermi: nessun referto/valore/avviso legacy o candidato documentale/Media;
21 vault, nessun percorso Salute corrente/storico. CLI `--apply --writers-stopped`: ready, zero record
trasferiti perché non presenti, zero consensi attivati. Nessuna cancellazione di dati personali richiesta.

Smoke HTTPS sul runtime effettivo: importazione manuale e retry, export esplicito, originali/allegati,
valori senza data e ricerca parametro, isolamento tra due account, ciphertext senza titoli/OCR/valori in
chiaro, guardie Media/documenti generici, consenso versionato/revoca/disattivazione skill, cancellazione
di fonte/allegati/analisi. Zero chiamate LLM, zero operazioni SSH/provider. Fixture/account/API key rimossi.
Nessun testo sanitario sintetico nei log API/worker e nessun errore; health/ready HTTPS verdi.
Il proxy aggiunge anch'esso no-store: verifica delle direttive HTTP, senza richiedere stringa identica.

Evidenze: `/tmp/ernie119-runtime-smoke-result.json`, copia nel backup server; `activation-verification.json`,
`health-inventory-final.json`, `vault-inventory-final.json`, `health-migration-result.json` nel backup.
Non eseguita prova di ripristino integrale. Immagini pre119 conservate per recupero controllato;
non riattivare il vecchio writer Salute dopo nuovi caricamenti.

## TestFlight

Upload riuscito senza errori, ricevuta **3ad9737e-c595-4a05-bbf1-cebffe82e90a**, trasferiti82.588.585byte.
Hash IPA ricontrollato dopo upload e invariato. Elaborazione Apple e lettura delle note italiane in corso.

## Sequenza di rilascio

1. Sorgenti, progetto Xcode, changelog e documentazione su GitHub; verificare SHA remoto.
2. Archivio dal commit pubblicato sul Mac Studio, export Apple, verifica quattro firme/entitlement.
3. Backup DB/configurazione, chiave Salute casuale dedicata in configurazione riservata e copia di recupero
   protetta. Fermare vecchi API/worker durante migrazioni 0052/0053 e passaggio dati; nessun consenso implicito.
4. Runtime dal medesimo Git, inventario finale e migrazione verificata. Smoke su account sintetici,
   test isolamento/revoca/lettura/esportazione e assenza di dati in chiaro. Rimuovere le fixture.
5. Pubblicazione TestFlight solo dopo API pronta; aggiornare questa nota con ricevute/stato effettivo.

Backup preliminare e backup al cutover conservati. Non usare il vecchio runtime Salute come rollback
automatico dopo l'apertura del nuovo archivio: reintrodurrebbe scritture in chiaro.
