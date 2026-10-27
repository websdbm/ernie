#!/usr/bin/env python3
"""Ernie UI: effetti originali, deterministici, PCM mono 44.1 kHz/16 bit. Nessuna dipendenza."""
import argparse
import array
import math
from pathlib import Path
import random
import sys
import wave

RATE = 44100
SOUNDS = {'send': .17, 'done': .36, 'ask': .29, 'approve': .23, 'cancel': .17, 'check': .16, 'error': .34}

def pulse(t, start, duration, frequency, level=.2):
    x = t - start
    if not 0 <= x < duration:
        return 0.
    envelope = math.sin(math.pi * x / duration) ** 1.4
    triangle = 2 / math.pi * math.asin(math.sin(2 * math.pi * frequency * x))
    return level * envelope * triangle

def render(name, duration, index):
    rng = random.Random(107 + index)
    samples = []
    rumble = 0.
    phase = 0.
    for i in range(round(duration * RATE)):
        t = i / RATE
        x = t / duration
        noise = rng.uniform(-1, 1)
        rumble = .965 * rumble + .035 * noise
        envelope = math.sin(math.pi * x) ** 1.35
        base = {'send': 115, 'done': 103, 'ask': 116, 'approve': 134, 'cancel': 112, 'check': 150, 'error': 100}[name]
        sweep = {'send': -22, 'done': 26, 'ask': 45, 'approve': 12, 'cancel': -38, 'check': 30, 'error': -31}[name]
        phase += 2 * math.pi * (base + sweep * x + 3 * math.sin(2 * math.pi * 29 * t)) / RATE
        # Timbro basso, armoniche del muso e soffio ruvido; niente registrazioni di animali o voci.
        voiced = sum(math.sin(k * phase) * math.exp(-k / 7) / k for k in range(1, 12))
        breath = noise * (.06 if name == 'error' else .025) + rumble * .8
        rasp = (.82 + .18 * math.sin(2 * math.pi * 47 * t))
        y = .46 * envelope * (voiced * rasp + breath)
        # Attacchi di zampa più leggibili e piccoli accenti retro, senza toni acuti insistenti.
        if name in ('send', 'approve', 'check', 'cancel'):
            y += .24 * math.exp(-t * 65) * math.sin(2 * math.pi * 225 * t)
            y += .08 * noise * math.exp(-t * 95)
        if name == 'done':
            y += pulse(t, .13, .09, 392) + pulse(t, .23, .10, 523)
        elif name == 'ask':
            y += pulse(t, .16, .10, 440, .13)
        elif name == 'approve':
            y += pulse(t, .02, .07, 330, .14) + pulse(t, .11, .08, 440, .14)
        elif name == 'check':
            y += pulse(t, .025, .10, 587, .20)
        elif name == 'cancel':
            y += pulse(t, .02, .12, 262, .10)
        elif name == 'error':
            y += pulse(t, .03, .10, 247, .13) + pulse(t, .16, .11, 196, .13)
        y *= min(1., t / .006, (duration - t) / .012)
        samples.append(y)
    mean = sum(samples) / len(samples)
    samples = [s - mean for s in samples]
    peak = max(abs(s) for s in samples)
    return [s / peak * .72 for s in samples]

def write(path, samples):
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = array.array('h', [round(max(-1, min(1, v)) * 32767) for v in samples])
    if sys.byteorder != 'little':
        pcm.byteswap()
    with wave.open(str(path), 'wb') as out:
        out.setnchannels(1); out.setsampwidth(2); out.setframerate(RATE); out.writeframes(pcm.tobytes())

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--demo', type=Path)
    args = parser.parse_args()
    target = Path(__file__).resolve().parents[1] / 'Ernie/Resources/Sounds'
    demo = [0.] * round(.25 * RATE)
    for index, (name, duration) in enumerate(SOUNDS.items()):
        sound = render(name, duration, index)
        write(target / f'ernie-ui-{name}.wav', sound)
        demo += [s * .7 for s in sound] + [0.] * round(.45 * RATE)
    if args.demo:
        write(args.demo, demo)
    print('Generati', len(SOUNDS), 'effetti originali in', target)

if __name__ == '__main__':
    main()
