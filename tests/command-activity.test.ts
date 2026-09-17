import chalk from 'chalk';
import { isDeepStrictEqual } from 'node:util';
import { parseCommand } from '@/agent/parse-command';
import { highlightShell } from '@/render/shell-highlight';
import { renderCommandActivity } from '@/render/components/tools/command-activity';
import { AgentApp } from '@/agent/app';
import { createAgentStore } from '@/store';
import { createRenderContext, serializeBlock } from '@/render';
import { createTheme } from '@/theme';
import { stripAnsi, widthOf } from '@/text';
import type { ToolHistoryEntry } from '@/types';
import parsing from './fixtures/codex-command-parsing';
import colors from './fixtures/codex-command-colors';
import { check, deepEqual, equal } from './harness';

for (const fixture of parsing) {
  const actual = parseCommand(fixture.command);
  check(isDeepStrictEqual(actual, fixture.parsed), `Codex parsing: ${fixture.command}`, JSON.stringify(actual));
}

const ctx = createRenderContext(createTheme(), false, 120, 30);
const oldLevel = chalk.level;
chalk.level = 3;
try {
  for (const fixture of colors) {
    const expected = fixture.lines.map(parts => parts.flatMap(part => [...part.text.replace(/\n$/, '')].map(text => ({ text, color: part.color }))));
    const actual = highlightShell(fixture.command, ctx).map(entry => entry.segments.flatMap(segment => {
      const ansi = segment.style?.('X') ?? 'X';
      const rgb = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(ansi);
      const color = rgb ? `#${rgb.slice(1).map(value => Number(value).toString(16).padStart(2, '0')).join('')}` : '';
      return [...segment.text].map(text => ({ text, color }));
    }));
    deepEqual(actual, expected, `Codex command colors: ${fixture.command}`);
  }
} finally { chalk.level = oldLevel; }

const command = (id: string, cmd: string, status: ToolHistoryEntry['status'] = 'completed', exitCode = 0): ToolHistoryEntry => ({
  type: 'tool', toolCallId: id, toolName: 'exec_command', input: { cmd },
  status, output: status === 'running' ? undefined : JSON.stringify({ output: `${id} output`, exit_code: exitCode }),
});
const entries = [
  command('setup', 'pwd && rg --files'),
  command('read', 'cat AGENTS.md; cat README.md'),
  command('read-again', "sed -n '1,20p' README.md"),
  command('search', "rg -n 'foo|bar' src/runtime.c"),
  command('failed', 'git status --short', 'completed', 1),
  command('list', 'ls src/silver'),
];
const rendered = serializeBlock(renderCommandActivity(entries, ctx)).join('\n');
check(rendered.includes('Read AGENTS.md, README.md'), 'consecutive read calls group and deduplicate filenames');
check(rendered.includes('Search foo|bar in runtime.c'), 'quoted regex alternation becomes an exploration summary');
check(rendered.includes('List silver'), 'exploration uses Codex short display paths');
equal(rendered.split('• Explored').length - 1, 2, 'ordinary commands separate exploration groups');
check(rendered.indexOf('Ran pwd') < rendered.indexOf('Read AGENTS') && rendered.indexOf('Search foo') < rendered.indexOf('Ran git') && rendered.indexOf('Ran git') < rendered.indexOf('List silver'), 'mixed command cells preserve execution order');
check(!rendered.includes('Ran 6 commands'), 'mixed commands never collapse into a count');
const running = serializeBlock(renderCommandActivity([entries[1], command('live', 'rg --files', 'running')], ctx)).join('\n');
check(running.includes('• Exploring') && running.includes('Read AGENTS.md, README.md'), 'live exploration extends its existing group');
const failedRead = serializeBlock(renderCommandActivity([command('missing', 'cat missing', 'completed', 1)], ctx)).join('\n');
check(failedRead.includes('Ran cat missing') && failedRead.includes('missing output'), 'failed reads retain their output');
const narrow = { ...ctx, width: 52 };
const long = serializeBlock(renderCommandActivity([command('long', colors[0].command)], narrow));
check(long.some(value => value.includes('  │ ')), 'long commands wrap with the Codex continuation gutter');
check(long.some(value => /… \+\d+ lines/.test(value)), 'commands retain two continuation rows before the omission marker');
check(long.every(value => widthOf(value) <= narrow.width), 'command colors and wrapping respect the terminal width');
const flags = serializeBlock(renderCommandActivity([command('flags', 'rg --files --hidden --no-ignore')], { ...ctx, width: 24 }, { showCommandSummaries: true })).map(stripAnsi);
check(flags.some(value => value.includes('--hidden')), 'wrapping keeps a colored option prefix and name together');
const wideOutput = { ...command('wide', 'npm test'), output: JSON.stringify({ output: 'long '.repeat(100), exit_code: 0 }) };
const preview = serializeBlock(renderCommandActivity([wideOutput], narrow));
check(preview.length <= 6 && preview.every(value => widthOf(value) <= narrow.width), 'output previews truncate after wrapping to fit the Codex row budget');

const app = new AgentApp();
const internal = app as unknown as {
  store: ReturnType<typeof createAgentStore>;
  committedHistoryCount: number;
  appendPermanentLines(lines: string[]): void;
  flushCommittedHistory(context: typeof ctx): void;
};
const committed: string[] = [];
internal.appendPermanentLines = lines => committed.push(...lines);
internal.store.setBusy(true);
internal.store.pushHistoryEntry(entries[0]);
internal.flushCommittedHistory(ctx);
equal(internal.committedHistoryCount, 1, 'completed ordinary commands commit while the turn is still running');
internal.store.pushHistoryEntry(entries[1]);
internal.flushCommittedHistory(ctx);
equal(internal.committedHistoryCount, 1, 'the last exploration cell stays open for more reads');
internal.store.pushHistoryEntry(entries[2]);
internal.store.pushHistoryEntry(entries[4]);
internal.flushCommittedHistory(ctx);
equal(internal.committedHistoryCount, 4, 'a following ordinary command seals the exploration cell');
check(stripAnsi(committed.join('\n')).includes('Read AGENTS.md, README.md'), 'committed exploration retains the combined read summary');
