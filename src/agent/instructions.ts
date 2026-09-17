import { createSystemPrompt, isYetSystemPrompt } from '@/config/prompt';
import type { AgentMessage } from './messages';
import { loadProjectInstructions } from './project-instructions';
import { ROOT_AGENT_INSTRUCTIONS, subagentInstructions } from './collaboration/role-instructions';

export async function prepareAgentMessages(messages: AgentMessage[], options: {
  model: string;
  cwd?: string;
  yetHome?: string;
}): Promise<AgentMessage[]> {
  const preserved = messages.filter(message =>
    !isYetSystemPrompt(message) && !('instructionContext' in message && message.instructionContext === 'repository'),
  ).map(message => {
    if (message.role !== 'system' || typeof message.content !== 'string') return message;
    // Refresh generated role instructions in resumed sessions and history forks too.
    if (message.content.includes('the primary agent in a team of agents'))
      return { ...message, content: ROOT_AGENT_INSTRUCTIONS };
    const child = /Your canonical task name is `([^`]+)`/.exec(message.content);
    return child ? { ...message, content: subagentInstructions(child[1]) } : message;
  });
  const project = await loadProjectInstructions(options);
  return [
    { role: 'system', content: createSystemPrompt(options.model, options.cwd) },
    ...preserved.filter(message => message.role === 'system'),
    ...(project.text ? [{ role: 'user' as const, content: project.text, instructionContext: 'repository' as const }] : []),
    ...preserved.filter(message => message.role !== 'system'),
  ];
}
