import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

type ErrorDetail = { name: string; message: string; code?: string; stack?: string };

function redact(value: string, secrets: string[]) {
  value = stripVTControlCharacters(value);
  for (const secret of secrets) {
    if (secret) value = value.split(secret).join('[redacted]');
  }
  return value
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
}

export function providerErrorDetails(error: unknown, secrets: string[] = []): ErrorDetail[] {
  const details: ErrorDetail[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown) => {
    if (details.length >= 8 || seen.has(value)) return;
    seen.add(value);
    if (!value || typeof value !== 'object') {
      details.push({ name: 'Error', message: redact(String(value), secrets) });
      return;
    }
    const record = value as Record<string, unknown>;
    details.push({
      name: typeof record.name === 'string' ? record.name : 'Error',
      message: redact(typeof record.message === 'string' ? record.message : String(value), secrets),
      ...(typeof record.code === 'string' ? { code: redact(record.code, secrets) } : {}),
      ...(typeof record.stack === 'string' ? { stack: redact(record.stack, secrets) } : {}),
    });
    if (record.cause !== undefined) visit(record.cause);
    if (Array.isArray(record.errors)) for (const child of record.errors) visit(child);
  };
  visit(error);
  return details;
}

export function recordProviderError(
  error: unknown,
  context: { endpoint: string; model: string; transport?: string; secrets?: string[] },
  logPath = join(homedir(), '.yet', 'logs', 'errors.jsonl'),
) {
  const details = providerErrorDetails(error, context.secrets);
  const message = details.map((detail, index) =>
    `${index === 0 ? '' : `Caused by: ${detail.name}: `}${detail.message}${detail.code ? ` (${detail.code})` : ''}`,
  ).join('\n');
  const endpoint = new URL(context.endpoint);
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(logPath), 0o700);
    appendFileSync(logPath, `${JSON.stringify({
      time: new Date().toISOString(),
      operation: 'responses.create',
      endpoint: `${endpoint.origin}${endpoint.pathname}`,
      model: context.model,
      ...(context.transport ? { transport: context.transport } : {}),
      runtime: { executable: process.execPath, versions: process.versions, platform: process.platform, arch: process.arch },
      ...(typeof record.status === 'number' ? { status: record.status } : {}),
      ...(typeof record.requestID === 'string' ? { requestId: record.requestID } : {}),
      errors: details,
    })}\n`, { mode: 0o600 });
    chmodSync(logPath, 0o600);
    return `${message}\nDiagnostics: ${logPath}`;
  } catch {
    // A logging failure must not hide the original provider failure.
    return message;
  }
}
