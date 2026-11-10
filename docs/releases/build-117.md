# Build 117 — Maximize

10 novembre 2026. Implementazione autorizzata dall’utente; rilascio in preparazione.
**Non ancora distribuita. API non ancora pubblicata.** Nessuna migrazione.

- Skill Maximize spenta inizialmente per account; selettore modello e sforzo sopra la barra di scrittura.
- Scelta per conversazione, conservata localmente; nuovo task/conversazione in Automatico, snapshot nella coda.
- Anthropic diretto e OpenRouter distinti, cataloghi reali, livelli compatibili e tariffe base visibili.
- Override limitato al modello principale; nessun fallback silenzioso. Resta possibile il routing Automatico.
- Skill/controllo genitori rivalidati, SSH solo con modelli avanzati approvati e classe heavy.
- Stime di costo anche per nuovi modelli, output limitato; errore comprensibile per risposta vuota.
- Compatibilità Sonnet 5.5 esplicita con `between_tools`; profili automatici non cambiati.

## Verifiche

Typecheck TypeScript superato; 113 test backend mirati (15 suite), compresi WebSocket/replay,
provider wire-format, revoca, cache e isolamento delle conversazioni. 17 test nativi in quattro suite
(Maximize, aspetto, task concorrenti e indice cronologia), Xcode 27.0 sul Mac Studio. UI nativa renderizzata
in chiaro, scuro e Borg; contrasto delle tariffe corretto dopo ispezione. Nessuna prova su iPhone fisico.

Smoke reale con contenuti sintetici: Fable 5.2/Anthropic e Sol 6.1/OpenRouter chiamano un tool numerico,
eseguono due step e restituiscono 7. Nessuna azione esterna, contenuto personale o modifica runtime.
Catalogo live: 292 opzioni compatibili, di cui quattro dirette Anthropic. Vedere ricerca 23 per confini.

Evidenze temporanee: `/tmp/ernie-maximize-*.log`; Mac Studio
`~/Library/Caches/ernie-checks/maximize-20261110/source/` (test, DerivedData e anteprime simulatore).

## Rilascio

Numero 117 e changelog versionati; commit sorgenti/archivio/firme da registrare dopo le verifiche finali.
Pubblicazione API subordinata al via libera previsto da HANDOFF. Non attivare la skill sui singoli account.
