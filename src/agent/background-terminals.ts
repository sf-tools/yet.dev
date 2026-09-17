import { spawn as spawnPty } from '@lydell/node-pty';
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { constants } from 'node:os';
import { resolve } from 'node:path';

import { USER_SHELL } from '@/config';
import { isWithinWorkspace } from '@/permissions';
import { prepareSandboxCommand, type SandboxMode } from '@/sandbox';
import { normalizePtyOutput } from '@/text';

const DEFAULT_YIELD_TIME_MS = 10_000;
const MIN_YIELD_TIME_MS = 250;
const MAX_YIELD_TIME_MS = 30_000;
const DEFAULT_POLL_TIME_MS = 5_000;
const MAX_POLL_TIME_MS = 300_000;
const MAX_CAPTURE_CHARS = 2_000_000;
const DEFAULT_OUTPUT_TOKENS = 10_000;

export type BackgroundTerminalExecOptions = {
  workspaceRoot: string;
  cwd?: string;
  sandboxMode: SandboxMode;
  writableRoots?: string[];
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  tty?: boolean;
};

export type BackgroundTerminalResult = {
  output: string;
  wallTimeSeconds: number;
  exitCode?: number;
  sessionId?: number;
  originalTokenCount?: number;
};

export type BackgroundTerminalSummary = {
  sessionId: number;
  command: string;
  recentChunks: string[];
};

type TerminalEntry = {
  sessionId: number;
  command: string;
  startedAt: number;
  output: string;
  readOffset: number;
  exitCode?: number;
  process: { write(data: string): void; kill(): void };
  waiters: Set<() => void>;
};

