#!/usr/bin/env node
'use strict';

// Original two-note chime synthesized from sine waves; no external audio assets.
const fs = require('node:fs');
const path = require('node:path');

const sampleRate = 44_100;
const duration = 0.72;
const samples = Math.round(sampleRate * duration);
const audio = Buffer.alloc(44 + samples * 2);
audio.write('RIFF', 0);
audio.writeUInt32LE(audio.length - 8, 4);
audio.write('WAVE', 8);
audio.write('fmt ', 12);
audio.writeUInt32LE(16, 16);
audio.writeUInt16LE(1, 20); // PCM
audio.writeUInt16LE(1, 22); // mono
audio.writeUInt32LE(sampleRate, 24);
audio.writeUInt32LE(sampleRate * 2, 28);
audio.writeUInt16LE(2, 32);
audio.writeUInt16LE(16, 34);
audio.write('data', 36);
audio.writeUInt32LE(samples * 2, 40);

function note(time, start, frequency) {
  const elapsed = time - start;
  if (elapsed < 0 || elapsed > 0.48) return 0;
  const attack = Math.min(1, elapsed / 0.016);
  const release = Math.min(1, (0.48 - elapsed) / 0.08);
  const envelope = attack * release * Math.exp(-elapsed * 6);
  const fundamental = Math.sin(2 * Math.PI * frequency * elapsed);
  const overtone = 0.16 * Math.sin(2 * Math.PI * frequency * 2 * elapsed);
  return envelope * (fundamental + overtone);
}

for (let i = 0; i < samples; i++) {
  const time = i / sampleRate;
  const value = 0.24 * (note(time, 0, 659.255) + note(time, 0.2, 880));
  audio.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2);
}

const output = path.join(__dirname, '..', 'assets', 'alert.wav');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, audio);
console.log(`Generated ${output} (${duration} s, mono 16-bit PCM).`);
