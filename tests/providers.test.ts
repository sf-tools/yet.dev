import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import type { ResponseOutputItem } from 'openai/resources/responses/responses';
import { OpenAIResponseSession, streamOpenAIResponseWithClient } from '@/providers/openai';
import { check, deepEqual, equal, rejects, finish } from './harness';

type RequestBody = { store?: boolean; stream?: boolean; previous_response_id?: string; input: Array<Record<string, unknown>>; [key: string]: unknown };
const requests: Array<{ transport: string; body: RequestBody; connection: number }> = [];
let behavior = 'ok';
let connections = 0;
let outputQueue: ResponseOutputItem[][] = [];
let sawAccountHeader = false;
let sawCompression = false;
const textOutput = (text: string): ResponseOutputItem[] => [{
  type: 'message', id: 'msg_final', status: 'completed', role: 'assistant', phase: 'final_answer',
  content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
}];
const eventsFor = () => {
  const output = outputQueue.shift() ?? textOutput('Done.');
  return [
    ...output.flatMap<Record<string, unknown>>(item => item.type === 'function_call'
      ? [{ type: 'response.output_item.done', item, output_index: 0, sequence_number: 1 }]
      : item.type === 'message'
        ? [{ type: 'response.output_text.delta', delta: item.content[0].type === 'output_text' ? item.content[0].text : '', sequence_number: 1 }]
        : []),
    { type: 'response.completed', response: { id: `resp_${requests.length}`, output, usage: {
      input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 1 },
    } }, sequence_number: 2 },
  ];
};
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const parsed = JSON.parse(body) as RequestBody;
  requests.push({ transport: 'http', body: parsed, connection: 0 });
  if (parsed.store !== false) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ detail: 'Store must be set to false' }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of eventsFor()) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 0 } });
server.on('upgrade', (request, socket, head) => {
  if (behavior === 'reject-handshake') {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  sawAccountHeader = request.headers['chatgpt-account-id'] === 'test-account';
  wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
});
wss.on('connection', socket => {
  sawCompression = socket.extensions.includes('permessage-deflate');
  const connection = ++connections;
  socket.on('message', data => {
    const body = JSON.parse(String(data)) as RequestBody;
    requests.push({ transport: 'websocket', body, connection });
    if (body.store !== false) {
      socket.send(JSON.stringify({ type: 'error', status: 400, error: { code: 'invalid_request_error', message: 'Store must be set to false' } }));
    } else if (behavior === 'drop') {
      socket.terminate();
    } else if (behavior === 'partial') {
      socket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'Partial', sequence_number: 1 }));
      socket.close();
    } else if (behavior === 'missing-previous' || behavior === 'api-error') {
      socket.send(JSON.stringify({ type: 'error', status: 400, error: {
        code: behavior === 'missing-previous' ? 'previous_response_not_found' : 'invalid_request_error',
        message: behavior === 'missing-previous' ? 'Previous response not found' : 'Invalid model',
      } }));
    } else if (behavior !== 'hang') {
      for (const event of eventsFor()) socket.send(JSON.stringify(event));
    }
  });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('missing test server address');
const client = new OpenAI({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0, timeout: 2_000 });
const sessions: OpenAIResponseSession[] = [];
const session = () => { const value = new OpenAIResponseSession(); sessions.push(value); return value; };
const options = {
  model: 'gpt-5.6-sol', thinkingMode: 'auto' as const,
  messages: [{ role: 'system' as const, content: 'Be helpful.' }, { role: 'user' as const, content: 'Inspect it.' }],
  tools: [],
};

