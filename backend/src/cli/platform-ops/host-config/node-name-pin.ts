/**
 * Is this node's Kubernetes name pinned — reported per node in status.json.
 *
 * k3s names its node after the HOSTNAME unless k3s's config sets `node-name`,
 * and re-reads it at every start. A hostname reset at boot (a provider's
 * cloud-init) registered a production server as a NEW node beside its own
 * NotReady one. bootstrap.sh pins the name and host-migration
 * 2026.10.12/0003-pin-k3s-node-name pins it on existing nodes; this reports
 * whether the pin is in place, so a node that is not protected — before that
 * migration ran, or after someone removed the setting — shows on Cluster → Nodes.
 *
 * The node's name is the one its kubelet AUTHENTICATES as (the client
 * certificate's CN=system:node:<name>), never the hostname.
 */
import { X509Certificate } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface NodeNamePin {
  /**
   * pinned — k3s's config names the node as it is registered;
   * unpinned — no `node-name`: k3s takes the hostname at its next start;
   * mismatch — the config names another node (the next start renames it),
   *   or sets node-name in a form this cannot read (`pinnedAs` null).
   */
  readonly state: 'pinned' | 'unpinned' | 'mismatch';
  readonly registeredAs: string;
  readonly pinnedAs: string | null;
}

export interface NodeNamePinPaths {
  readonly kubeletCert: string;
  readonly k3sConfig: string;
  readonly k3sConfigDir: string;
}

const DEFAULT_PATHS: NodeNamePinPaths = {
  kubeletCert: '/var/lib/rancher/k3s/agent/client-kubelet.crt',
  k3sConfig: '/etc/rancher/k3s/config.yaml',
  k3sConfigDir: '/etc/rancher/k3s/config.yaml.d',
};

const NODE_NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/** Pure: the node name in a kubelet client certificate subject (`CN=system:node:<name>`). */
export function nodeNameFromSubject(subject: string): string | null {
  const m = /(?:^|\n|,\s*)CN=system:node:([^\n,]+)/.exec(subject);
  const name = m?.[1]?.trim() ?? '';
  return NODE_NAME_RE.test(name) ? name : null;
}

const PIN_LINE_RE = /^["']?node-name["']?[ \t]*:[ \t]*["']?([a-z0-9]([-a-z0-9.]*[a-z0-9])?)["']?[ \t]*(#.*)?$/;

/**
 * Pure: every `node-name` value in k3s config texts, de-duplicated. Same rule as
 * bootstrap.sh and the host-migration: each non-comment line that mentions
 * node-name must be a plain `node-name: <name>` (key and value optionally
 * quoted); any other form (block scalar, flow style) sets `unreadable`.
 */
export function pinnedNodeNames(configTexts: readonly string[]): { pins: string[]; unreadable: boolean } {
  const names = new Set<string>();
  let unreadable = false;
  for (const text of configTexts) {
    for (const line of text.split('\n')) {
      if (!line.includes('node-name') || /^\s*#/.test(line)) continue;
      const m = PIN_LINE_RE.exec(line.trimEnd());
      if (m) names.add(m[1] as string); else unreadable = true;
    }
  }
  return { pins: [...names].sort(), unreadable };
}

/** Pure: the state from the registered name and the pins found. */
export function nodeNamePinState(registeredAs: string, pins: readonly string[], unreadable = false): NodeNamePin {
  if (unreadable) return { state: 'mismatch', registeredAs, pinnedAs: null };
  if (pins.length === 0) return { state: 'unpinned', registeredAs, pinnedAs: null };
  if (pins.length === 1 && pins[0] === registeredAs) return { state: 'pinned', registeredAs, pinnedAs: registeredAs };
  return { state: 'mismatch', registeredAs, pinnedAs: pins.join(', ') };
}

const readOrNull = (path: string): string | null => {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
};

/** Reads the host. null when this is not a k3s node (no kubelet certificate) or it cannot be read. */
export function readNodeNamePin(paths: NodeNamePinPaths = DEFAULT_PATHS): NodeNamePin | null {
  const pem = readOrNull(paths.kubeletCert);
  if (!pem) return null;
  let registeredAs: string | null;
  try {
    registeredAs = nodeNameFromSubject(new X509Certificate(pem).subject);
  } catch {
    return null;
  }
  if (!registeredAs) return null;
  let dropIns: string[] = [];
  try {
    dropIns = readdirSync(paths.k3sConfigDir).filter((f) => f.endsWith('.yaml')).sort();
  } catch { /* no drop-in directory */ }
  const texts = [readOrNull(paths.k3sConfig), ...dropIns.map((f) => readOrNull(join(paths.k3sConfigDir, f)))]
    .filter((t): t is string => t !== null);
  const { pins, unreadable } = pinnedNodeNames(texts);
  return nodeNamePinState(registeredAs, pins, unreadable);
}
