/**
 * The rendered join script is EXECUTED here (bash, stub binaries on PATH) —
 * string assertions alone cannot prove the property that matters: a failed
 * signature check never installs, and never runs, the downloaded binary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadPinnedReleaseKey,
  renderJoin,
  resolveJoinRelease,
  shellQuote,
  type JoinScriptInput,
} from './join-script.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_COSIGN_PUB = join(HERE, '../../../../platform/cosign.pub');
const KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEdGVzdGtleXRlc3RrZXl0ZXN0a2V5\n-----END PUBLIC KEY-----\n';
const WORKER_TOKEN = `K10${'a'.repeat(64)}::abcdef.0123456789abcdef`;

function input(over: Partial<JoinScriptInput> = {}): JoinScriptInput {
  return {
    cppName: 'w3',
    nodeIp: '198.51.100.50',
    role: 'worker',
    serverIp: '198.51.100.10',
    release: { version: '2026.10.2', tag: '2026.10.2', repo: 'insulahq/insula' },
    releaseKeyPem: KEY_PEM,
    token: { kind: 'bootstrap', value: WORKER_TOKEN, expiresAt: '2026-10-01T14:00:00Z' },
    dualStack: false,
    extraFlags: [],
    privateUnderlay: false,
    ...over,
  };
}

const HAS_BASH = spawnSync('bash', ['--version']).status === 0;

// Stub binaries: each logs its argv to $STUB_LOG; behaviour via env knobs.
const STUBS: Record<string, string> = {
  id: 'echo "${STUB_UID:-0}"',
  curl: [
    'echo "curl $*" >> "$STUB_LOG"',
    '[ "${STUB_CURL_RC:-0}" = 0 ] || exit "$STUB_CURL_RC"',
    'out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done',
    'case "$out" in *.sig) printf c2ln > "$out" ;; *) printf binary > "$out" ;; esac',
  ].join('\n'),
  openssl: [
    'echo "openssl $*" >> "$STUB_LOG"',
    'cp cosign.pub "$STUB_SEEN_PUB" 2>/dev/null || true',
    '[ "${STUB_OPENSSL_RC:-0}" = 0 ] || { echo "Verification failure"; exit "$STUB_OPENSSL_RC"; }',
    'echo "Verified OK"',
  ].join('\n'),
  install: 'echo "install $*" >> "$STUB_LOG"',
  insula: 'echo "insula $*" >> "$STUB_LOG"',
};

let dir = '';
let stubDir = '';
let logFile = '';
let seenPub = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'join-script-test-'));
  stubDir = join(dir, 'bin');
  mkdirSync(stubDir);
  for (const [name, body] of Object.entries(STUBS)) {
    const p = join(stubDir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  }
  logFile = join(dir, 'calls.log');
  seenPub = join(dir, 'seen-cosign.pub');
  writeFileSync(logFile, '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(script: string, env: Record<string, string> = {}, stdin = ''): { status: number | null; stderr: string; calls: string[] } {
  const res = spawnSync('bash', ['-c', script], {
    cwd: dir,
    input: stdin,
    encoding: 'utf8',
    env: {
      PATH: `${stubDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: dir,
      TMPDIR: dir,
      STUB_LOG: logFile,
      STUB_SEEN_PUB: seenPub,
      ...env,
    },
  });
  const calls = readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  return { status: res.status, stderr: res.stderr, calls };
}

describe.skipIf(!HAS_BASH)('rendered join script — executed', () => {
  it('worker happy path: downloads the pinned release, verifies, installs, joins', () => {
    const { script } = renderJoin(input({ dualStack: true }));
    const r = run(script);
    expect(r.status).toBe(0);
    expect(r.calls[0]).toMatch(
      /^curl .* -o insula https:\/\/github\.com\/insulahq\/insula\/releases\/download\/v2026\.10\.2\/insula-linux-(amd64|arm64)$/,
    );
    expect(r.calls[1]).toMatch(/-o insula\.sig .*insula-linux-(amd64|arm64)\.sig$/);
    expect(r.calls[2]).toBe('openssl dgst -sha256 -verify cosign.pub -signature insula.sig.der insula');
    expect(r.calls[3]).toBe('install -m 0755 insula /usr/local/bin/insula');
    expect(r.calls[4]).toBe(
      `insula bootstrap --join-as worker --server 198.51.100.10 --token ${WORKER_TOKEN} --dual-stack`,
    );
    // The inline trust anchor is byte-identical to the pinned key.
    expect(readFileSync(seenPub, 'utf8')).toBe(KEY_PEM);
  });

  it('a FAILED signature check never installs or runs the binary', () => {
    const { script } = renderJoin(input());
    const r = run(script, { STUB_OPENSSL_RC: '1' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Signature verification FAILED');
    expect(r.calls.some((c) => c.startsWith('install'))).toBe(false);
    expect(r.calls.some((c) => c.startsWith('insula'))).toBe(false);
  });

  it('a failed download stops before verification', () => {
    const { script } = renderJoin(input());
    const r = run(script, { STUB_CURL_RC: '22' });
    expect(r.status).not.toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatch(/^curl /);
  });

  it('refuses to run as non-root, before touching anything', () => {
    const { script } = renderJoin(input());
    const r = run(script, { STUB_UID: '1000' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Run this as root');
    expect(r.calls).toEqual([]);
  });

  it('server path: prompts for the server token and passes it through', () => {
    const { script } = renderJoin(input({ role: 'server', token: { kind: 'node-token' } }));
    const r = run(script, {}, 'K10bbbb::server:pw\n');
    expect(r.status).toBe(0);
    expect(r.calls.at(-1)).toBe('insula bootstrap --join-as server --server 198.51.100.10 --token K10bbbb::server:pw');
  });

  it('the verify-install STEP alone (per-step copy) also refuses to install on a bad signature', () => {
    const step = renderJoin(input()).steps.find((s) => s.id === 'verify-install');
    writeFileSync(join(dir, 'insula'), 'binary');
    writeFileSync(join(dir, 'insula.sig'), 'c2ln');
    writeFileSync(join(dir, 'cosign.pub'), KEY_PEM);
    const r = run(step?.command ?? 'false', { STUB_OPENSSL_RC: '1' });
    expect(r.status).not.toBe(0);
    expect(r.calls.some((c) => c.startsWith('install'))).toBe(false);
    expect(existsSync(join(dir, 'insula'))).toBe(true); // left for the operator to delete
  });

  it('cleans up its temp dir', () => {
    const { script } = renderJoin(input());
    run(script);
    const leftovers = spawnSync('sh', ['-c', `ls -d ${dir}/tmp.* 2>/dev/null | wc -l`], { encoding: 'utf8' });
    expect(leftovers.stdout.trim()).toBe('0');
  });
});

describe('renderJoin', () => {
  it('private underlay: comment lines only, the flag is never guessed', () => {
    const { steps } = renderJoin(input({ privateUnderlay: true }));
    const lines = (steps.find((s) => s.id === 'join')?.command ?? '').split('\n');
    expect(lines.slice(0, -1).every((l) => l.startsWith('#'))).toBe(true);
    expect(lines.at(-1)).not.toContain('--cluster-network-cidr');
  });

  it('refuses to embed a quote-bearing value', () => {
    expect(() => renderJoin(input({ serverIp: "198.51.100.10'; rm -rf /" }))).toThrow();
    expect(() => shellQuote("a'b")).toThrow();
  });
});

describe('resolveJoinRelease', () => {
  it('strips a leading v and a dev sha; defaults the repo; rejects junk repos', () => {
    expect(resolveJoinRelease({ PLATFORM_VERSION: 'v2026.10.2-abc1234' })).toEqual({
      version: '2026.10.2-abc1234',
      tag: '2026.10.2',
      repo: 'insulahq/insula',
    });
    expect(resolveJoinRelease({ PLATFORM_VERSION: '2026.10.2', PLATFORM_OPS_REPO: '../evil' }).repo).toBe(
      'insulahq/insula',
    );
  });

  it('throws PLATFORM_VERSION_UNKNOWN with an operator envelope', () => {
    try {
      resolveJoinRelease({});
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'PLATFORM_VERSION_UNKNOWN', status: 503 });
      expect((err as { details?: { operatorError?: { remediation: string[] } } }).details?.operatorError?.remediation.length).toBeGreaterThan(0);
    }
  });
});

describe('loadPinnedReleaseKey', () => {
  it("accepts the repository's real platform/cosign.pub", () => {
    expect(loadPinnedReleaseKey({ PLATFORM_COSIGN_PUB_PATH: REPO_COSIGN_PUB })).toContain('BEGIN PUBLIC KEY');
  });

  it('returns null for a missing file or a non-PEM body', () => {
    expect(loadPinnedReleaseKey({ PLATFORM_COSIGN_PUB_PATH: join(dir, 'absent.pub') })).toBeNull();
    const bad = join(dir, 'bad.pub');
    writeFileSync(bad, "-----BEGIN PUBLIC KEY-----\n'; rm -rf /\n-----END PUBLIC KEY-----\n");
    expect(loadPinnedReleaseKey({ PLATFORM_COSIGN_PUB_PATH: bad })).toBeNull();
  });
});

describe('defence in depth for unquoted script text', () => {
  it('neutralises newlines and shell metacharacters in the header comment', () => {
    const out = renderJoin(input({ cppName: "peer\n rm -rf / #", nodeIp: '192.0.2.50$(id)' }));
    const header = out.script.split('\n')[0];
    expect(header.startsWith('# Join ')).toBe(true);
    expect(out.script).not.toContain('\n rm -rf');
    expect(out.script).not.toContain('$(id)');
  });

  it('refuses a role outside server|worker', () => {
    expect(() => renderJoin(input({ role: 'worker; rm -rf /' as never }))).toThrow(/refusing to render a join/);
  });
});
