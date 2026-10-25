/**
 * The rendered join line is EXECUTED here — bash, the real sha256sum and the
 * real scripts/join-node.sh, with stub curl/openssl/install on PATH. String
 * assertions alone cannot prove the properties that matter: a script that is not
 * the cluster's copy never runs, and a binary whose signature fails is never
 * installed or run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  joinNodeScriptRef,
  loadPinnedReleaseKey,
  renderJoin,
  resolveJoinRelease,
  shellQuote,
  type JoinScriptInput,
} from './join-script.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const REPO_COSIGN_PUB = join(REPO, 'platform/cosign.pub');
const JOIN_NODE = join(REPO, 'scripts/join-node.sh');
const JOIN_NODE_SHA256 = createHash('sha256').update(readFileSync(JOIN_NODE)).digest('hex');
const SCRIPT_URL = 'https://raw.githubusercontent.com/insulahq/insula/v2026.10.2/scripts/join-node.sh';
const WORKER_TOKEN = `K10${'a'.repeat(64)}::abcdef.0123456789abcdef`;

function input(over: Partial<JoinScriptInput> = {}): JoinScriptInput {
  return {
    cppName: 'w3',
    nodeIp: '198.51.100.50',
    role: 'worker',
    serverIp: '198.51.100.10',
    release: { version: '2026.10.2', tag: '2026.10.2', repo: 'insulahq/insula' },
    joinScript: { url: SCRIPT_URL, sha256: JOIN_NODE_SHA256 },
    token: { kind: 'bootstrap', value: WORKER_TOKEN, expiresAt: '2026-10-01T14:00:00Z' },
    dualStack: false,
    extraFlags: [],
    privateUnderlay: false,
    ...over,
  };
}

const HAS_TOOLS = spawnSync('bash', ['-c', 'command -v sha256sum base64 && [ "$(uname -m)" = x86_64 -o "$(uname -m)" = aarch64 ]']).status === 0;

// Stub binaries: each logs its argv to $STUB_LOG; behaviour via env knobs. The
// "insula" curl delivers is itself a stub that logs how it was run.
const STUBS: Record<string, string> = {
  id: 'echo "${STUB_UID:-0}"',
  curl: [
    'echo "curl $*" >> "$STUB_LOG"',
    'out=""; url=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; https://*) url="$1" ;; esac; shift; done',
    'case "$url" in',
    '  */scripts/join-node.sh) cp "$STUB_SCRIPT_SRC" "$out" ;;',
    '  *.sig) [ "${STUB_CURL_RC:-0}" = 0 ] || exit "$STUB_CURL_RC"; printf "${STUB_SIG:-c2ln}" > "$out" ;;',
    '  *) [ "${STUB_CURL_RC:-0}" = 0 ] || exit "$STUB_CURL_RC"; printf \'#!/bin/sh\\necho "insula $*" >> "$STUB_LOG"\\n\' > "$out" ;;',
    'esac',
  ].join('\n'),
  openssl: [
    'echo "openssl $*" >> "$STUB_LOG"',
    'cp cosign.pub "$STUB_SEEN_PUB" 2>/dev/null || true',
    '[ "${STUB_OPENSSL_RC:-0}" = 0 ] || { echo "Verification failure"; exit "$STUB_OPENSSL_RC"; }',
    'echo "Verified OK"',
  ].join('\n'),
  install: 'echo "install $*" >> "$STUB_LOG"; cp "$3" "$4" && chmod 755 "$4"',
};

let dir = '';
let stubDir = '';
let binDir = '';
let logFile = '';
let seenPub = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'join-script-test-'));
  stubDir = join(dir, 'stubs');
  binDir = join(dir, 'usr-local-bin');
  mkdirSync(stubDir);
  mkdirSync(binDir);
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

function run(script: string, env: Record<string, string> = {}, stdin = ''): { status: number | null; out: string; calls: string[] } {
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
      STUB_SCRIPT_SRC: JOIN_NODE,
      JOIN_NODE_BIN_DIR: binDir,
      ...env,
    },
  });
  const calls = readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  return { status: res.status, out: `${res.stdout}${res.stderr}`, calls };
}

