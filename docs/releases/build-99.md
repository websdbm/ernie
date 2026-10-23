# Build 99 — Orso e palette, cursore Borg

Data: 23 ottobre 2026. **Disponibile su TestFlight**, verificata alle 08:42 CEST.
`VALID`, `IN_BETA_TESTING`, gruppo «Interni» con accesso verificato; note italiane aggiornate.

## Modifiche

- Dodici palette, una per costume, con varianti chiare/scure. Borg usa Bash verde.
- Un unico selettore Orso e palette nelle impostazioni e scelta dalla capsula.
  Rimosso l'interruttore Terminale; la precedente preferenza non viene più letta.
- In Automatico avatar e colori condividono lo stesso costume risolto.
- Cursore verde rettangolare effettivamente disegnato e pulsante, senza prompt `>`.
  Selezione e IME conservano gli indicatori nativi; Riduci movimento evita il lampeggio.
- Preservata la gestione del focus separata UIKit/SwiftUI della build 98.

## Verifiche

- Debug: 18 test in 3 suite (`TerminalChatTests`, `ConfirmationTests`, `ReadabilityTests`), passati.
- Nessun ciclo AttributeGraph nel log Debug.
- Ispezione visiva delle 24 schermate native dei dodici costumi e della barra
  con cursore realmente visibile. Contrasti principali almeno 4,5:1.
- Release: 6 test della suite `TerminalChatTests` passati; nessun ciclo AttributeGraph.
- Nessuna prova su iPhone fisico in questa sessione.

[Dettagli e anteprime](../ui/chat-terminal.md).

## Tracciabilità del rilascio

- Commit dei sorgenti: `f36d9ecb61854d3dac6ba7505f057bcad28c7140`, pubblicato e
  verificato su GitHub `main` prima della compilazione.
- Mac Studio: checkout pulito aggiornato al commit; snapshot `git archive` e
  hash SHA-256 verificati per tutti i 257 input iOS versionati.
- Archive Release iPhone e export firmato Apple Distribution riusciti.
- App, notifiche, condivisione e widget: build 99, firma, profili di distribuzione
  ed entitlement verificati; 536 fotogrammi logici e pixel delle risorse conformi.
- IPA SHA-256: `c02138c11b2290eaf011e42996bdffc59a24a716759f0b6090f7ccc0eec6d434`.
- App Store Connect build ID: `69246f5e-a88a-4746-bdbb-167894595874`.
- Fonte compilata: `/Users/alessandro/Library/Caches/ernie-builds/build-99-20261023-avatar-palettes/source/apps/ios`.
- Nel medesimo percorso cache: manifest, archive, IPA, log e report della verifica.

Nessuna modifica backend. Il commit di aggiornamento della documentazione non
cambia i sorgenti della build; il commit compilato resta quello indicato sopra.

