import chalk, { type ChalkInstance } from 'chalk';

import { widthOf } from '@/text';
import { line, span } from './primitives';
import type { Style, StyledLine } from './types';

const colors = [
  chalk.black, chalk.red, chalk.green, chalk.yellow, chalk.blue, chalk.magenta, chalk.cyan, chalk.white,
  chalk.blackBright, chalk.redBright, chalk.greenBright, chalk.yellowBright,
  chalk.blueBright, chalk.magentaBright, chalk.cyanBright, chalk.whiteBright,
];
const backgrounds = [
  chalk.bgBlack, chalk.bgRed, chalk.bgGreen, chalk.bgYellow, chalk.bgBlue, chalk.bgMagenta, chalk.bgCyan, chalk.bgWhite,
  chalk.bgBlackBright, chalk.bgRedBright, chalk.bgGreenBright, chalk.bgYellowBright,
  chalk.bgBlueBright, chalk.bgMagentaBright, chalk.bgCyanBright, chalk.bgWhiteBright,
];

// Interpret SGR styles instead of forwarding terminal control sequences into the UI.
export function wrapAnsiLine(text: string, width: number, dimmed = false): StyledLine[] {
  const lines = [line()];
  const attributes = new Map<number, ChalkInstance>();
  let column = 0;
  let style: Style | undefined = dimmed ? chalk.dim : undefined;
  width = Math.max(1, width);

  for (const token of text.matchAll(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[^\[]?|[^\x1b]+/g)) {
    const value = token[0];
    if (value.startsWith('\x1b')) {
      const sgr = /^\x1b\[([\d;]*)m$/.exec(value);
      if (!sgr) continue;
      const codes = sgr[1].split(';').map(Number);
      for (let index = 0; index < codes.length; index += 1) {
        const code = codes[index];
        if (code === 0) attributes.clear();
        else if (code === 1) attributes.set(1, chalk.bold);
        else if (code === 2) attributes.set(2, chalk.dim);
        else if (code === 3) attributes.set(3, chalk.italic);
        else if (code === 4) attributes.set(4, chalk.underline);
        else if (code === 7) attributes.set(7, chalk.inverse);
        else if (code === 8) attributes.set(8, chalk.hidden);
        else if (code === 9) attributes.set(9, chalk.strikethrough);
        else if (code === 22) { attributes.delete(1); attributes.delete(2); }
        else if ([23, 24, 27, 28, 29].includes(code)) attributes.delete(code - 20);
        else if (code >= 30 && code <= 37) attributes.set(30, colors[code - 30]);
        else if (code >= 90 && code <= 97) attributes.set(30, colors[code - 90 + 8]);
        else if (code >= 40 && code <= 47) attributes.set(40, backgrounds[code - 40]);
        else if (code >= 100 && code <= 107) attributes.set(40, backgrounds[code - 100 + 8]);
        else if (code === 39) attributes.delete(30);
        else if (code === 49) attributes.delete(40);
        else if (code === 38 || code === 48) {
          const mode = codes[++index];
          const count = mode === 5 ? 1 : mode === 2 ? 3 : 0;
          const channels = codes.slice(index + 1, index + 1 + count);
          index += count;
          if (!count || channels.length !== count || channels.some(channel => channel > 255)) continue;
          const color = mode === 5
            ? (code === 38 ? chalk.ansi256(channels[0]) : chalk.bgAnsi256(channels[0]))
            : (code === 38 ? chalk.rgb(channels[0], channels[1], channels[2]) : chalk.bgRgb(channels[0], channels[1], channels[2]));
          attributes.set(code === 38 ? 30 : 40, color);
        }
      }
      const styles = [...attributes.values(), ...(dimmed ? [chalk.dim] : [])];
      style = styles.length ? value => styles.reduce((result, apply) => apply(result), value) : undefined;
      continue;
    }

    for (const ch of value.replace(/\t/g, '    ').replace(/[\x00-\x1f\x7f-\x9f]/g, '')) {
      const size = widthOf(ch);
      if (column > 0 && column + size > width) {
        lines.push(line());
        column = 0;
      }
      const segments = lines[lines.length - 1].segments;
      const previous = segments.at(-1);
      if (previous && previous.style === style) previous.text += ch;
      else segments.push(span(ch, style));
      column += size;
    }
  }
  return lines;
}
