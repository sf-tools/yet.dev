import chalk from 'chalk';

import { highlightedCodeBlock, wrapStyledLine } from '@/render/markdown';
import { parseCommand, type ParsedCommand } from '@/agent/parse-command';
import { wrapAnsiLine } from '@/render/ansi';
import { indent, LEFT_MARGIN, wrapTextBlock } from '@/render/layout';
import { blankLine, line, span } from '@/render/primitives';
import { widthOf } from '@/text';
import type { ToolHistoryEntry } from '@/types';
import type { Block, RenderContext } from '@/render/types';
import { asRecord, stringProp } from './shared';

type CommandResult = {
  output: string;
  exitCode?: number;
  sessionId?: number;
  wallTimeSeconds?: number;
  error?: string;
};

export function isCommandToolEntry(entry: ToolHistoryEntry) {
  return ['exec_command', 'write_stdin'].includes(entry.toolName);
}

function commandText(entry: ToolHistoryEntry) {
  return (
    stringProp(entry.input, 'cmd') ||
    entry.title ||
    'command'
  );
}

function interactionCommand(entry: ToolHistoryEntry) {
  return entry.title?.trim() || '';
}

function parseResult(entry: ToolHistoryEntry): CommandResult {
  const raw = typeof entry.output === 'string' ? entry.output : '';
  if (entry.errorText) return { output: '', error: entry.errorText };

  try {
    const parsed = JSON.parse(raw) as unknown;
    const object = asRecord(parsed);
    if (object) {
      return {
        output: typeof object.output === 'string' ? object.output.trimEnd() : '',
        ...(typeof object.exit_code === 'number' ? { exitCode: object.exit_code } : {}),
        ...(typeof object.session_id === 'number' ? { sessionId: object.session_id } : {}),
        ...(typeof object.wall_time_seconds === 'number'
          ? { wallTimeSeconds: object.wall_time_seconds }
          : {}),
        ...(typeof object.error === 'string' ? { error: object.error } : {}),
      };
    }
  } catch {}

  return { output: raw.trimEnd() };
}

export function isExplorationEntry(entry: ToolHistoryEntry) {
  if (entry.toolName !== 'exec_command' || entry.status === 'failed') return false;
  const result = parseResult(entry);
  return !result.error && (result.exitCode === undefined || result.exitCode === 0) &&
    parseCommand(commandText(entry)).every(command => command.type !== 'unknown');
}

function shellCommandLine(command: string, ctx: RenderContext, prefix: '$ ' | ''): Block {
  const availableWidth = Math.max(
    1,
    ctx.width - widthOf(LEFT_MARGIN) - widthOf(prefix),
  );
  const highlighted = highlightedCodeBlock(command, 'bash', ctx, availableWidth);
  if (highlighted.length === 0) return [line(span(prefix, chalk.magentaBright))];
  const [first, ...rest] = highlighted;
  return [
    line(span(prefix, chalk.magentaBright), ...first.segments),
    ...rest.map(part => line(span(' '.repeat(widthOf(prefix))), ...part.segments)),
  ];
}

function statusLine(result: CommandResult, ctx: RenderContext) {
  const failed = Boolean(result.error) || (result.exitCode !== undefined && result.exitCode !== 0);
  const mark = failed ? '✗' : '✓';
  const style = failed ? chalk.red.bold : chalk.green.bold;
  const elapsed = result.wallTimeSeconds === undefined
    ? ''
    : ` • ${result.wallTimeSeconds < 1 ? `${Math.max(1, Math.round(result.wallTimeSeconds * 1_000))}ms` : `${result.wallTimeSeconds.toFixed(1)}s`}`;
  return line(
    span(mark, style),
    ...(failed && result.exitCode !== undefined ? [span(` (${result.exitCode})`)] : []),
    ...(elapsed ? [span(elapsed, ctx.theme.dimmed)] : []),
  );
}

