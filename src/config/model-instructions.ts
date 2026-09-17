function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function withoutSection(text: string, title: string) {
  const lines = text.split('\n');
  let skippedLevel = 0;
  return lines.filter(line => {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (skippedLevel && level <= skippedLevel) skippedLevel = 0;
      if (heading[2] === title) skippedLevel = level;
    }
    return skippedLevel === 0;
  }).join('\n');
}

export function adaptCodexInstructions(instructions: string) {
  let text = instructions
    .replace(/^You are Codex[^\n]*/, 'You are Yet, a coding agent made by The San Francisco Tooling Company. You and the user share one workspace. Collaborate until their intended task is completely handled.')
    .replace(/\bAs Codex\b/g, 'As Yet');
  // Yet supplies its own tool and skill instructions; these sections assume Codex-only integrations.
  for (const section of ['Using skills', 'Apps (Connectors)', 'Plugins', 'Visualizations'])
    text = withoutSection(text, section);
  text = text.split('\n').filter(line =>
    !/functions\.exec\b|multi_tool_use\.parallel\b|functions\.request_user_input/.test(line),
  ).join('\n');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export function readCodexInstructions(model: unknown): string | undefined {
  const source = object(model);
  if (!source) return undefined;
  const messages = object(source.model_messages);
  const template = typeof messages?.instructions_template === 'string' && messages.instructions_template.trim()
    ? messages.instructions_template : source.base_instructions;
  if (typeof template !== 'string' || !template.trim()) return undefined;
  const variables = object(messages?.instructions_variables);
  const personality = typeof variables?.personality_default === 'string' ? variables.personality_default : '';
  return adaptCodexInstructions(template.replace(/\{\{\s*personality\s*\}\}/g, () => personality)) || undefined;
}