try {
  const reasoning: ResponseOutputItem = { type: 'reasoning', id: 'rs_test', summary: [], encrypted_content: 'opaque-reasoning' };
  const call: ResponseOutputItem = { type: 'function_call', call_id: 'call_test', name: 'inspect', namespace: 'functions', arguments: '{}' };
  outputQueue = [[reasoning, call]];
  const wsSession = session();
  const first = await streamOpenAIResponseWithClient(client, { ...options, session: wsSession }, { 'ChatGPT-Account-ID': 'test-account' });
  equal(wsSession.transport, 'websocket', 'agent requests prefer WebSockets');
  equal(requests[0].body.store, false, 'WebSocket requests disable response storage');
  equal(requests[0].body.stream, undefined, 'WebSocket frames omit HTTP stream flags');
  check(sawAccountHeader, 'WebSocket upgrades retain ChatGPT account headers');
  check(sawCompression, 'WebSocket responses negotiate and decode compressed messages');
  equal(first.toolCalls[0].namespace, 'functions', 'WebSocket tool calls preserve their namespace');
  check(first.nextInput?.some(item => item.type === 'reasoning' && item.encrypted_content === 'opaque-reasoning'), 'full replay retains encrypted reasoning');
  const continuation = {
    ...options, session: wsSession, previousInput: first.nextInput, previousResponseId: first.responseId,
    toolOutputs: [{ callId: 'call_test', namespace: 'functions', output: 'tool-result' }],
    continuationMessages: [{ role: 'user' as const, content: 'Keep it brief.' }],
  };
  const second = await streamOpenAIResponseWithClient(client, continuation);
  equal(requests[1].connection, requests[0].connection, 'tool continuations reuse the same socket');
  equal(requests[1].body.previous_response_id, first.responseId, 'WebSocket continuations reference the connection-local response');
  equal(requests[1].body.input.length, 2, 'WebSocket continuations send only tool results and new messages');
  equal(second.text, 'Done.', 'WebSocket output is streamed into the assistant result');
  equal(second.usage.inputTokens, 12, 'WebSocket completion includes token usage');

  behavior = 'missing-previous';
  const recovered = await streamOpenAIResponseWithClient(client, {
    ...options, session: wsSession, previousInput: second.nextInput, previousResponseId: second.responseId,
    continuationMessages: [{ role: 'user', content: 'Continue.' }],
  });
  equal(wsSession.transport, 'http', 'an expired connection-local response falls back to HTTP');
  const fallback = requests.at(-1)!.body;
  equal(fallback.previous_response_id, undefined, 'HTTP recovery never references unstored response IDs');
  equal(fallback.store, false, 'HTTP recovery also disables response storage');
  check(fallback.input.some(item => item.encrypted_content === 'opaque-reasoning'), 'HTTP recovery includes prior encrypted reasoning');
  equal(fallback.input.filter(item => item.call_id === 'call_test').length, 2, 'HTTP recovery pairs each function call and result exactly once');
  check(fallback.input.some(item => item.phase === 'final_answer'), 'HTTP recovery preserves assistant phase');
  equal(recovered.text, 'Done.', 'the recovered response completes normally');

  for (const mode of ['reject-handshake', 'drop']) {
    behavior = mode;
    const value = session();
    const step = await streamOpenAIResponseWithClient(client, { ...options, session: value });
    equal(value.transport, 'http', `${mode} recovers over HTTP before any output`);
    equal(step.text, 'Done.', `${mode} preserves a complete response`);
  }
  behavior = 'partial';
  const httpBeforePartial = requests.filter(request => request.transport === 'http').length;
  await rejects(streamOpenAIResponseWithClient(client, { ...options, session: session() }), /closed before completion/, 'disconnects after output surface an error');
  equal(requests.filter(request => request.transport === 'http').length, httpBeforePartial, 'partial output is never duplicated by an automatic retry');
  behavior = 'api-error';
  await rejects(streamOpenAIResponseWithClient(client, { ...options, session: session() }), /Invalid model/, 'API errors are surfaced without transport fallback');

  behavior = 'ok';
  const isolated = [session(), session()];
  await Promise.all(isolated.map(value => streamOpenAIResponseWithClient(client, { ...options, session: value })));
  check(requests.at(-1)!.connection !== requests.at(-2)!.connection, 'parallel agents use independent WebSocket connections');
  const fresh = session();
  await streamOpenAIResponseWithClient(client, { ...continuation, session: fresh });
  equal(requests.at(-1)!.body.previous_response_id, undefined, 'new sockets send full context instead of another socket’s response ID');
  deepEqual(requests.at(-1)!.body.input.slice(0, first.nextInput!.length), first.nextInput, 'new sockets replay the exact prior context');

  behavior = 'hang';
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new DOMException('Stopped', 'AbortError')), 40);
  await rejects(streamOpenAIResponseWithClient(client, { ...options, session: session(), signal: abort.signal }), /Stopped/, 'abort interrupts a waiting WebSocket response');
  clearTimeout(timer);
} finally {
  for (const value of sessions) value.close();
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
}

finish();
