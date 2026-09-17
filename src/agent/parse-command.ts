// Ported from OpenAI Codex's shell-command/src/{bash,parse_command}.rs.
// Presentation metadata only: this must never be used to authorize execution.
export type ParsedCommand =
  | { type: 'read'; cmd: string; name: string; path: string }
  | { type: 'list_files'; cmd: string; path: string | null }
  | { type: 'search'; cmd: string; query: string | null; path: string | null }
  | { type: 'unknown'; cmd: string };

function shellWords(script: string): string[][] | null {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let started = false;
  let quote = '';
  let needsCommand = false;
  const finishWord = () => {
    if (started) words.push(word);
    word = '';
    started = false;
  };
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];
    if (quote) {
      if (ch === quote) quote = '';
      else {
        if (quote === '"' && (ch === '$' || ch === '`' || (ch === '\\' && /[$`"\\\n]/.test(script[i + 1] ?? '')))) return null;
        word += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      // Codex's word-only parser also rejects a quoted command name.
      if (words.length === 0 && !started) return null;
      started = true;
      quote = ch;
    } else if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      finishWord();
      if (ch === '\n' && words.length === 0) continue;
      let connector = ch;
      if ((ch === '|' || ch === '&') && script[i + 1] === ch) connector += script[++i];
      if (connector === '&' || (words.length === 0 && (needsCommand || ch !== '\n'))) return null;
      if (words.length) commands.push(words);
      words = [];
      needsCommand = ['|', '||', '&&'].includes(connector);
    } else if (/\s/.test(ch)) {
      finishWord();
    } else {
      if (/[<>(){}*?\[\]\\~^#$`\x00]/.test(ch) || (!started && ch === '=')) return null;
      started = true;
      needsCommand = false;
      word += ch;
    }
  }
  if (quote || needsCommand) return null;
  finishWord();
  if (words.length) commands.push(words);
  return commands;
}

// Display quoting follows shlex 1.3 (Copyright 2015 Nicholas Allegra, Apache-2.0).
function shellJoin(tokens: string[]) {
  return tokens.map(token => {
    if (!token) return "''";
    let result = '';
    for (let start = 0; start < token.length;) {
      let allowed = token[start] === '^' ? 2 : 7;
      let end = start + (token[start] === '^' ? 1 : 0);
      for (; end < token.length; end += 1) {
        const ch = token[end];
        let next = allowed;
        if (!/[A-Za-z0-9+./:@\]_\-]/.test(ch)) next &= ~1;
        if (/[\x27^\\]/.test(ch)) next &= ~2;
        if (/[`$!^]/.test(ch)) next &= ~4;
        if (!next) break;
        allowed = next;
      }
      const part = token.slice(start, end);
      result += allowed & 1 ? part : allowed & 2 ? `'${part}'` : `"${part.replace(/["\\]/g, '\\$&')}"`;
      start = end;
    }
    return result;
  }).join(' ');
}

function shortPath(path: string) {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').reverse().find(part => part && !['build', 'dist', 'node_modules', 'src'].includes(part)) ?? normalized;
}

function operands(args: string[], flags: string[] = []) {
  const result: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') return [...result, ...args.slice(i + 1)];
    if (flags.includes(arg)) { i += 1; continue; }
    if (!arg.startsWith('-')) result.push(arg);
  }
  return result;
}

function sedMutates(args: string[]) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') break;
    if (['-e', '-f', '--expression', '--file'].includes(arg)) { i += 1; continue; }
    if (arg === '--in-place' || arg.startsWith('--in-place=')) return true;
    if (arg.startsWith('--') || !arg.startsWith('-')) continue;
    for (let j = 1; j < arg.length; j += 1) {
      if (arg[j] === 'i') return true;
      if (arg[j] === 'e' || arg[j] === 'f') {
        if (j === arg.length - 1) i += 1;
        break;
      }
    }
  }
  return false;
}

function sedPath(args: string[]) {
  if (sedMutates(args) || !args.includes('-n')) return undefined;
  const isRange = (value: string) => /^\d+(?:,\d+)?p$/.test(value);
  const hasRange = args.some((arg, i) =>
    ['-e', '--expression'].includes(arg) ? isRange(args[i + 1] ?? '') : !arg.startsWith('-') && isRange(arg));
  if (!hasRange) return undefined;
  const paths = operands(args, ['-e', '-f', '--expression', '--file']);
  return isRange(paths[0] ?? '') ? paths[1] : paths[0];
}

