import chalk from 'chalk';

import { line, span } from './primitives';
import type { RenderContext, Style, StyledLine } from './types';

// Codex's Bash scopes use these Catppuccin Mocha/Latte foregrounds.
const palette = (light: boolean) => ({
  text: light ? '#4c4f69' : '#cdd6f4',
  command: light ? '#1e66f5' : '#89b4fa',
  option: light ? '#e64553' : '#eba0ac',
  punctuation: light ? '#7c7f93' : '#9399b2',
  string: light ? '#40a02b' : '#a6e3a1',
  operator: light ? '#179299' : '#94e2d5',
  keyword: light ? '#8839ef' : '#cba6f7',
  number: light ? '#fe640b' : '#fab387',
  variable: light ? '#d20f39' : '#f38ba8',
  comment: light ? '#8c8fa1' : '#7f849c',
});
type Token = keyof ReturnType<typeof palette>;
const styles = [false, true].map(light => Object.fromEntries(
  Object.entries(palette(light)).map(([key, color]) => [key, (text: string) => chalk.hex(color)(text)]),
) as Record<Token, Style>);

export function highlightShell(script: string, ctx: RenderContext, depth = 0): StyledLine[] {
  const syntax = styles[ctx.theme.isLight() ? 1 : 0];
  const lines = [line()];
  let commandPosition = true;
  let testCommand = false;
  const emit = (text: string, token: Token = 'text') => {
    text.split('\n').forEach((part, index) => {
      if (index > 0) lines.push(line());
      if (!part) return;
      const segments = lines[lines.length - 1].segments;
      const previous = segments.at(-1);
      if (previous?.style === syntax[token]) previous.text += part;
      else segments.push(span(part, syntax[token]));
    });
  };
  const variable = (source: string) => {
    const substitution = source.startsWith('$(') ? '$(' : source.startsWith('`') ? '`' : null;
    if (substitution && depth < 16) {
      let end = substitution.length;
      let nesting = 1;
      let quote = '';
      for (; end < source.length; end += 1) {
        const ch = source[end];
        if (ch === '\\') { end += 1; continue; }
        if (substitution === '`') { if (ch === '`') break; continue; }
        if (quote) { if (ch === quote) quote = ''; continue; }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '(') nesting += 1;
        else if (ch === ')' && --nesting === 0) break;
      }
      if (end < source.length) {
        if (substitution === '$(') emit('$', 'variable');
        emit(substitution === '$(' ? '(' : '`', 'punctuation');
        highlightShell(source.slice(substitution.length, end), ctx, depth + 1).forEach((entry, index) => {
          if (index > 0) lines.push(line());
          lines[lines.length - 1].segments.push(...entry.segments);
        });
        emit(source[end], 'punctuation');
        return end + 1;
      }
    }
    const match = /^\$(?:\{[\w]+\}|[\w]+|[?#!@$*\d])/.exec(source);
    if (!match) return 0;
    const value = match[0];
    emit('$', 'variable');
    if (value.startsWith('${')) emit('{', 'punctuation');
    emit(value.slice(value.startsWith('${') ? 2 : 1, value.endsWith('}') ? -1 : undefined));
    if (value.endsWith('}')) emit('}', 'punctuation');
    return value.length;
  };
  for (let i = 0; i < script.length;) {
    const rest = script.slice(i);
    const option = /^[ \t]+(-{1,2})([\w-]+)/.exec(rest);
    if (option && !commandPosition) {
      if (testCommand) {
        emit(option[0].slice(0, -option[1].length - option[2].length));
        emit(option[1], 'punctuation');
      } else emit(option[0].slice(0, -option[2].length), 'punctuation');
      emit(option[2], 'option');
      i += option[0].length;
      continue;
    }
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) {
      emit(whitespace[0]);
      if (whitespace[0].includes('\n')) commandPosition = true;
      i += whitespace[0].length;
      continue;
    }
    if (script[i] === '#') {
      const text = /^[^\n]*/.exec(rest)![0];
      emit(text, 'punctuation');
      i += text.length;
      continue;
    }
    if (script[i] === "'" || script[i] === '"') {
      const quote = script[i++];
      emit(quote, 'string');
      while (i < script.length && script[i] !== quote) {
        if (quote === '"') {
          const length = variable(script.slice(i));
          if (length) { i += length; continue; }
          if (script[i] === '\\' && i + 1 < script.length) {
            emit(script.slice(i, i + 2), 'string'); i += 2; continue;
          }
        }
        emit(script[i++], 'string');
      }
      if (script[i] === quote) emit(script[i++], 'string');
      commandPosition = false;
      continue;
    }
    const length = variable(rest);
    if (length) { i += length; continue; }
    if (rest.startsWith('\\\n')) { emit('\\\n', 'punctuation'); i += 2; continue; }
    const descriptor = /^\d+(?=[<>])/.exec(rest);
    if (descriptor) { emit(descriptor[0], 'number'); i += descriptor[0].length; continue; }
    const operator = /^(?:&&|\|\||>>|<<|[;|&<>=])/.exec(rest);
    if (operator) {
      emit(operator[0], 'operator');
      if (/^[;|&]/.test(operator[0])) commandPosition = true;
      i += operator[0].length;
      continue;
    }
    const assignment = commandPosition ? /^(\w+)(=)([^\s;|&<>"']*)/.exec(rest) : null;
    if (assignment) {
      emit(assignment[1]); emit('=', 'operator'); emit(assignment[3], 'string');
      i += assignment[0].length;
      continue;
    }
    const word = /^[^\s;|&<>="'$`\\]+/.exec(rest)?.[0] ?? script[i];
    const keyword = /^(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|select)$/.test(word);
    emit(word, keyword ? 'keyword' : commandPosition || (testCommand && word === ']') ? 'command' : 'text');
    if (commandPosition && word === '[') testCommand = true;
    if (word === ']') testCommand = false;
    commandPosition = keyword && ['if', 'then', 'else', 'elif', 'do', 'while', 'until'].includes(word);
    i += word.length;
  }
  if (script.endsWith('\n') && lines.length > 1) lines.pop();
  return lines;
}
