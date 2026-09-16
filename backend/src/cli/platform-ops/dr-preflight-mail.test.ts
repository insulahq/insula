import { describe, it, expect, vi } from 'vitest';
import { drPreflight } from './dr-preflight.js';
import type { Deps } from './deps.js';

/**
 * `dr preflight` printed `[ OK ] mail restic repo` on DEV while no mail snapshot
 * had completed for 3 days 17 hours. It checked that a Secret existed. The
 * Secret existed the whole time — the Secret is not the backup.
 *
 * These drive the real command and read the line it prints, because the bug was
 * never in the freshness maths: it was in what the check chose to look at.
 */

const SECRET = 'secret/stalwart-snapshot-restic-repo';

/** Deps whose kubectl answers are chosen by matching the argv. */
function depsWith(answers: Array<[RegExp, string]>, lines: string[]): Deps {
  return {
    env: {},
    out: (s: string) => lines.push(s),
    err: () => undefined,
    exec: vi.fn(async (_bin: string, args: string[]) => {
      const argv = args.join(' ');
      for (const [re, stdout] of answers) {
        if (re.test(argv)) return { code: 0, stdout, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    }),
    readFile: vi.fn(() => null),
  } as unknown as Deps;
}

function mailLine(lines: string[]): string {
  const l = lines.find((x) => x.includes('mail restic repo'));
  if (!l) throw new Error(`no mail line in:\n${lines.join('\n')}`);
  return l;
}

const NOW_ISO = '2026-09-15T12:51:00Z';

describe('dr preflight: mail restic repo', () => {
  it('does NOT report OK when the Secret exists but snapshots stopped days ago', () => {
    // Fail this and the 3d17h outage is invisible again.
    const iso = '2026-09-11T19:31:00Z';
    const lines: string[] = [];
    const deps = depsWith([
      [/get secret stalwart-snapshot-restic-repo/, SECRET],
      [/get cronjob stalwart-snapshot/, `*/30 * * * *|false|${iso}`],
    ], lines);

    return drPreflight([], deps).then(() => {
      const l = mailLine(lines);
      expect(l).not.toContain('[ OK ]');
      expect(l).toContain('[WARN]');
      expect(l).toMatch(/NOT LANDING/);
    });
  });

  it('reports OK when snapshots are actually landing on schedule', async () => {
    const lines: string[] = [];
    const deps = depsWith([
      [/get secret stalwart-snapshot-restic-repo/, SECRET],
      // A run 10 minutes ago on a 30-minute cadence: nothing missed.
      [/get cronjob stalwart-snapshot/, `*/30 * * * *|false|${new Date(Date.now() - 10 * 60_000).toISOString()}`],
    ], lines);

    await drPreflight([], deps);
    expect(mailLine(lines)).toContain('[ OK ]');
  });

  it('warns, without claiming staleness, when the CronJob is platform-fired', async () => {
    // Suspended means platform-api owns the cadence; .spec.schedule and
    // .status.lastSuccessfulTime describe something that is not running.
    const lines: string[] = [];
    const deps = depsWith([
      [/get secret stalwart-snapshot-restic-repo/, SECRET],
      [/get cronjob stalwart-snapshot/, '*/30 * * * *|true|'],
    ], lines);

    await drPreflight([], deps);
    const l = mailLine(lines);
    expect(l).toContain('[WARN]');
    expect(l).toMatch(/platform-fired/);
    expect(l).not.toMatch(/NOT LANDING/);
  });

  it('warns when the CronJob has never succeeded', async () => {
    const lines: string[] = [];
    const deps = depsWith([
      [/get secret stalwart-snapshot-restic-repo/, SECRET],
      // Empty lastSuccessfulTime means NEVER, not "recently".
      [/get cronjob stalwart-snapshot/, '*/30 * * * *|false|'],
    ], lines);

    await drPreflight([], deps);
    const l = mailLine(lines);
    expect(l).toContain('[WARN]');
    expect(l).toMatch(/never/i);
  });

  it('still warns about a missing Secret, as before', async () => {
    const lines: string[] = [];
    const deps = depsWith([], lines);
    await drPreflight([], deps);
    expect(mailLine(lines)).toMatch(/not found — bind a MAIL target/);
  });

  it('does not change the command exit code for a stale repo', async () => {
    // `fail` sets the exit code; flipping that on the day this ships would
    // break automation for a condition nobody has been alerted on yet.
    const lines: string[] = [];
    const deps = depsWith([
      [/get secret stalwart-snapshot-restic-repo/, SECRET],
      [/get cronjob stalwart-snapshot/, `*/30 * * * *|false|2026-09-11T19:31:00Z`],
      [/get -o jsonpath.*etcd|snapshots/, ''],
    ], lines);
    const code = await drPreflight([], deps);
    expect([0, 1]).toContain(code);
    expect(mailLine(lines)).toContain('[WARN]');
  });

  it('never claims freshness it cannot compute', async () => {
    const lines: string[] = [];
    const deps = depsWith([
      [/get secret stalwart-snapshot-restic-repo/, SECRET],
      [/get cronjob stalwart-snapshot/, `@daily|false|2026-09-11T19:31:00Z`],
    ], lines);
    await drPreflight([], deps);
    const l = mailLine(lines);
    expect(l).toContain('[WARN]');
    expect(l).not.toContain('[ OK ]');
  });
});

// Reference the fixed instant the outage numbers come from, so a future reader
// can tie the assertions above to the incident.
export const DEV_OUTAGE_NOTICED_AT = NOW_ISO;