function awkPath(args: string[]) {
  const paths = operands(args, ['-F', '-v', '-f', '--field-separator', '--assign', '--file']);
  return paths[args.includes('-f') || args.includes('--file') ? 0 : 1];
}

function isFormatter([head, ...args]: string[]) {
  if (['wc', 'tr', 'cut', 'sort', 'uniq', 'tee', 'column', 'yes', 'printf'].includes(head)) return true;
  if (head === 'awk') return !awkPath(args);
  if (head === 'sed') return !sedMutates(args) && !sedPath(args);
  if (head === 'head' || head === 'tail') {
    return args.length === 0 || (args.length === 1 && args[0].startsWith('-')) ||
      (args.length === 2 && ['-n', '-c'].includes(args[0]) &&
        (head === 'head' ? /^\d+$/ : /^\+?\d+$/).test(args[1]));
  }
  if (head === 'xargs') {
    let i = 0;
    for (; i < args.length; i += 1) {
      if (args[i] === '--') { i += 1; break; }
      if (!args[i].startsWith('-')) break;
      if (['-E', '-e', '-I', '-L', '-n', '-P', '-s'].includes(args[i])) i += 1;
    }
    const tail = args.slice(i + 1);
    if (args[i] === 'sed') return !sedMutates(tail);
    if (args[i] === 'rg') return !tail.includes('--replace');
    if (['perl', 'ruby'].includes(args[i])) return !tail.some(arg => /^-(?:i|pi)|^--in-place(?:=|$)/.test(arg));
    return true;
  }
  return false;
}

const listFlags: Record<string, string[]> = {
  ls: ['-I', '-w', '--block-size', '--format', '--time-style', '--color', '--quoting-style'],
  eza: ['-I', '--ignore-glob', '--color', '--sort', '--time-style', '--time'],
  exa: ['-I', '--ignore-glob', '--color', '--sort', '--time-style', '--time'],
  tree: ['-L', '-P', '-I', '--charset', '--filelimit', '--sort'],
  du: ['-d', '--max-depth', '-B', '--block-size', '--exclude', '--time-style'],
};
const readFlags: Record<string, string[]> = {
  cat: [], more: [],
  bat: ['--theme', '--language', '--style', '--terminal-width', '--tabs', '--line-range', '--map-syntax'],
  batcat: ['--theme', '--language', '--style', '--terminal-width', '--tabs', '--line-range', '--map-syntax'],
  less: ['-p', '-P', '-x', '-y', '-z', '-j', '--pattern', '--prompt', '--tabs', '--shift', '--jump-target'],
};

