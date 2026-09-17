import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerErrorDetails, recordProviderError } from '@/providers/diagnostics';
import { check, equal } from './harness';

const directory = await mkdtemp(join(tmpdir(), 'yet-diagnostics-'));
try {
  const token = 'oauth-secret-value';
  const cause = Object.assign(new TypeError('FinalizationRegistry.register target must be an object'), { code: 'ERR_RUNTIME' });
  const error = new Error('Connection error.', { cause });
  const logPath = join(directory, 'logs', 'errors.jsonl');
  const message = await recordProviderError(error, {
    endpoint: 'https://example.test/responses?token=must-not-log', model: 'gpt-5.6-sol', secrets: [token],
  }, logPath);
  check(message.includes('Caused by: TypeError: FinalizationRegistry.register target must be an object (ERR_RUNTIME)'), 'connection errors display the runtime cause and code');
  check(message.includes(logPath), 'connection errors show the diagnostics file');
  const entry = JSON.parse(await readFile(logPath, 'utf8'));
  equal(entry.endpoint, 'https://example.test/responses', 'diagnostics omit URL queries');
  equal(entry.errors[1].code, 'ERR_RUNTIME', 'diagnostics retain nested error codes');
  check(entry.errors[1].stack.includes('FinalizationRegistry'), 'diagnostics retain the cause stack');
  equal(entry.runtime.executable, process.execPath, 'diagnostics identify the runtime executable');
  if (process.platform !== 'win32') equal((await stat(logPath)).mode & 0o777, 0o600, 'diagnostic files are private');

  const secretError = new Error(`Bearer ${token}, sk-test-key eyJtest.payload.signature`);
  const serialized = JSON.stringify(providerErrorDetails(secretError, [token]));
  check(!serialized.includes(token) && !serialized.includes('sk-test-key') && !serialized.includes('eyJtest.payload.signature'), 'diagnostics redact credentials in messages and stacks');
  const cyclic = new Error('cycle');
  cyclic.cause = cyclic;
  equal(providerErrorDetails(cyclic).length, 1, 'cyclic cause chains terminate');
  equal(providerErrorDetails(new AggregateError([cause], 'aggregate')).length, 2, 'aggregate errors include their nested failures');

  const blockedPath = join(directory, 'not-a-directory');
  await writeFile(blockedPath, 'file');
  const fallback = await recordProviderError(error, { endpoint: 'https://example.test', model: 'test' }, join(blockedPath, 'errors.jsonl'));
  check(fallback.includes(cause.message) && !fallback.includes('Diagnostics:'), 'logging failures preserve the original cause without claiming a file was written');
} finally {
  await rm(directory, { recursive: true, force: true });
}
