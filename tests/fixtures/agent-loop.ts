import type { AgentLoopResult, RunAgentLoopOptions } from '@/agent/runner';

let run: (options: RunAgentLoopOptions) => Promise<AgentLoopResult>;

export function setAgentLoop(next: typeof run) {
  run = next;
}

export function runAgentLoop(options: RunAgentLoopOptions) {
  return run(options);
}
