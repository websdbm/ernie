# Suoni UI di Ernie (build 107)

Set originale sintetizzato dal progetto, senza campioni vocali/animali o asset esterni.
Rigenerazione riproducibile con Python standard library:

```
python3 apps/ios/scripts/generate-ernie-sounds.py
```

PCM WAV mono, 44.1 kHz, 16 bit, picco 0.72, durata 160–360 ms, totale circa 150 kB.
La zampa è un attacco percussivo basso; il brum combina armoniche, rumore filtrato e modulazione ruvida.
I piccoli accenti triangolari richiamano la pixel art, senza loop durante il pensiero.

| File | Azione |
|---|---|
| send | Invio accettato dalla chat (solo testo) |
| done | Turno corrente completato senza parlato |
| ask | Richiesta di conferma del turno corrente |
| approve | Approvazione esplicita o modifica lista confermata dal server |
| cancel | Rifiuto esplicito, riapertura spunta o rimozione dalla spesa |
| check | Completamento voce Spesa/Todo confermato dal server |
| error | Errore definitivo del turno corrente o scrittura lista fallita |

Preferenze locali: `ernie.sounds.enabled` (default true), `ernie.sounds.volume` (default 0.55).
Una sola riproduzione alla volta, cooldown 120 ms, deduplica degli ultimi 256 eventi con id.
Nessun effetto da replay dello storico o ripresa in background; niente code di suoni.
Categoria AVAudioSession `ambient`/`mixWithOthers`: rispetta silenzioso e non abbassa musica/podcast.
Microfono e TTS fermano il player prima di prendere possesso della sessione; nessun cambio route.
Le sveglie e le notifiche mantengono il loro comportamento esistente.
