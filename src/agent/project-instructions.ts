import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const INSTRUCTION_FILES = ['AGENTS.override.md', 'AGENTS.md'];
export const PROJECT_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

async function exists(path: string) {
  try { await stat(path); return true; } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

async function projectDirectories(cwd: string) {
  const directories: string[] = [];
  for (let current = cwd; ; current = dirname(current)) {
    directories.push(current);
    // .git may be a directory or a worktree's pointer file.
    if (await exists(join(current, '.git'))) return directories.reverse();
    if (dirname(current) === current) return [cwd];
  }
}

async function readInstructions(directory: string, remaining: number) {
  for (const name of INSTRUCTION_FILES) {
    const path = join(directory, name);
    let file;
    try {
      if (!(await stat(path)).isFile()) continue;
      file = await open(path, 'r');
      const buffer = Buffer.alloc(remaining + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const truncated = bytesRead > remaining;
      let end = Math.min(bytesRead, remaining);
      if (truncated) while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
      const text = buffer.subarray(0, end).toString('utf8').trim();
      if (text) return { path, text, bytes: end, truncated };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    } finally {
      await file?.close();
    }
  }
  return null;
}

export async function loadProjectInstructions(options: {
  cwd?: string;
  yetHome?: string;
  maxBytes?: number;
} = {}) {
  const cwd = await realpath(resolve(options.cwd ?? process.cwd()));
  const maxBytes = Math.max(0, Math.floor(options.maxBytes ?? PROJECT_INSTRUCTIONS_MAX_BYTES));
  const globalDirectory = resolve(options.yetHome ?? join(homedir(), '.yet'));
  const directories = [globalDirectory, ...await projectDirectories(cwd)];
  const files: string[] = [];
  const sections: string[] = [];
  let remaining = maxBytes;
  let truncated = false;
  for (const directory of new Set(directories)) {
    if (remaining <= 0) { truncated = true; break; }
    const instructions = await readInstructions(directory, remaining);
    if (!instructions) continue;
    files.push(instructions.path);
    const scope = directory === globalDirectory ? 'all workspaces' : `${directory} and its descendants`;
    sections.push(`## ${instructions.path}\n\nScope: ${scope}.\n\n${instructions.text}`);
    remaining -= instructions.bytes;
    if (instructions.truncated) { truncated = true; break; }
  }
  return {
    files,
    truncated,
    text: sections.length > 0
      ? `# AGENTS.md instructions for ${cwd}\n\nThese user-provided instructions are ordered from broader to more specific scope. More specific instructions override broader ones within their directory trees.\n\n${sections.join('\n\n')}${truncated ? `\n\n[Instruction loading reached its ${maxBytes}-byte limit.]` : ''}`
      : '',
  };
}
