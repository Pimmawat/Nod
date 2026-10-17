import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getPlayerCandidates, SoundPlayer, supportedSoundExtensions, validateSoundFile } from '../src/sound';

test('custom sounds must be readable local files in a supported format', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-alert-custom-sound-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "my alert '; $(never).WAV");
  await writeFile(file, readFileSync(path.join(process.cwd(), 'assets/alert.wav')));
  for (const platform of ['darwin', 'win32', 'linux'] as const) await validateSoundFile(file, platform);
  const mp3 = path.join(directory, 'clip.mp3');
  await writeFile(mp3, 'Format validation only; decoding belongs to the native player.');
  await validateSoundFile(mp3, 'darwin');
  await assert.rejects(validateSoundFile(mp3, 'win32'), /Supported sound formats: WAV/);
  await assert.rejects(validateSoundFile(mp3, 'linux'), /Supported sound formats: WAV/);
  assert.deepEqual(supportedSoundExtensions('darwin'), ['wav', 'mp3', 'm4a', 'aiff', 'aif']);
  for (const invalid of ['relative.wav', 'https://example.com/sound.wav', 'file:///tmp/sound.wav', `${file}\n`]) {
    await assert.rejects(validateSoundFile(invalid), /local sound file/);
  }
  await assert.rejects(validateSoundFile(path.join(directory, 'script.sh')), /Supported sound formats/);
  await assert.rejects(validateSoundFile(path.join(directory, 'missing.wav')), /missing, empty, or unreadable/);
  const folder = path.join(directory, 'directory.wav');
  await mkdir(folder);
  await assert.rejects(validateSoundFile(folder), /missing, empty, or unreadable/);
  const empty = path.join(directory, 'empty.wav');
  await writeFile(empty, '');
  await assert.rejects(validateSoundFile(empty), /missing, empty, or unreadable/);
});

test('failed custom playback falls back to the bundled sound without using a shell', async (t) => {
  const played: string[] = [];
  const custom = '/fake/custom.wav';
  const fallback = '/fake/default.wav';
  t.mock.method(childProcess, 'spawn', (_command: string, args: string[], options: childProcess.SpawnOptions) => {
    assert.equal(options.shell, false);
    const file = options.env?.AGENT_ALERT_SOUND_FILE ?? args.at(-1)!;
    played.push(file);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', file === fallback ? 0 : 1));
    return child as childProcess.ChildProcess;
  });
  const logs: string[] = [];
  const player = new SoundPlayer(message => logs.push(message));
  assert.equal(await player.play(custom, fallback), true);
  assert.equal(played[0], custom);
  assert.equal(played.at(-1), fallback);
  assert.ok(logs.some(message => message.includes('Using the built-in sound')));
  player.dispose();
});

test('cancelling custom playback never starts the fallback sound', async (t) => {
  const child = Object.assign(new EventEmitter(), { kill: () => true });
  const spawn = t.mock.method(childProcess, 'spawn', () => child as childProcess.ChildProcess);
  const player = new SoundPlayer(() => {});
  const pending = player.play('/fake/custom.wav', '/fake/default.wav');
  player.dispose();
  assert.equal(await pending, false);
  assert.equal(spawn.mock.callCount(), 1);
});

test('macOS passes a filename as one argument', () => {
  const filePath = '/tmp/an alert; $(touch never).wav';
  assert.deepEqual(getPlayerCandidates('darwin', filePath), [
    { command: '/usr/bin/afplay', args: [filePath] },
  ]);
});

test('Windows keeps untrusted filename text out of PowerShell source', () => {
  const filePath = "C:\\sounds\\a'; Write-Output unexpected; # $(never).wav";
  const candidates = getPlayerCandidates('win32', filePath);
  assert.equal(candidates.length, 1);
  const candidate = candidates[0]!;
  assert.equal(candidate.command, 'powershell.exe');
  assert.deepEqual(candidate.env, { AGENT_ALERT_SOUND_FILE: filePath });
  assert.ok(candidate.args.includes('-NonInteractive'));
  assert.ok(candidate.args.includes('-NoProfile'));
  assert.ok(candidate.args.at(-1)!.includes('$env:AGENT_ALERT_SOUND_FILE'));
  assert.ok(candidate.args.every((argument) => !argument.includes(filePath)));
});