describe.skipIf(!HAS_TOOLS)('the rendered join line — executed', () => {
  it('worker: fetches the pinned script, which verifies + installs the release CLI and joins', () => {
    const { script } = renderJoin(input({ dualStack: true }));
    const r = run(script);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('join-node.sh: OK');
    expect(r.calls[0]).toBe(`curl -fsSL --proto =https --proto-redir =https -o join-node.sh ${SCRIPT_URL}`);
    expect(r.calls[1]).toContain('--connect-timeout 20 --max-time 900');
    expect(r.calls[1]).toMatch(
      /^curl .* -o insula https:\/\/github\.com\/insulahq\/insula\/releases\/download\/v2026\.10\.2\/insula-linux-(amd64|arm64)$/,
    );
    expect(r.calls[2]).toMatch(/-o insula\.sig .*insula-linux-(amd64|arm64)\.sig$/);
    expect(r.calls[3]).toBe('openssl dgst -sha256 -verify cosign.pub -signature insula.sig.der insula');
    expect(r.calls[4]).toBe(`install -m 0755 insula ${binDir}/insula`);
    expect(r.calls[5]).toBe(`insula bootstrap --join-as worker --server 198.51.100.10 --token ${WORKER_TOKEN} --dual-stack`);
    // The script verifies against the key the repo pins — the one the image trusts.
    expect(readFileSync(seenPub, 'utf8')).toBe(readFileSync(REPO_COSIGN_PUB, 'utf8'));
  });

  it('a script that is not the cluster\'s copy never runs', () => {
    const tampered = join(dir, 'tampered.sh');
    writeFileSync(tampered, readFileSync(JOIN_NODE, 'utf8').replace('set -euo pipefail', 'set -euo pipefail\necho pwned >> "$STUB_LOG"'));
    const r = run(renderJoin(input()).script, { STUB_SCRIPT_SRC: tampered });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('join-node.sh: FAILED');
    expect(r.calls).toHaveLength(1); // the fetch, nothing after
  });

  it('a FAILED signature check never installs or runs the binary', () => {
    const r = run(renderJoin(input()).script, { STUB_OPENSSL_RC: '1' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('signature verification FAILED');
    expect(r.calls.some((c) => c.startsWith('install'))).toBe(false);
    expect(r.calls.some((c) => c.startsWith('insula'))).toBe(false);
    expect(existsSync(join(binDir, 'insula'))).toBe(false);
  });

  it('a failed CLI download stops before verification', () => {
    const r = run(renderJoin(input()).script, { STUB_CURL_RC: '22' });
    expect(r.status).not.toBe(0);
    expect(r.calls.some((c) => c.startsWith('openssl'))).toBe(false);
  });

  it('refuses to run as non-root, before downloading the CLI', () => {
    const r = run(renderJoin(input()).script, { STUB_UID: '1000' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('run this as root');
    expect(r.calls).toHaveLength(1);
  });

  it('server: asks for the token (hidden), then passes it to bootstrap', () => {
    const { script } = renderJoin(input({ role: 'server', token: { kind: 'node-token' } }));
    const r = run(script, {}, 'K10bbbb::server:pw\n');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('/var/lib/rancher/k3s/server/node-token on any existing server');
    expect(r.calls.at(-1)).toBe('insula bootstrap --join-as server --server 198.51.100.10 --token K10bbbb::server:pw');
  });

  it('an empty token stops before downloading anything', () => {
    const r = run(renderJoin(input({ role: 'server', token: { kind: 'node-token' } })).script, {}, '\n');
    expect(r.status).toBe(1);
    expect(r.out).toContain('no token given');
    expect(r.calls).toHaveLength(1);
  });

  it('passes extra node flags through and honours a fork repository', () => {
    const fork = input({
      release: { version: '2026.10.2', tag: '2026.10.2', repo: 'example/fork' },
      joinScript: { url: 'https://raw.githubusercontent.com/example/fork/v2026.10.2/scripts/join-node.sh', sha256: JOIN_NODE_SHA256 },
      extraFlags: [['--pod-cidr-v6', 'fd00:1::/56']],
      dualStack: true,
    });
    const r = run(renderJoin(fork).script);
    expect(r.status, r.out).toBe(0);
    expect(r.calls[1]).toContain('https://github.com/example/fork/releases/download/v2026.10.2/insula-linux-');
    expect(r.calls.at(-1)).toBe(
      `insula bootstrap --join-as worker --server 198.51.100.10 --token ${WORKER_TOKEN} --pod-cidr-v6 fd00:1::/56 --dual-stack`,
    );
  });

  it('leaves no temp dir behind, though it ends in exec', () => {
    run(renderJoin(input()).script);
    expect(readdirSync(dir).filter((n) => n.startsWith('join-node.') && n !== 'join-node.sh')).toEqual([]);
  });

  it('a signature that is not base64 stops with a reason, installing nothing', () => {
    const r = run(renderJoin(input()).script, { STUB_SIG: '!!!not-base64!!!' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('not valid base64');
    expect(r.calls.some((c) => c.startsWith('openssl') || c.startsWith('install'))).toBe(false);
  });

  it('a server join without a terminal or --token stops with a reason', () => {
    const r = run(renderJoin(input({ role: 'server', token: { kind: 'node-token' } })).script);
    expect(r.status).toBe(1);
    expect(r.out).toContain('no token given');
  });

  describe('--check-dns', () => {
    let server: Server | null = null;
    const listen = async (): Promise<number> => {
      server = createServer();
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      return (server!.address() as { port: number }).port;
    };
    const closedPort = async (): Promise<number> => {
      const port = await listen();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
      return port;
    };
    afterEach(async () => {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    });

    // The kernel completes the TCP handshake from the listen backlog, so the
    // check succeeds although spawnSync blocks this process's event loop.
    it('a reachable DNS API: no warning, and the flag is not passed on to bootstrap', async () => {
      const port = await listen();
      const r = run(renderJoin(input({ checkDns: [`127.0.0.1:${port}`] })).script);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain(`Checking that this host reaches the DNS server API at 127.0.0.1:${port}`);
      expect(r.out).not.toContain('WARNING');
      expect(r.calls.at(-1)).toBe(`insula bootstrap --join-as worker --server 198.51.100.10 --token ${WORKER_TOKEN}`);
    });

    it('an unreachable one, no terminal: warns with what to check, then joins', async () => {
      const port = await closedPort();
      const r = run(renderJoin(input({ checkDns: [`127.0.0.1:${port}`] })).script);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain(`WARNING: this host cannot reach the DNS server API at: 127.0.0.1:${port}`);
      expect(r.out).toContain("'netbird status'");
      expect(r.out).toContain('no terminal to ask');
      expect(r.calls.at(-1)).toMatch(/^insula bootstrap --join-as worker /);
    });

    // A real terminal (script(1) gives the script one), so it asks.
    const HAS_SCRIPT = spawnSync('bash', ['-c', 'command -v script']).status === 0;
    it.skipIf(!HAS_SCRIPT).each([
      ['n', 1, 'stopped before installing anything'],
      ['y', 0, 'insula bootstrap --join-as worker'],
    ])('on a terminal it asks: %s → exit %i', async (answer, status, expected) => {
      const port = await closedPort();
      writeFileSync(join(dir, 'line.sh'), renderJoin(input({ checkDns: [`127.0.0.1:${port}`] })).script);
      const r = run("script -qec 'bash line.sh' /dev/null", {}, `${answer}\n`);
      expect(r.status, r.out).toBe(status);
      expect(r.out).toContain('Join anyway? [y/N]');
      expect(`${r.out}\n${r.calls.join('\n')}`).toContain(expected);
      if (answer === 'n') expect(r.calls).toHaveLength(1); // the script fetch, nothing installed
    });

    it('warns before the token prompt and before any download', async () => {
      const port = await closedPort();
      const { script } = renderJoin(input({ role: 'server', token: { kind: 'node-token' }, checkDns: [`127.0.0.1:${port}`] }));
      const r = run(script, {}, 'K10bbbb::server:pw\n');
      expect(r.status, r.out).toBe(0);
      expect(r.out.indexOf('WARNING')).toBeLessThan(r.out.indexOf('node-token on any existing server'));
      expect(r.out.indexOf('WARNING')).toBeLessThan(r.out.indexOf('Downloading the insula CLI'));
    });
  });
});

describe.skipIf(!HAS_TOOLS)('join-node.sh — argument checks', () => {
  it.each([
    [['--join-as', 'worker', '--server', '198.51.100.10', '--token', 't'], '--release <version> is required'],
    [['--release', '2026.10.2', '--join-as', 'boss', '--server', '198.51.100.10'], '--join-as must be server or worker'],
    [['--release', '2026.10.2', '--join-as', 'worker', '--server', 'sv1.example.test'], '--server must be the IPv4 address'],
    [['--release', '2026.10.2;id', '--join-as', 'worker', '--server', '198.51.100.10'], '--release <version> is required'],
    [['--release', '2026.10.2', '--join-as', 'worker', '--server', '198.51.100.10', '--repo', 'a/..'], '--repo must be'],
    [['--release', '2026.10.2', '--join-as', 'worker', '--server'], '--server needs a value'],
    [['--release', '2026.10.2', '--join-as', 'worker', '--server', '198.51.100.10', '--token', 't', '--check-dns', 'host'], '--check-dns must be <host>:<port>'],
    [['--release', '2026.10.2', '--join-as', 'worker', '--server', '198.51.100.10', '--token', 't', '--check-dns', 'a;id:80'], '--check-dns must be <host>:<port>'],
    [['--release', '2026.10.2', '--join-as', 'worker', '--server', '198.51.100.10', '--token', 't', '--check-dns', 'h:70000'], '--check-dns must be <host>:<port>'],
  ])('%j → %s, nothing downloaded', (args, message) => {
    const r = run(`bash ${shellQuote(JOIN_NODE)} ${args.map(shellQuote).join(' ')}`);
    expect(r.status).toBe(1);
    expect(r.out).toContain(message);
    expect(r.calls).toEqual([]);
  });

  it("embeds exactly the repository's release key", () => {
    const key = /RELEASE_KEY='([^']+)'/.exec(readFileSync(JOIN_NODE, 'utf8'))?.[1];
    expect(`${key}\n`).toBe(readFileSync(REPO_COSIGN_PUB, 'utf8'));
  });
});

describe('renderJoin', () => {
  it('server: the token step on an existing server, then the one line without a token', () => {
    const r = renderJoin(input({ role: 'server', token: { kind: 'node-token' }, serverName: 'sv1' }));
    expect(r.steps.map((s) => s.id)).toEqual(['server-token', 'join']);
    expect(r.steps[0]?.title).toContain('sv1 (198.51.100.10)');
    expect(r.script).not.toContain('--token');
    expect(r.bootstrapCommand).toBe("insula bootstrap --join-as server --server '198.51.100.10' --token <token>");
  });

  it('private underlay: says to append the flag, never guesses its CIDR', () => {
    const r = renderJoin(input({ privateUnderlay: true }));
    expect(r.steps.at(-1)?.note).toContain('Append the same --cluster-network-cidr <cidr>');
    expect(r.script).not.toContain('--cluster-network-cidr');
  });

  it('refuses a quote-bearing value, a malformed hash, a role outside server|worker', () => {
    expect(() => renderJoin(input({ serverIp: "198.51.100.10'; rm -rf /" }))).toThrow();
    expect(() => shellQuote("a'b")).toThrow();
    expect(() => renderJoin(input({ joinScript: { url: SCRIPT_URL, sha256: "abc'; id" } }))).toThrow(/malformed script hash/);
    expect(() => renderJoin(input({ role: 'worker; rm -rf /' as never }))).toThrow(/refusing to render a join/);
  });

  it('--check-dns goes on the join line only, never into the plain bootstrap command', () => {
    const r = renderJoin(input({ checkDns: ['100.64.0.10:8081', '[2001:db8::53]:8081', 'dns.example.test:443'] }));
    expect(r.script).toContain("--check-dns '100.64.0.10:8081' --check-dns '[2001:db8::53]:8081' --check-dns 'dns.example.test:443'");
    expect(r.bootstrapCommand).not.toContain('--check-dns');
    expect(() => renderJoin(input({ checkDns: ["h:1'; id"] }))).toThrow(/malformed --check-dns/);
    expect(() => renderJoin(input({ checkDns: ['no-port'] }))).toThrow(/malformed --check-dns/);
  });

  it('neutralises shell metacharacters in the release tag shown in the note', () => {
    const r = renderJoin(input({ release: { version: '2026.10.2', tag: '2026.10.2$(id)', repo: 'insulahq/insula' } }));
    expect(r.steps.at(-1)?.note).not.toContain('$(id)');
  });
});

describe('joinNodeScriptRef', () => {
  it('a DEV build stamp → its commit; a release or rc → its tag', () => {
    expect(joinNodeScriptRef('2026.10.2-d847808')).toBe('d847808');
    expect(joinNodeScriptRef('2026.10.2')).toBe('v2026.10.2');
    expect(joinNodeScriptRef('2026.11.0-rc.2')).toBe('v2026.11.0-rc.2');
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
