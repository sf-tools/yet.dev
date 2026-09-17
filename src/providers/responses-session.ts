import type OpenAI from 'openai';
import { ResponsesWS } from 'openai/resources/responses/ws';
import type { ResponseCreateParamsNonStreaming, ResponseInputItem, ResponseStreamEvent } from 'openai/resources/responses/responses';

export type ResponsesRequest = Omit<ResponseCreateParamsNonStreaming, 'stream' | 'background'> & {
  input: ResponseInputItem[];
};

// A turn owns its connection, so concurrent agents cannot share continuation IDs.
export class OpenAIResponseSession {
  private socket: ResponsesWS | null = null;
  private client: OpenAI | null = null;
  private responseId: string | null = null;
  private settings: string | null = null;
  private httpOnly = false;
  transport: 'websocket' | 'http' = 'websocket';

  close() {
    const socket = this.socket;
    this.socket = null;
    this.responseId = null;
    this.settings = null;
    socket?.socket.platformSocket.terminate();
  }

  async *stream(
    client: OpenAI,
    request: ResponsesRequest,
    options: {
      headers?: Record<string, string>;
      continuation?: { responseId: string; input: ResponseInputItem[] };
      signal?: AbortSignal;
    } = {},
  ): AsyncGenerator<ResponseStreamEvent> {
    const signal = options.signal;
    signal?.throwIfAborted();
    if (client !== this.client) {
      this.close();
      this.client = client;
      this.httpOnly = false;
    }
    if (!this.httpOnly) {
      let receivedOutput = false;
      let requestError = false;
      try {
        if (!this.socket || this.socket.socket.readyState > 1) {
          this.close();
          this.socket = new ResponsesWS(client, {
            headers: { 'OpenAI-Beta': 'responses_websockets=2026-02-06', ...options.headers },
            handshakeTimeout: 10_000,
          });
          // Handle errors between requests as well as those consumed by stream().
          this.socket.on('error', () => {});
        }
        const socket = this.socket;
        const { input: _input, ...configuration } = request;
        const settings = JSON.stringify(configuration);
        const continuation = options.continuation;
        const canContinue = continuation && this.responseId === continuation.responseId && this.settings === settings;
        const events = socket.stream();
        const stop = () => socket.socket.platformSocket.terminate();
        let idleTimer = setTimeout(stop, client.timeout);
        idleTimer.unref?.();
        signal?.addEventListener('abort', stop, { once: true });
        try {
          this.transport = 'websocket';
          socket.send({
            ...request,
            type: 'response.create',
            ...(canContinue ? { previous_response_id: continuation.responseId, input: continuation.input } : {}),
          });
          for await (const event of events) {
            signal?.throwIfAborted();
            clearTimeout(idleTimer);
            idleTimer = setTimeout(stop, client.timeout);
            idleTimer.unref?.();
            if (event.type === 'error') {
              const apiError = event.error.error;
              const code = apiError && ('error' in apiError ? apiError.error.code : apiError.code);
              requestError = apiError !== undefined &&
                code !== 'previous_response_not_found' && code !== 'websocket_connection_limit_reached';
              throw event.error;
            }
            if (event.type === 'close') throw new Error(`Responses WebSocket closed before completion (${event.code})`);
            if (event.type !== 'message') continue;
            const message = event.message as ResponseStreamEvent;
            if (message.type === 'response.completed') {
              this.responseId = message.response.id;
              this.settings = settings;
              yield message;
              return;
            }
            if (message.type.startsWith('response.output_') || message.type.startsWith('response.reasoning_'))
              receivedOutput = true;
            yield message;
          }
          throw new Error('Responses WebSocket ended without a completed response');
        } finally {
          clearTimeout(idleTimer);
          signal?.removeEventListener('abort', stop);
          await events.return?.();
        }
      } catch (error) {
        this.close();
        signal?.throwIfAborted();
        // Never replay an API rejection or output that has already reached the UI.
        if (requestError || receivedOutput) throw error;
        this.httpOnly = true;
      }
    }
    this.transport = 'http';
    const stream = await client.responses.create({ ...request, stream: true }, { signal });
    for await (const event of stream) yield event;
  }
}
