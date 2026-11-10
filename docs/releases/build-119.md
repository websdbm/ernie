# Build 119 — Salute protetta

10 novembre 2026. **In preparazione, non pubblicata**. API/build effettivamente pubblicate restano 118.

Archivio Salute dedicato: documenti/OCR/originali/valori cifrati per account, consultazione manuale indipendente
dall'AI, consenso continuativo revocabile, elaborazioni isolate dalla chat e dal Second Brain, esportazione
leggibile soltanto esplicita. Nessuna integrazione Abitudini o Apple Salute in questa build.
Contratti, limiti e procedura di recupero in [ricerca 27](../research/27-health-vault-integration.md).

## Verifiche

**117 test backend in 16 suite superati**, inclusi PostgreSQL isolato con ruolo RLS, migrazioni, HTTP,
revoca durante provider in corso, cancellazione durante elaborazione, selezione esplicita fonti,
assenza di scritture negli archivi generici e rifiuto di ingressi sanitari prima dell'indicizzazione.
TypeScript e Biome verificati. Nessun provider AI reale o referto personale usato nei test.

Review indipendente: corretto possibile log del prompt sanitario nelle eccezioni provider Mastra
(regressione sintetica riprodotta, due test passati con logger disabilitato); ricontrollo ticket dopo
attesa del lock; indice legacy Salute.md incluso nella barriera di migrazione.
Migrazione 0053 provata da zero con le precedenti; trasferimento/idempotenza e conservazione copie
incerte testati. Inventario reale in sola lettura: nessun referto/valore/avviso legacy, candidato nei
documenti/Media/Brain o cartella Salute nella storia dei 21 vault. Ripetere dopo stop writer al cutover.

Evidenze temporanee: `/tmp/ernie-health-final-tests.log`, `typecheck-final.log` con lo stesso prefisso,
`/tmp/ernie-health-vault-20261110/`. Nessuna prova su iPhone fisico; la protezione hardware iOS dei
file esportati non è dimostrabile dal solo simulatore.

## Sequenza di rilascio

1. Sorgenti, progetto Xcode, changelog e documentazione su GitHub; verificare SHA remoto.
2. Archivio dal commit pubblicato sul Mac Studio, export Apple, verifica quattro firme/entitlement.
3. Backup DB/configurazione, chiave Salute casuale dedicata in configurazione riservata e copia di recupero
   protetta. Fermare vecchi API/worker durante migrazioni 0052/0053 e passaggio dati; nessun consenso implicito.
4. Runtime dal medesimo Git, inventario finale e migrazione verificata. Smoke su account sintetici,
   test isolamento/revoca/lettura/esportazione e assenza di dati in chiaro. Rimuovere le fixture.
5. Pubblicazione TestFlight solo dopo API pronta; aggiornare questa nota con ricevute/stato effettivo.

Produzione e TestFlight non sono stati aggiornati da questa nota. Non usare il vecchio runtime Salute
come rollback automatico dopo l'apertura del nuovo archivio: reintrodurrebbe scritture in chiaro.
