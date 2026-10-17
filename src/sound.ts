import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';

export function supportedSoundExtensions(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'darwin' ? ['wav', 'mp3', 'm4a', 'aiff', 'aif'] : ['wav'];
}

/** Check local files only; playback never fetches URLs or executes file contents. */
export async function validateSoundFile(filePath: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (!isAbsolute(filePath) || /[\u0000-\u001f\u007f]/u.test(filePath)) {
    throw new Error('Choose a local sound file using an absolute path.');
  }
  const extensions = supportedSoundExtensions(platform);
  if (!extensions.includes(extname(filePath).slice(1).toLowerCase())) {
    throw new Error(`Supported sound formats: ${extensions.map((value) => value.toUpperCase()).join(', ')}.`);
  }
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size === 0) throw new Error('Not a nonempty file.');
    await access(filePath, constants.R_OK);
  } catch {
    throw new Error('The sound file is missing, empty, or unreadable. Choose another file.');
  }
}

export interface PlayerCandidate {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

const WINDOWS_SOUND_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  '$player = New-Object System.Media.SoundPlayer',
  '$player.SoundLocation = $env:AGENT_ALERT_SOUND_FILE',
  'try { $player.Load(); $player.PlaySync() } finally { $player.Dispose() }',
].join('; ');

/** No filename is ever interpolated into shell or PowerShell source code. */
export function getPlayerCandidates(
  platform: NodeJS.Platform,
  filePath: string,
): readonly PlayerCandidate[] {
  switch (platform) {
    case 'darwin':
      return [{ command: '/usr/bin/afplay', args: [filePath] }];
    case 'win32':
      return [{
        command: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SOUND_COMMAND],
        env: { AGENT_ALERT_SOUND_FILE: filePath },
      }];
    case 'linux':
      return [
        { command: 'paplay', args: ['--', filePath] },
        { command: 'aplay', args: ['-q', '--', filePath] },
      ];
    default:
      return [];
  }
}

type PlaybackResult = 'played' | 'failed' | 'cancelled' | 'timedOut';

export class SoundPlayer {
  private playing = false;
  private disposed = false;
  private child: ChildProcess | undefined;
  private cancelPlayback: (() => void) | undefined;

  constructor(private readonly log: (message: string) => void) {}

  async play(filePath: string, fallbackPath?: string): Promise<boolean> {
    if (this.disposed || this.playing) {
      return false;
    }

    const candidates = getPlayerCandidates(process.platform, filePath);
    if (candidates.length === 0) {
      this.log(`Alert sound is unavailable on ${process.platform}.`);
      return false;
    }

    this.playing = true;
    const deadline = Date.now() + 5_000;
    try {
      const paths = fallbackPath && fallbackPath !== filePath ? [filePath, fallbackPath] : [filePath];
      for (const currentPath of paths) {
        if (currentPath !== filePath) this.log('Could not play the custom alert sound. Using the built-in sound.');
        for (const candidate of getPlayerCandidates(process.platform, currentPath)) {
          if (this.disposed) {
            return false;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            this.log('Alert sound stopped after the 5 second playback limit.');
            return false;
          }
          const result = await this.playCandidate(candidate, remaining);
          if (result === 'played') {
            return true;
          }
          if (result === 'cancelled') {
            return false;
          }
          if (result === 'timedOut') {
            this.log('Alert sound stopped after the 5 second playback limit.');
            return false;
          }
        }
      }
      this.log(process.platform === 'linux'
        ? 'Could not play the alert sound. Install paplay (PulseAudio utilities) or aplay (ALSA utilities), and check your audio output.'
        : 'Could not play the alert sound. Check that the sound file and system audio output are available.');
      return false;
    } finally {
      this.playing = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPlayback?.();
  }

  private playCandidate(candidate: PlayerCandidate, timeoutMs: number): Promise<PlaybackResult> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let child: ChildProcess;

      const finish = (result: PlaybackResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (this.child === child) {
          this.child = undefined;
          this.cancelPlayback = undefined;
        }
        resolve(result);
      };

      try {
        child = spawn(candidate.command, [...candidate.args], {
          env: { ...process.env, ...candidate.env },
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        finish('failed');
        return;
      }

      this.child = child;
      this.cancelPlayback = () => {
        child.kill('SIGKILL');
        finish('cancelled');
      };
      child.once('error', () => finish('failed'));
      child.once('close', (code) => finish(code === 0 ? 'played' : 'failed'));
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish('timedOut');
      }, timeoutMs);
    });
  }
}
