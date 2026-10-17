import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/** Resolve Node once in the IDE, rather than relying on an agent's different PATH. */
export function findNode(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('node', ['-p', 'JSON.stringify({path:process.execPath,major:Number(process.versions.node.split(".")[0])})'],
      { timeout: 5000, maxBuffer: 4096, windowsHide: true }, (error, stdout) => {
        try {
          if (error) throw error;
          const value = JSON.parse(stdout) as { path: string; major: number };
          if (!isAbsolute(value.path) || !Number.isInteger(value.major) || value.major < 18) throw new Error('Unsupported Node.js.');
          resolve(value.path);
        } catch {
          reject(new Error('Nod needs Node.js 18+ on the IDE PATH. Install Node.js, restart the IDE, then run Set Up Chat Hooks.'));
        }
      });
  });
}

/** A stable path keeps hook commands valid when VSIX version directories change. */
export async function prepareHookRuntime(extensionDirectory: string, storageDirectory: string): Promise<string> {
  const directory = join(storageDirectory, 'hook-runtime');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of ['events.js', 'hook-client.js']) {
    const source = await fs.readFile(join(extensionDirectory, 'out', 'src', name));
    const file = join(directory, name);
    const previous = await fs.readFile(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (previous?.equals(source)) continue;
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, source, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch(() => undefined); }
  }
  return join(directory, 'hook-client.js');
}
