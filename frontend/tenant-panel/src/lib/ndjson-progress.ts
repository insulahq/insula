import { config } from './runtime-config';

/**
 * Consuming an NDJSON progress stream from the file-manager.
 *
 * `/files/fetch-url` and `/files/clone-site` already streamed progress this
 * way, but each caller hand-rolled the reader loop. `/files/extract` and
 * `/files/archive` became streaming too (an archive of any size must work, and
 * a multi-minute job must show something), so the loop lives here once.
 *
 * Event shapes emitted by the sidecar:
 *   { type: 'start',    total: number | null, ... }
 *   { type: 'progress', done: number, total: number | null, percent: number | null, current: string }
 *   { type: 'complete', ...operation-specific fields }
 *   { type: 'error',    message: string }
 *
 * `total` is null when the member count cannot be known cheaply (tar has no
 * index; archive creation would have to walk the tree twice). Callers must
 * render a running count in that case rather than inventing a percentage.
 */

export interface StreamProgress {
  readonly done: number;
  readonly total: number | null;
  readonly percent: number | null;
  readonly current: string;
}

export interface StreamOptions {
  readonly onStart?: (total: number | null) => void;
  readonly onProgress?: (p: StreamProgress) => void;
  readonly signal?: AbortSignal;
}

/**
 * POST a body and consume the NDJSON reply, resolving with the `complete`
 * event's payload. Rejects on an `error` event, a non-OK status, or a stream
 * that ends without completing — the last case matters, because a truncated
 * stream previously looked like success.
 */
export async function streamNdjsonOperation<T = Record<string, unknown>>(
  path: string,
  body: unknown,
  { onStart, onProgress, signal }: StreamOptions = {},
): Promise<T> {
  const token = localStorage.getItem('auth_token');
  const base = config.API_URL || '';

  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => null);
    throw new Error(err?.error?.message ?? err?.error ?? `Request failed (${response.status})`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response stream');

  const decoder = new TextDecoder();
  let buffer = '';
  let completed: T | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // a partial line can never reach here; ignore any stray text
      }
      if (msg.type === 'start') onStart?.((msg.total as number | null) ?? null);
      else if (msg.type === 'progress') {
        onProgress?.({
          done: (msg.done as number) ?? 0,
          total: (msg.total as number | null) ?? null,
          percent: (msg.percent as number | null) ?? null,
          current: (msg.current as string) ?? '',
        });
      } else if (msg.type === 'error') throw new Error((msg.message as string) || 'Operation failed');
      else if (msg.type === 'complete') completed = msg as T;
    }
  }

  // A stream that stops without a `complete` event means the sidecar died
  // mid-operation. Treating that as success would report a half-extracted
  // archive as finished.
  if (!completed) throw new Error('The operation stopped unexpectedly before finishing');
  return completed;
}
