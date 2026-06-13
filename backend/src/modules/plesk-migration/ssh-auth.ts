/**
 * Plesk migration — per-Job SSH credential plumbing.
 *
 * A source authenticates over SSH with EITHER a private key OR a password
 * (service.ts / `auth_method`). Every leg (discovery, db, content, mail) ssh's
 * to the Plesk box, so the Job-spec fragments are shared here:
 *   - the per-Job Secret's credential entry,
 *   - the `PLESK_AUTH_METHOD` env + (password) the `SSHPASS` env from the Secret,
 *   - the key volume/mount (key auth only).
 * The Job scripts read `PLESK_AUTH_METHOD` and build the ssh command
 * accordingly (`ssh -i` vs `sshpass -e ssh`).
 */

import { decryptSourceKey, decryptSourcePassword, normalizePrivateKey, sourceAuthMethod } from './service.js';
import type { pleskSources } from '../../db/schema.js';

type SourceRow = typeof pleskSources.$inferSelect;

/** Credential entries to merge into the per-Job Secret's stringData. */
export function sourceAuthSecretData(source: SourceRow): Record<string, string> {
  return sourceAuthMethod(source) === 'password'
    ? { ssh_password: decryptSourcePassword(source) }
    : { id_rsa: normalizePrivateKey(decryptSourceKey(source)) };
}

/** Env entries carrying the auth method (+ the password via secretKeyRef). */
export function sourceAuthEnv(source: SourceRow, secretName: string): Array<Record<string, unknown>> {
  if (sourceAuthMethod(source) === 'password') {
    return [
      { name: 'PLESK_AUTH_METHOD', value: 'password' },
      { name: 'SSHPASS', valueFrom: { secretKeyRef: { name: secretName, key: 'ssh_password', optional: false } } },
    ];
  }
  return [{ name: 'PLESK_AUTH_METHOD', value: 'key' }];
}

/** Volume + mount for the SSH key (key auth only; empty for password auth). */
export function sourceAuthKeyVolume(source: SourceRow, secretName: string): { volumes: unknown[]; volumeMounts: unknown[] } {
  if (sourceAuthMethod(source) === 'password') return { volumes: [], volumeMounts: [] };
  return {
    volumes: [{ name: 'plesk-key', secret: { secretName, items: [{ key: 'id_rsa', path: 'id_rsa', mode: 0o600 }] } }],
    volumeMounts: [{ name: 'plesk-key', mountPath: '/etc/plesk-key', readOnly: true }],
  };
}