test('Linux tries supported native players and terminates option parsing', () => {
  const filePath = '-tricky path; $(never).wav';
  assert.deepEqual(getPlayerCandidates('linux', filePath), [
    { command: 'paplay', args: ['--', filePath] },
    { command: 'aplay', args: ['-q', '--', filePath] },
  ]);
});

test('unsupported platforms have no playback candidate', () => {
  assert.deepEqual(getPlayerCandidates('aix', '/tmp/alert.wav'), []);
});

test('a disposed player does not spawn or play any audio', async () => {
  const logs: string[] = [];
  const player = new SoundPlayer((message) => logs.push(message));
  player.dispose();
  player.dispose();
  assert.equal(await player.play('/does/not/exist.wav'), false);
  assert.deepEqual(logs, []);
});

test('overlapping playback is suppressed and completed playback may restart', async (context) => {
  const children: EventEmitter[] = [];
  const spawn = context.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    children.push(child);
    return child as childProcess.ChildProcess;
  });
  const player = new SoundPlayer(() => {});
  const first = player.play('/fake/alert.wav');
  assert.equal(await player.play('/fake/alert.wav'), false);
  assert.equal(spawn.mock.callCount(), 1);
  children[0]!.emit('close', 0);
  assert.equal(await first, true);
  const next = player.play('/fake/alert.wav');
  assert.equal(spawn.mock.callCount(), 2);
  children[1]!.emit('close', 0);
  assert.equal(await next, true);
  const options = spawn.mock.calls[0]!.arguments[2] as childProcess.SpawnOptions;
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.stdio, 'ignore');
  player.dispose();
});

test('disposing cancels active playback and kills its process', async (context) => {
  let killed = false;
  const child = Object.assign(new EventEmitter(), {
    kill(signal: string) {
      assert.equal(signal, 'SIGKILL');
      killed = true;
      return true;
    },
  });
  context.mock.method(childProcess, 'spawn', () => child as childProcess.ChildProcess);
  const player = new SoundPlayer(() => {});
  const pending = player.play('/fake/alert.wav');
  player.dispose();
  assert.equal(await pending, false);
  assert.equal(killed, true);
  // A delayed child-process exit must not change the settled result.
  child.emit('close', 0);
  assert.equal(await player.play('/fake/alert.wav'), false);
});

test('missing native players return false and explain the failure', async (context) => {
  context.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })));
    return child as childProcess.ChildProcess;
  });
  const logs: string[] = [];
  const player = new SoundPlayer((message) => logs.push(message));
  assert.equal(await player.play('/fake/alert.wav'), false);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /Could not play/);
  player.dispose();
});

test('bundled chime is a short non-silent 16-bit mono PCM WAV', () => {
  const data = readFileSync(path.join(process.cwd(), 'assets', 'alert.wav'));
  assert.equal(data.toString('ascii', 0, 4), 'RIFF');
  assert.equal(data.readUInt32LE(4), data.length - 8);
  assert.equal(data.toString('ascii', 8, 12), 'WAVE');
  assert.equal(data.toString('ascii', 12, 16), 'fmt ');
  assert.equal(data.readUInt16LE(20), 1);
  assert.equal(data.readUInt16LE(22), 1);
  assert.equal(data.readUInt32LE(24), 44_100);
  assert.equal(data.readUInt16LE(34), 16);
  assert.equal(data.toString('ascii', 36, 40), 'data');
  assert.equal(data.readUInt32LE(40), data.length - 44);
  const duration = (data.length - 44) / data.readUInt32LE(28);
  assert.ok(duration >= 0.5 && duration <= 1);
  let peak = 0;
  for (let offset = 44; offset < data.length; offset += 2) {
    peak = Math.max(peak, Math.abs(data.readInt16LE(offset)));
  }
  assert.ok(peak > 1000 && peak < 32767);
  assert.equal(data.readInt16LE(44), 0);
  assert.equal(data.readInt16LE(data.length - 2), 0);
});
