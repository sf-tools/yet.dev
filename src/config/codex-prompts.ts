import astra from './prompts/gpt-6-astra.md';
import sol from './prompts/gpt-5.6-sol.md';
import gpt55 from './prompts/gpt-5.5.md';
import gpt54 from './prompts/gpt-5.4.md';
import mini from './prompts/gpt-5.4-mini.md';

export function bundledCodexInstructions(model: string) {
  switch (model) {
    case 'gpt-6-astra': return astra;
    case 'gpt-5.5': return gpt55;
    case 'gpt-5.4': return gpt54;
    case 'gpt-5.4-mini': return mini;
    default: return sol;
  }
}
