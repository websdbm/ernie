# Calibrazione del router Jev

Eseguita il 2026-10-11 su 60 esempi etichettati (`tests/eval/router-labeled.json`), modello `typesafe/jev-1.13-20260917`. Costo totale 0.00230 USD; latenza p50 256 ms, p95 336 ms.

| Domanda | Soglia migliore | Accuratezza bilanciata | A 0,5 |
|---|---|---|---|
| deep_reasoning | 0.35 | 94.1% | 91.5% |
| needs_memory | 0.75 | 91.0% | 88.2% |
| risk | 0.6 | 91.3% | 87.3% |

Accuratezza di `route` (scelta grezza): 88.3%. Accuratezza di `model_class` (heavy vs standard): 96.7%.

Matrice di confusione di `route` (riga = etichetta, colonna = scelta Jev):

- deterministic: deterministic=5
- skill: skill=10
- llm: llm=38, skill=6, deterministic=1

Esempi sbagliati su route:
- "quali sono le mie abitudini di spesa?" → atteso llm, Jev skill (conf 0.31)
- "cosa compro più spesso?" → atteso llm, Jev skill (conf 0.58)
- "cancella tutti gli appuntamenti di domani" → atteso llm, Jev skill (conf 0.23)
- "cosa ho in agenda domani?" → atteso llm, Jev skill (conf 0.38)
- "ricordati che sono allergico alle noci" → atteso llm, Jev skill (conf 0.28)
- "da oggi chiamami Ale" → atteso llm, Jev deterministic (conf 0.37)
- "quanto ho speso in spesa questo mese?" → atteso llm, Jev skill (conf 0.56)

Nota: il set è piccolo e scritto da chi progetta il sistema; le soglie vanno riviste con esempi reali raccolti da `router_decisions` (M9).
