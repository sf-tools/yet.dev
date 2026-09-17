import type { AgentMessage } from '@/agent/messages';
import { DEFAULT_MODEL, getKnownOpenAIModel } from './models';
import { bundledCodexInstructions } from './codex-prompts';

const ant = (globalThis as typeof globalThis & { Ant?: { version?: string } }).Ant;
const antVersion = typeof ant === 'object' && typeof ant.version === 'string' ? ant.version.trim() : '';

const SYSTEM_PROMPT_MARKER = '<yet_system_instructions>';

export function createSystemPrompt(model = DEFAULT_MODEL, cwd = process.cwd()) {
  const instructions = getKnownOpenAIModel(model)?.instructions ?? bundledCodexInstructions(model);
  return `${SYSTEM_PROMPT_MARKER}
${instructions.trim()}

# Yet runtime

The following instructions describe this runtime and take precedence over general tool guidance above.

Environment:
- Workspace: ${cwd}
- Date: ${new Date().toDateString()}
- Platform: ${process.platform} (${process.arch})${antVersion ? `\n- Runtime: Ant ${antVersion}` : ''}

Call the provided tools directly with JSON arguments matching their schemas:
- exec_command: inspect the workspace and run commands. Prefer fast, non-interactive commands and use rg for search. Long-running commands return a background session ID.
- write_stdin: poll or interact with a background terminal returned by exec_command.
- apply_patch: create, edit, or delete files with a unified diff.
- update_plan: keep a visible task plan with pending, in-progress, and completed steps.
- get_goal, create_goal, and update_goal: inspect and manage an explicitly requested long-running goal. Never infer a goal from an ordinary task.
- Collaboration tools, when supplied, use the collaboration namespace. Follow the separate collaboration instructions.

Tool rules:
- The tool schemas and current permission instructions are authoritative. Only use tools actually supplied with the request.
- Follow the session's permission policy. When permitted, request elevated access through exec_command's permissions and justification arguments.
- Never claim a command or edit succeeded until its tool result confirms it.
- Ask necessary clarification in a user-facing message, and continue independent work when possible.
- Do not invent unavailable tools or ask the user to run routine commands for you.

Repository instructions:
- Applicable global and repository AGENTS.md instructions are provided separately as user context. More specific directory instructions override broader ones; direct user requests override repository guidance.
- Before editing files below the working directory, check for additional AGENTS.override.md or AGENTS.md files along their directory paths. Their instructions apply within their containing directory trees.
- Follow the supplied skills catalog and read relevant SKILL.md files through exec_command before applying them.
</yet_system_instructions>`;
}

export function isYetSystemPrompt(message: AgentMessage) {
  return message.role === 'system' && typeof message.content === 'string' && (
    message.content.startsWith(SYSTEM_PROMPT_MARKER) ||
    message.content.startsWith('You are Yet, a focused coding agent made by The San Francisco Tooling Company.')
  );
}

export const SYSTEM_PROMPT = createSystemPrompt();

export const COMPACTION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

export const COMPACTION_SUMMARY_PREFIX =
  'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:';

export const createInitialMessages = (model = DEFAULT_MODEL, cwd = process.cwd()): AgentMessage[] => [
  { role: 'system', content: createSystemPrompt(model, cwd) },
];
