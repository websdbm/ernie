# Build 103 — Diario personale

24 ottobre 2026. Implementazione e verifiche completate; distribuzione da verificare.

## Contenuto

Diario locale cifrato, accesso biometrico separato, originali e bozze con data/ora,
versioni riordinate e punti chiave, riepiloghi per periodo con consenso per ogni
invio AI. Copia cifrata recuperabile con password. Ingresso da Area privata,
menu Second Brain e comando locale «Apri diario»; nessun indice nella memoria
ordinaria. Contratto e confini in [Diario personale](../research/19-private-diary.md).

## Verifiche prima del rilascio

- Test API/catalogo/server: 27/27; TypeScript API e skills compilati.
- Test nativi: 16/16 in quattro suite; crittografia, backup, consenso, comandi locali, lock/cancellazione,
  overflow e fallimento scrittura; regressione avvio locale ErnieTRIX.
- UI nativa: cancello chiaro/scuro, pagina originale e comparsa della richiesta
  di consenso senza inviare testo. Anteprime ispezionate sul simulatore.
- Review privacy indipendente: mitigati overflow e avvisi di mancato salvataggio;
  documentato che la dettatura privata va avviata dentro il diario sbloccato.
- Face ID e Data Protection su iPhone fisico non verificati. Le prove dello
  store usano key access simulato, senza bypass biometrici nella build distribuita.
- Main app con access group dedicato; le tre estensioni mantengono soltanto il
  precedente gruppo condiviso. Tutti e quattro i target alla build 103.

## Deployment e tracciabilità

Il backend richiede il nuovo endpoint `private-diary` e il catalogo aggiornato;
non sono previste migrazioni o copie di diari sul server. La distribuzione iOS
va compilata dal commit pubblicato su GitHub. SHA, manifest, verifica delle firme,
deployment backend e stato TestFlight saranno registrati a conclusione.