function commandOutputLines(text: string, width: number, maxLines = 5) {
  const source = text ? text.split('\n') : ['(no output)'];
  const omitted = Math.max(0, source.length - maxLines * 2);
  const retained = omitted ? [...source.slice(0, maxLines), ...source.slice(-maxLines)] : source;
  const wrapped = retained.flatMap(text => wrapAnsiLine(text, width, true));
  if (!omitted && wrapped.length <= maxLines) return wrapped;
  let hidden = omitted + wrapped.length - (maxLines - 1);
  let hint = wrapAnsiLine(`… +${hidden} lines (ctrl + t to view transcript)`, width, true);
  let available = Math.max(0, maxLines - hint.length);
  // Reserve rows for the hint after wrapping, as Codex does on narrow terminals.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    hidden = omitted + wrapped.length - available;
    hint = wrapAnsiLine(`… +${hidden} lines (ctrl + t to view transcript)`, width, true);
    const next = Math.max(0, maxLines - hint.length);
    if (next === available) break;
    available = next;
  }
  const head = Math.floor(available / 2);
  const tail = available - head;
  return [...wrapped.slice(0, head), ...hint, ...(tail ? wrapped.slice(-tail) : [])];
}

function compactCommand(
  label: 'Running' | 'Ran',
  command: string,
  output: string,
  ctx: RenderContext,
  failed = false,
): Block {
  const highlighted = highlightedCodeBlock(command, 'bash', ctx);
  const available = Math.max(1, ctx.width - widthOf(LEFT_MARGIN) - 3 - widthOf(label));
  const [first, ...firstRest] = wrapStyledLine(highlighted[0] ?? line(), available);
  const continuation = [
    ...firstRest,
    ...highlighted.slice(1).flatMap(entry => wrapStyledLine(entry, Math.max(1, ctx.width - widthOf(LEFT_MARGIN) - 4))),
  ];
  const block: Block = [
    line(
      span('• ', failed ? chalk.red.bold : label === 'Ran' ? chalk.green.bold : ctx.theme.dimmed),
      span(label, chalk.bold),
      span(' '),
      ...first.segments,
    ),
  ];
  continuation.slice(0, 2).forEach(entry => {
    block.push(line(span('  │ ', chalk.dim), ...entry.segments));
  });
  if (continuation.length > 2) block.push(line(span(`  │ … +${continuation.length - 2} lines`, chalk.dim)));
  const outputLines = commandOutputLines(output, Math.max(1, ctx.width - widthOf(LEFT_MARGIN) - 4));
  let firstOutputLine = true;
  outputLines.forEach(outputLine => {
    block.push(line(
      span(firstOutputLine ? '  └ ' : '    ', chalk.dim),
      ...outputLine.segments,
    ));
    firstOutputLine = false;
  });
  return block;
}

function renderExploration(
  commands: Array<{ parsed: ParsedCommand[]; running: boolean }>,
  ctx: RenderContext,
): Block {
  const running = commands.some(command => command.running);
  const block: Block = [
    line(
      span('• ', ctx.theme.dimmed),
      span(running ? 'Exploring' : 'Explored', chalk.bold),
    ),
  ];
  const rows: Array<{ title: string; segments: ReturnType<typeof span>[] }> = [];
  for (let index = 0; index < commands.length;) {
    const reads = (command: typeof commands[number]) => command.parsed.every(parsed => parsed.type === 'read');
    if (reads(commands[index])) {
      const names = new Set<string>();
      do {
        for (const parsed of commands[index].parsed) if (parsed.type === 'read') names.add(parsed.name);
        index += 1;
      } while (index < commands.length && reads(commands[index]));
      rows.push({ title: 'Read', segments: [...names].flatMap((name, i) => i ? [span(', ', chalk.dim), span(name)] : [span(name)]) });
    } else {
      for (const parsed of commands[index++].parsed) {
        if (parsed.type === 'read') rows.push({ title: 'Read', segments: [span(parsed.name)] });
        else if (parsed.type === 'list_files') rows.push({ title: 'List', segments: [span(parsed.path ?? parsed.cmd)] });
        else if (parsed.type === 'search') rows.push({ title: 'Search', segments: parsed.query === null
          ? [span(parsed.cmd)]
          : [span(parsed.query), ...(parsed.path === null ? [] : [span(' in ', chalk.dim), span(parsed.path)])] });
      }
    }
  }
  for (const row of rows) {
    const prefix = `${row.title} `;
    const wrapped = wrapStyledLine(line(...row.segments), Math.max(1, ctx.width - widthOf(LEFT_MARGIN) - 4 - widthOf(prefix)));
    wrapped.forEach((entry, index) => block.push(line(
      span(block.length === 1 ? '  └ ' : '    ', chalk.dim),
      span(index === 0 ? prefix : ' '.repeat(widthOf(prefix)), index === 0 ? chalk.cyan : undefined),
      ...entry.segments,
    )));
  }
  return block;
}

