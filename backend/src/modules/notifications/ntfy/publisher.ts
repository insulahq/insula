/**
 * ntfy publisher — one HTTP call per message.
 *
 * Uses ntfy's JSON publish API (POST to the server ROOT with the topic
 * inside the body) rather than the classic PUT /<topic> + header form:
 * HTTP headers are latin-1 only, so titles with umlauts/emoji would be
 * mangled — the JSON body is clean UTF-8. Works identically on ntfy.sh
 * and self-hosted servers (a private/in-cluster base URL is expected:
 * this is an admin-configured integration, so no SSRF guard — same
 * trust model as the SMTP host field).
 */
import type { NotificationSeverity } from '@insula/api-contracts';

export interface NtfyProviderConfig {
  readonly serverUrl: string;
  readonly topic: string;
  readonly authMethod: 'none' | 'token' | 'basic';
  /** Decrypted access token (token auth). */
  readonly token?: string | null;
  /** Basic auth credentials (basic auth). */
  readonly username?: string | null;
  readonly password?: string | null;
}

export interface NtfyMessage {
  readonly title: string;
  readonly message: string;
  readonly severity: NotificationSeverity;
  /** Absolute URL the notification should open when tapped. */
  readonly clickUrl?: string | null;
  readonly tags?: readonly string[];
}

/** ntfy priorities: 5=urgent … 1=min. */
export function ntfyPriorityForSeverity(severity: NotificationSeverity): number {
  switch (severity) {
    case 'critical': return 5;
    case 'error': return 4;
    case 'warning': return 4;
    case 'info': return 3;
  }
}

export function ntfyTagsForSeverity(severity: NotificationSeverity): string[] {
  switch (severity) {
    case 'critical': return ['rotating_light'];
    case 'error': return ['x'];
    case 'warning': return ['warning'];
    default: return ['information_source'];
  }
}

export function buildNtfyAuthHeader(cfg: NtfyProviderConfig): Record<string, string> {
  if (cfg.authMethod === 'token' && cfg.token) {
    return { authorization: `Bearer ${cfg.token}` };
  }
  if (cfg.authMethod === 'basic' && cfg.username) {
    const raw = `${cfg.username}:${cfg.password ?? ''}`;
    return { authorization: `Basic ${Buffer.from(raw, 'utf8').toString('base64')}` };
  }
  return {};
}

export function buildNtfyBody(cfg: NtfyProviderConfig, msg: NtfyMessage): Record<string, unknown> {
  const body: Record<string, unknown> = {
    topic: cfg.topic,
    // ntfy caps titles at 250 bytes-ish; clamp conservatively.
    title: msg.title.slice(0, 200),
    message: msg.message.slice(0, 4000),
    priority: ntfyPriorityForSeverity(msg.severity),
    tags: [...ntfyTagsForSeverity(msg.severity), ...(msg.tags ?? [])],
  };
  if (msg.clickUrl) body.click = msg.clickUrl;
  return body;
}

export class NtfyPublishError extends Error {
  constructor(message: string, readonly permanent: boolean) {
    super(message);
    this.name = 'NtfyPublishError';
  }
}

/**
 * Publish one message. Throws NtfyPublishError on failure; `permanent`
 * distinguishes config errors (401/403/404 topic, bad URL) — which
 * retrying cannot fix — from transient network/5xx failures.
 */
export async function publishNtfy(
  cfg: NtfyProviderConfig,
  msg: NtfyMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<{ messageId: string | null }> {
  const base = cfg.serverUrl.replace(/\/+$/, '');
  let resp: Response;
  try {
    resp = await fetchImpl(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...buildNtfyAuthHeader(cfg),
      },
      body: JSON.stringify(buildNtfyBody(cfg, msg)),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    throw new NtfyPublishError(`ntfy server unreachable at ${base}: ${m}`, false);
  }
  if (!resp.ok) {
    const text = (await resp.text().catch(() => '')).slice(0, 300);
    const permanent = resp.status === 401 || resp.status === 403
      || resp.status === 404 || resp.status === 400;
    throw new NtfyPublishError(
      `ntfy publish failed (HTTP ${resp.status})${text ? `: ${text}` : ''}`
      + (resp.status === 401 || resp.status === 403
        ? ' — check the access token / credentials for this (private) topic'
        : ''),
      permanent,
    );
  }
  const json = (await resp.json().catch(() => null)) as { id?: string } | null;
  return { messageId: json?.id ?? null };
}
