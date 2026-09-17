import { AgentApp } from '@/agent/app';
import { AgentRuntime, type AgentRuntimeOptions } from '@/agent/runtime';
import { EMPTY_USAGE, type AgentMessage } from '@/agent/messages';
import type { RunAgentLoopOptions } from '@/agent/runner';
import { createAgentStore, type AgentState } from '@/store';
import { EntryKind } from '@/types';
import { renderTranscriptDocument } from '@/render/components/transcript-overlay';
import { createRenderContext, serializeBlock } from '@/render';
import { createTheme } from '@/theme';
import { setAgentLoop } from './fixtures/agent-loop';
import { check, deepEqual, equal, finish } from './harness';

const ctx = createRenderContext(createTheme(), false, 120, 30);
const preamble = 'I will inspect the commands.';
const progress = 'I found the rendering issue.';
const final = 'The rendering issue is fixed.';
const frames: Array<{ live: string; transcript: string }> = [];
let inspect: () => AgentState;
let outcome: 'complete' | 'error' | 'interrupt' = 'complete';

setAgentLoop(async (options: RunAgentLoopOptions) => {
  const messages: AgentMessage[] = [];
  const emit = options.onEvent!;
  const text = async (value: string, phase: 'commentary' | 'final_answer') => {
    await emit({ type: 'text-delta', text: value });
    const message = { role: 'assistant' as const, content: value, phase };
    messages.push(message);
    await emit({ type: 'step-completed', usage: EMPTY_USAGE, message });
  };
  const tool = async (id: string, name: string) => {
    const call = { id, name, input: { cmd: `printf ${id}` } };
    const message = { role: 'tool-call' as const, callId: id, name, input: call.input };
    messages.push(message);
    await emit({ type: 'tool-call', call, message });
    const state = inspect();
    frames.push({
      live: state.liveAssistantText,
      transcript: serializeBlock(renderTranscriptDocument(state.historyEntries, {
        assistant: state.liveAssistantText, reasoning: state.liveReasoningText,
      }, ctx).block).join('\n'),
    });
    const output = JSON.stringify({ output: id, exit_code: 0 });
    await emit({ type: 'tool-result', call, result: { output },
      message: { role: 'tool-result', callId: id, output } });
  };
  await text(preamble, 'commentary');
  await tool('first', 'exec_command');
  await tool('second', 'exec_command');
  await text(progress, 'commentary');
  await tool('third', 'update_plan');
  if (outcome === 'error') throw new Error('test failure');
  if (outcome === 'interrupt') {
    inspect().abortController!.abort(new DOMException('Interrupted', 'AbortError'));
    options.signal!.throwIfAborted();
  }
  await text(final, 'final_answer');
  return { responseId: 'test', text: preamble + progress + final, reasoning: '', usage: EMPTY_USAGE, messages };
});

function verify(state: AgentState, label: string) {
  check(frames.length === 3, `${label}: all scripted tools ran`, JSON.stringify(state.historyEntries));
  deepEqual(frames.map(frame => frame.live), ['', '', ''], `${label}: commentary leaves the live area before every tool`);
  for (const [index, frame] of frames.entries()) {
    equal(frame.transcript.split(preamble).length - 1, 1, `${label}: preamble appears exactly once at tool ${index + 1}`);
    check(frame.transcript.indexOf(preamble) < frame.transcript.indexOf('$ printf first'),
      `${label}: preamble stays above tool output`);
  }
  const order = state.historyEntries.flatMap(entry => entry.type === 'tool'
    ? [entry.toolCallId]
    : entry.type === 'entry' && entry.kind === EntryKind.Assistant ? [entry.text] : []);
  deepEqual(order, [preamble, 'first', 'second', progress, 'third', ...(outcome === 'complete' ? [final] : [])],
    `${label}: each assistant message stays at its original position`);
  equal(state.liveAssistantText, '', `${label}: the live area is cleared at completion`);
}

for (const mode of ['complete', 'error', 'interrupt'] as const) {
  outcome = mode;
  frames.length = 0;
  const app = new AgentApp();
  const internal = app as unknown as {
    store: ReturnType<typeof createAgentStore>;
    render(): void;
    scheduleRender(): void;
    playSound(): void;
    getRuntimeMessages(): Promise<AgentMessage[]>;
    shouldAutoCompact(): boolean;
    collaborationControl: { mailboxMessages(): AgentMessage[] };
    processSubmission(input: { text: string; hidden: boolean }): Promise<void>;
  };
  internal.render = () => {};
  internal.scheduleRender = () => {};
  internal.playSound = () => {};
  internal.getRuntimeMessages = async () => [];
  internal.shouldAutoCompact = () => false;
  internal.collaborationControl.mailboxMessages = () => [];
  inspect = () => internal.store.getState();
  await internal.processSubmission({ text: 'Inspect rendering', hidden: true });
  verify(inspect(), `main ${mode}`);
}

outcome = 'complete';
frames.length = 0;
const runtimeState = createAgentStore().getState();
const statuses: unknown[] = [];
const Runtime = AgentRuntime as unknown as new (options: AgentRuntimeOptions, state: AgentState) => AgentRuntime;
const runtime = new Runtime({
  agent: { id: 'test-agent', path: '/root/test', config: { cwd: process.cwd() } },
  control: { mailboxMessages: () => [], addUsage: () => {}, updateStatus: (_id: string, status: unknown) => statuses.push(status) },
  authorize: async () => true,
} as unknown as AgentRuntimeOptions, runtimeState);
inspect = () => runtime.getState();
await (runtime as unknown as { runTurn(messages: AgentMessage[]): Promise<void> }).runTurn([{ role: 'user', content: 'Inspect rendering' }]);
verify(inspect(), 'child runtime');
deepEqual(statuses.at(-1), { completed: final }, 'child completion reports only the final answer');
await runtime.dispose();
finish();
