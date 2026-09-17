import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import bloom from './assets/bloom.wav';
import success from './assets/success.wav';
import error from './assets/error.wav';
import chime from './assets/chime.wav';
import scan from './assets/scan.wav';

const sounds = { bloom, success, error, chime, scan };
export type SoundName = keyof typeof sounds;
const files = new Map<SoundName, Promise<string>>();

function soundFile(name: SoundName) {
  let pending = files.get(name);
  if (!pending) {
    pending = (async () => {
      const directory = join(homedir(), '.yet', 'sounds', 'cuelume-0.2.2');
      await mkdir(directory, { recursive: true });
      const file = join(directory, `${name}.wav`);
      await writeFile(file, Buffer.from(sounds[name], 'base64'), { flag: 'wx' }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      return file;
    })();
    files.set(name, pending);
  }
  return pending;
}

function playFile(file: string) {
  const players: Array<[string, string[]]> = process.platform === 'darwin'
    ? [['afplay', [file]]]
    : process.platform === 'win32'
      ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          '& { param($file) (New-Object System.Media.SoundPlayer $file).PlaySync() }', file]]]
      : [['pw-play', [file]], ['paplay', [file]], ['aplay', ['-q', file]]];
  const attempt = (index: number) => {
    const player = players[index];
    if (!player) return;
    try {
      const child = spawn(player[0], player[1], { stdio: 'ignore', detached: true, windowsHide: true });
      child.once('error', () => attempt(index + 1));
      child.unref();
    } catch {
      attempt(index + 1);
    }
  };
  attempt(0);
}

export function playSound(name: SoundName) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  void soundFile(name).then(playFile).catch(() => {});
}