function clamp(value: number | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function outputBudget(maxOutputTokens?: number) {
  return Math.max(1_000, Math.min(maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS, 50_000)) * 4;
}

function boundedOutput(raw: string, maxOutputTokens?: number) {
  const normalized = normalizePtyOutput(raw);
  const budget = outputBudget(maxOutputTokens);
  const originalTokenCount = Math.ceil(normalized.length / 4);
  if (normalized.length <= budget) return { output: normalized, originalTokenCount };

  const headSize = Math.floor(budget * 0.4);
  const tailSize = Math.max(0, budget - headSize);
  return {
    output: `${normalized.slice(0, headSize)}\n… output truncated …\n${normalized.slice(-tailSize)}`,
    originalTokenCount,
  };
}

function recentOutputLines(output: string) {
  return normalizePtyOutput(output)
    .split('\n')
    .filter(line => line.length > 0)
    .slice(-2);
}

export class BackgroundTerminalManager {
  private readonly processes = new Map<number, TerminalEntry>();
  private nextSessionId = 1;

  constructor(private readonly onChange: () => void = () => {}) {}

  private notifyWaiters(entry: TerminalEntry) {
    for (const resolveWaiter of entry.waiters) resolveWaiter();
    entry.waiters.clear();
  }

  private wait(entry: TerminalEntry, timeoutMs: number) {
    if (entry.exitCode !== undefined) return Promise.resolve();

    return new Promise<void>(resolveWait => {
      const finish = () => {
        clearTimeout(timer);
        entry.waiters.delete(finish);
        resolveWait();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      entry.waiters.add(finish);
    });
  }

  private result(
    entry: TerminalEntry,
    rawOutput: string,
    maxOutputTokens?: number,
  ): BackgroundTerminalResult {
    const bounded = boundedOutput(rawOutput, maxOutputTokens);
    return {
      output: bounded.output,
      wallTimeSeconds: (Date.now() - entry.startedAt) / 1_000,
      ...(entry.exitCode === undefined
        ? { sessionId: entry.sessionId }
        : { exitCode: entry.exitCode }),
      ...(bounded.originalTokenCount > (maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS)
        ? { originalTokenCount: bounded.originalTokenCount }
        : {}),
    };
  }

  commandFor(sessionId: number) {
    return this.processes.get(sessionId)?.command;
  }

  async exec(
    command: string,
    options: BackgroundTerminalExecOptions,
  ): Promise<BackgroundTerminalResult> {
    const workspaceRoot = await realpath(resolve(options.workspaceRoot));
    const cwd = await realpath(resolve(options.cwd ?? workspaceRoot));
    const writableRoots = await Promise.all(
      (options.writableRoots ?? []).map(root => realpath(resolve(root))),
    );
    const allowedWorkingRoots = [workspaceRoot, ...writableRoots];
    if (
      options.sandboxMode !== 'danger-full-access' &&
      !allowedWorkingRoots.some(root => isWithinWorkspace(cwd, root))
    ) {
      throw new Error('sandboxed commands must start inside an allowed workspace root');
    }

    const prepared = await prepareSandboxCommand({
      mode: options.sandboxMode,
      workspaceRoot,
      cwd,
      shell: USER_SHELL,
      command,
      writableRoots,
    });
    const sessionId = this.nextSessionId++;
    const env = {
      ...prepared.env,
      NO_COLOR: '1',
      TERM: 'dumb',
      LANG: 'C.UTF-8',
      LC_CTYPE: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      COLORTERM: '',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      GH_PAGER: 'cat',
      CODEX_CI: '1',
    };
    const terminal = options.tty ? spawnPty(prepared.executable, prepared.args, {
      name: env.TERM,
      cols: Math.max(20, Math.floor((process.stdout.columns || 120) / 1.5)),
      rows: Math.max(10, Math.floor((process.stdout.rows || 30) / 1.5)),
      cwd,
      env,
    }) : null;
    const child = terminal ? null : spawn(prepared.executable, prepared.args, {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    const entry: TerminalEntry = {
      sessionId,
      command,
      startedAt: Date.now(),
      output: '',
      readOffset: 0,
      process: terminal ?? {
        write() {
          throw new Error('stdin is closed for this session; rerun exec_command with tty=true to keep stdin open');
        },
        kill() {
          try {
            if (process.platform !== 'win32' && child!.pid) process.kill(-child!.pid, 'SIGKILL');
            else child!.kill('SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        },
      },
      waiters: new Set(),
    };
    this.processes.set(sessionId, entry);
    this.onChange();

    const onData = (data: string) => {
      entry.output += data;
      if (entry.output.length > MAX_CAPTURE_CHARS) {
        const removed = entry.output.length - MAX_CAPTURE_CHARS;
        entry.output = entry.output.slice(removed);
        entry.readOffset = Math.max(0, entry.readOffset - removed);
      }
    };
    const onExit = (exitCode: number, signal?: number) => {
      entry.exitCode = signal !== undefined && signal !== 0 ? 128 + signal : exitCode;
      if (signal !== undefined && signal !== 0)
        entry.output += `\nprocess exited with signal ${signal}`;
      this.notifyWaiters(entry);
      this.onChange();
    };
    if (terminal) {
      const dataDisposable = terminal.onData(onData);
      const exitDisposable = terminal.onExit(({ exitCode, signal }) => {
        dataDisposable.dispose();
        exitDisposable.dispose();
        onExit(exitCode, signal);
      });
    } else if (child) {
      // Like Codex, read both pipes and display their chunks in arrival order.
      child.stdout.setEncoding('utf8').on('data', onData);
      child.stderr.setEncoding('utf8').on('data', onData);
      child.once('error', error => {
        onData(error.message);
        onExit(1);
      });
      // close follows pipe EOF, so the final result includes trailing output.
      child.once('close', (code, signal) => {
        if (entry.exitCode === undefined) onExit(code ?? 1, signal ? constants.signals[signal] : undefined);
      });
    }

    const yieldTimeMs = clamp(
      options.yieldTimeMs,
      DEFAULT_YIELD_TIME_MS,
      MIN_YIELD_TIME_MS,
      MAX_YIELD_TIME_MS,
    );
    await this.wait(entry, yieldTimeMs);
    entry.readOffset = entry.output.length;
    const result = this.result(entry, entry.output, options.maxOutputTokens);
    if (entry.exitCode !== undefined) this.processes.delete(sessionId);
    return result;
  }

  async write(
    sessionId: number,
    chars = '',
    options: { yieldTimeMs?: number; maxOutputTokens?: number } = {},
  ): Promise<BackgroundTerminalResult> {
    const entry = this.processes.get(sessionId);
    if (!entry) throw new Error(`unknown background terminal session ${sessionId}`);

    if (chars) entry.process.write(chars);
    const yieldTimeMs = chars
      ? clamp(options.yieldTimeMs, MIN_YIELD_TIME_MS, MIN_YIELD_TIME_MS, MAX_YIELD_TIME_MS)
      : clamp(options.yieldTimeMs, DEFAULT_POLL_TIME_MS, DEFAULT_POLL_TIME_MS, MAX_POLL_TIME_MS);
    await this.wait(entry, yieldTimeMs);

    const unread = entry.output.slice(entry.readOffset);
    entry.readOffset = entry.output.length;
    const result = this.result(entry, unread, options.maxOutputTokens);
    if (entry.exitCode !== undefined) this.processes.delete(sessionId);
    return result;
  }

  list(): BackgroundTerminalSummary[] {
    return [...this.processes.values()]
      .filter(entry => entry.exitCode === undefined)
      .map(entry => ({
        sessionId: entry.sessionId,
        command: entry.command,
        recentChunks: recentOutputLines(entry.output),
      }));
  }

  stopAll() {
    const running = [...this.processes.values()].filter(entry => entry.exitCode === undefined);
    for (const entry of running) entry.process.kill();
    return running.length;
  }
}