function renderInteraction(entry: ToolHistoryEntry, ctx: RenderContext): Block {
  const stdin = stringProp(entry.input, 'chars') ?? '';
  const command = interactionCommand(entry);
  const waitedOnly = stdin.length === 0;
  const header = waitedOnly
    ? line(
        span('• '),
        span('Waited for background terminal', chalk.bold),
        ...(command ? [span(' · ', ctx.theme.dimmed), span(command, ctx.theme.dimmed)] : []),
      )
    : line(
        span('↳ ', ctx.theme.dimmed),
        span('Interacted with background terminal', chalk.bold),
        ...(command ? [span(' · ', ctx.theme.dimmed), span(command, ctx.theme.dimmed)] : []),
      );
  if (waitedOnly) return [header];

  const input = stdin
    .split('\n')
    .flatMap(text => wrapTextBlock(text, Math.max(1, ctx.width - 4)));
  return [
    header,
    ...input.map((entry, index) =>
      line(span(index === 0 ? '  └ ' : '    ', ctx.theme.dimmed), ...entry.segments),
    ),
  ];
}

export function commandActivityIsRunning(entries: ToolHistoryEntry[]) {
  return entries
    .filter(entry => entry.toolName === 'exec_command')
    .some(entry => {
      const result = parseResult(entry);
      return entry.status === 'running' ||
        (result.sessionId !== undefined && result.exitCode === undefined && !result.error);
    });
}

export function renderCommandActivity(
  entries: ToolHistoryEntry[],
  ctx: RenderContext,
  options: { transcript?: boolean; showCommandSummaries?: boolean } = {},
): Block {
  const execEntries = entries.filter(entry => entry.toolName !== 'write_stdin');
  const writes = entries.filter(entry => entry.toolName === 'write_stdin');

  const commands = execEntries.map(entry => {
    const initial = parseResult(entry);
    const failed =
      entry.status === 'failed' ||
      Boolean(initial.error) ||
      (initial.exitCode !== undefined && initial.exitCode !== 0);
    const running =
      entry.status === 'running' ||
      (initial.sessionId !== undefined && initial.exitCode === undefined && !initial.error);
    return {
      entry,
      command: commandText(entry),
      result: initial,
      failed,
      running,
      parsed: parseCommand(commandText(entry)),
    };
  });

  if (options.transcript) {
    const block: Block = [];
    commands.forEach((command, index) => {
      if (index > 0) block.push(blankLine());
      block.push(...shellCommandLine(command.command, ctx, '$ '));
      if (command.result.output) {
        const outputWidth = Math.max(1, ctx.width - widthOf(LEFT_MARGIN));
        block.push(
          ...command.result.output
            .split('\n')
            .flatMap(text => wrapAnsiLine(
              text,
              outputWidth,
            )),
        );
      }
      if (!command.running) block.push(statusLine(command.result, ctx));
    });
    writes.forEach((entry, index) => {
      if (commands.length > 0 || index > 0) block.push(blankLine());
      block.push(...renderInteraction(entry, ctx));
    });
    return indent(block, LEFT_MARGIN);
  }

  if (commands.length === 0 && writes.length === 0) return [];
  const block: Block = [];
  let commandIndex = 0;
  let exploration: typeof commands = [];
  const append = (cell: Block) => {
    if (block.length > 0) block.push(blankLine());
    block.push(...cell);
  };
  const flushExploration = () => {
    if (exploration.length) append(renderExploration(exploration, ctx));
    exploration = [];
  };
  for (const entry of entries) {
    if (entry.toolName === 'write_stdin') {
      flushExploration();
      append(renderInteraction(entry, ctx));
      continue;
    }
    const command = commands[commandIndex++];
    if (!options.showCommandSummaries && !command.failed && command.parsed.every(parsed => parsed.type !== 'unknown')) {
      exploration.push(command);
    } else {
      flushExploration();
      append(compactCommand(command.running ? 'Running' : 'Ran', command.command,
        command.result.error || command.result.output, ctx, command.failed));
    }
  }
  flushExploration();
  return indent(block, LEFT_MARGIN);
}
