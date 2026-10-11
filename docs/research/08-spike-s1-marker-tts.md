# Spike S1 — Marker della sintesi vocale con voci italiane (11 ottobre 2026)

Domanda (ARCHITECTURE.md §13, B.11): quali marker produce `AVSpeechSynthesizer` con le voci italiane, per pilotare il lip-sync dell'avatar (M10)? Due vie: `write(_:toBufferCallback:toMarkerCallback:)` (PCM + marker offline) oppure `speak()` con i callback del delegato in tempo reale.

## Metodo

- Script riproducibile `tests/spikes/tts-markers.swift` (macOS, stesso motore di sintesi): per ogni voce `it-*` installata, `write()` con callback dei marker, poi `speak()` a volume zero con delegato (`willSpeakRangeOfSpeechString`, `willSpeak(marker:)`).
- Lo stesso probe gira nell'app iOS (Impostazioni → Diagnostica → «Spike S1»), con le voci installate sul dispositivo, incluse enhanced/premium se scaricate.

## Risultato su macOS 26 (proxy; Xcode 27, 9 voci italiane installate, tutte di qualità `default`)

| Voce | `write()` marker | Audio | `speak()` callback di parola | marker dal delegato | primo callback |
|---|---|---|---|---|---|
| compact.it-IT.Alice | **nessuno** | 5,5 s @ 22 050 Hz | **15** (una per parola) | `word` = 15 | 1,18 s dall'avvio |
| eloquence.it-IT.Eddy, Flo, Grandma, Grandpa, Reed, Rocko, Sandy, Shelley | **nessuno** | 6,3 s @ 16 000 Hz | non provate con `speak()` | — | — |

Osservazioni:
- `write()` restituisce i buffer PCM ma **nessun marker** (né parola, né frase, né fonema) con tutte le voci italiane provate.
- `speak()` consegna i **callback di parola** in tempo reale, sia tramite `willSpeakRangeOfSpeechString` sia tramite `willSpeak(marker:)` con `mark = .word`; **nessun marker fonemico**.
- La sintesi è molto più veloce del tempo reale (0,05–0,5 s per 6 s di audio).

## Conseguenze per la M10

1. Il lip-sync non può basarsi sui marker offline di `write()`: la pipeline va impostata sulla **variante B** (audio riprodotto da `AVSpeechSynthesizer`, avatar pilotato dai callback di parola in tempo reale), oppure su `write()` per l'audio **più** una stima dei tempi di parola ottenuta da una seconda passata con `speak()` a volume zero (costosa e fragile: da evitare).
2. Senza marker fonemici, il modulo italiano `lipsync-it.mjs` (G2P a regole) resta necessario: converte ogni parola in visemi e ne distribuisce la durata fra il callback corrente e il successivo.
3. Il ritardo del primo callback (≈ 1,2 s con la voce compact, misurato su Mac) entra nella latenza udibile: l'avatar deve iniziare l'animazione "parlo" al `didStart` e non al primo callback.
4. Da verificare sul dispositivo con le voci enhanced/premium (Alice/Federica/Luca enhanced) tramite il probe nell'app: se una voce producesse marker da `write()`, la variante A tornerebbe possibile.

## Risultato su iOS 26.5 (simulatore iPhone 17, probe nell'app, 11 ottobre 2026)

| Voce | `write()` marker | Audio | `speak()` callback di parola | marker dal delegato | primo callback |
|---|---|---|---|---|---|
| Alice (default, unica voce italiana del simulatore) | **nessuno** | 4,8 s | **14** | `word` = 14 | **0,16 s** |

Conferma il quadro di macOS: nessun marker da `write()`, callback di parola in tempo reale da `speak()`, nessun fonema. Il primo callback arriva molto prima che su Mac (0,16 s contro 1,18 s). Resta da ripetere su iPhone fisico con le voci enhanced/premium scaricate (Impostazioni → Diagnostica → «Esegui con le voci italiane installate»).

Stato: **misurato su macOS e nel simulatore iOS 26.5**; da ripetere su iPhone con voci di qualità superiore.
