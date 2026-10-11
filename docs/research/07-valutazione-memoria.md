# Valutazione del recupero della memoria

Eseguita il 2026-10-11 su 30 fatti e 24 domande (`tests/eval/memory-recall.json`), embedder `text-embedding-3-small` (1536 dim), full-text `italian`, fusione RRF k=60 (peso testo 0.3, vettori 1), 20 candidati per gamba.

| Modalità | recall@1 | recall@3 | recall@5 | MRR |
|---|---|---|---|---|
| fts | 41.7% | 66.7% | 72.9% | 0.549 |
| vector | 85.4% | 93.7% | 95.8% | 0.913 |
| hybrid | 81.2% | 89.6% | 93.7% | 0.882 |

Domande in cui l'ibrido non porta un fatto atteso nei primi 3:
- "che animale ho in casa?" → attesi f24, primi 3: f19,f2,f8
- "spezie che non sopporto" → attesi f21, primi 3: f3,f30,f17

Nota: corpus piccolo scritto da chi progetta il sistema; da ampliare con fatti reali consolidati (M9).