function summarize(tokens: string[]): ParsedCommand {
  const [head, ...args] = tokens;
  const cmd = shellJoin(tokens);
  const unknown: ParsedCommand = { type: 'unknown', cmd };
  const list = (path?: string): ParsedCommand => ({ type: 'list_files', cmd, path: path === undefined ? null : shortPath(path) });
  const search = (query?: string, path?: string): ParsedCommand => ({ type: 'search', cmd, query: query ?? null, path: path === undefined ? null : shortPath(path) });
  const read = (path?: string): ParsedCommand => path === undefined ? unknown : { type: 'read', cmd, name: shortPath(path), path };

  if (Object.hasOwn(listFlags, head)) return list(operands(args, listFlags[head])[0]);
  if (Object.hasOwn(readFlags, head)) {
    const paths = operands(args, readFlags[head]);
    return read(paths.length === 1 ? paths[0] : undefined);
  }
  if (['rg', 'rga', 'ripgrep-all'].includes(head)) {
    const values = operands(args, ['-g', '--glob', '--iglob', '-t', '--type', '--type-add', '--type-not', '-m', '--max-count', '-A', '-B', '-C', '--context', '--max-depth']);
    return args.includes('--files') ? list(values[0]) : search(values[0], values[1]);
  }
  if (head === 'git' && args[0] === 'ls-files') return list(operands(args.slice(1), ['--exclude', '--exclude-from', '--pathspec-from-file'])[0]);
  if (['grep', 'egrep', 'fgrep'].includes(head) || (head === 'git' && args[0] === 'grep')) {
    const tail = head === 'git' ? args.slice(1) : args;
    let pattern: string | undefined;
    const values: string[] = [];
    for (let i = 0; i < tail.length; i += 1) {
      const arg = tail[i];
      if (arg === '--') { values.push(...tail.slice(i + 1)); break; }
      if (['-e', '--regexp', '-f', '--file'].includes(arg)) { const value = tail[++i]; pattern ??= value; continue; }
      if (['-m', '--max-count', '-C', '--context', '-A', '--after-context', '-B', '--before-context'].includes(arg)) { i += 1; continue; }
      if (!arg.startsWith('-')) values.push(arg);
    }
    return search(pattern ?? values[0], values[pattern === undefined ? 1 : 0]);
  }
  if (['ag', 'ack', 'pt'].includes(head)) {
    const values = operands(args, ['-G', '-g', '--file-search-regex', '--ignore-dir', '--ignore-file', '--path-to-ignore']);
    return search(values[0], values[1]);
  }
  if (head === 'fd') {
    const values = operands(args, ['-t', '--type', '-e', '--extension', '-E', '--exclude', '--search-path']);
    if (!values.length) return list();
    if (values.length === 1 && (values[0] === '.' || values[0] === '..' || /[/\\]/.test(values[0]))) return list(values[0]);
    return search(values[0], values[1]);
  }
  if (head === 'find') {
    const path = args.find(arg => !arg.startsWith('-') && !['!', '(', ')'].includes(arg));
    const queryIndex = args.findIndex(arg => ['-name', '-iname', '-path', '-regex'].includes(arg));
    return queryIndex >= 0 && args[queryIndex + 1] !== undefined ? search(args[queryIndex + 1], path) : list(path);
  }
  if (head === 'sed') return read(sedPath(args));
  if (head === 'awk') return read(awkPath(args));
  if (head === 'nl') return read(operands(args, ['-s', '-w', '-v', '-i', '-b'])[0]);
  if (head === 'head' || head === 'tail') {
    const number = args[0] === '-n' ? args[1] : args[0]?.startsWith('-n') ? args[0].slice(2) : undefined;
    if (number !== undefined && (head === 'head' ? /^\d+$/ : /^\+?\d+$/).test(number)) return read(operands(args, ['-n'])[0]);
    return read(args.length === 1 && !args[0].startsWith('-') ? args[0] : undefined);
  }
  if (/^python(?:[23](?:\..*)?)?$/.test(head)) {
    const script = args[args.indexOf('-c') + 1];
    if (args.includes('-c') && script && /os\.(walk|listdir|scandir)|glob\.(glob|iglob)|pathlib\.Path|\.rglob\(/.test(script)) return list();
  }
  return unknown;
}

export function parseCommand(script: string): ParsedCommand[] {
  const unknown: ParsedCommand[] = [{ type: 'unknown', cmd: script }];
  const all = shellWords(script);
  if (!all?.length) return unknown;
  const filtered = all.filter(command => !isFormatter(command));
  let cwd = '';
  const parsed: ParsedCommand[] = [];
  for (const tokens of filtered) {
    if (tokens[0] === 'cd') {
      const target = operands(tokens.slice(1)).at(-1);
      if (target) cwd = target.startsWith('/') || /^[A-Za-z]:\\|^\\\\/.test(target) ? target : cwd ? `${cwd}/${target}` : target;
      continue;
    }
    const command = summarize(tokens);
    if (command.type === 'read' && cwd && !command.path.startsWith('/') && !/^[A-Za-z]:\\|^\\\\/.test(command.path)) command.path = `${cwd}/${command.path}`;
    parsed.push(command);
  }
  while (parsed.length > 1) {
    const index = parsed.findIndex((command, i) => command.type === 'unknown' &&
      (command.cmd === 'true' || (i === 0 && command.cmd.startsWith('echo ')) || /^nl(?:\s+-\S+)*$/.test(command.cmd)));
    if (index < 0) break;
    parsed.splice(index, 1);
  }
  if (!parsed.length || parsed.some(command => command.type === 'unknown')) return unknown;
  if (parsed.length === 1 && all.length === 1) parsed[0].cmd = shellJoin(all[0]);
  if (parsed.length === 1 && parsed[0].type === 'read' && script.includes('|') && all.some(command => command[0] === 'sed' && command[1] === '-n')) parsed[0].cmd = script;
  return parsed.filter((command, index) => index === 0 || JSON.stringify(command) !== JSON.stringify(parsed[index - 1]));
}
