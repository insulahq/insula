/**
 * `host-config baseline` (ADR-056 §5) — stamp `.baseline` markers on a FRESH node.
 *
 * Why: a freshly bootstrapped node starts with an EMPTY host-migration ledger, so
 * its first converge replays every migration ever shipped. But bootstrap.sh at
 * release X already produces the end state of every migration <= X — that is the
 * project invariant (a bootstrap change reaches fresh installs; the migration
 * backfills existing nodes). Replaying them is at best wasted work and at worst
 * an outage: on production a joining server re-applied a cluster-wide Calico
 * manifest and restarted k3s on a 2-member etcd (~13 s control-plane stall).
 *
 * Honesty: the marker is `.baseline`, never `.done` — ADR-056 rejected touching
 * `.done` for a script that never ran. The runner treats it as applied and
 * reports `already-applied` with `baseline: true`.
 *
 * Safety: refused on a node whose ledger shows converge history (any `.done` or
 * `.failing` marker) unless `--force` — there, a baseline would silently skip
 * migrations that genuinely still have to run. Scripts > --up-to are never
 * stamped: the fresh bootstrap did not produce them, so they must run.
 *
 * Pure over the HostMigrationBaselineDeps seam (index.ts wires the real ledger).
 */

import { compareVersions, isValidVersion } from '../../../modules/platform-updates/poller/semver.js';
import { hostMigrationValid, orderHostMigrations } from './host-migrations.js';
import type {
  HostMigrationBaselineDeps,
  HostMigrationBaselineOptions,
  HostMigrationBaselineResult,
  HostMigrationCatalog,
} from './types.js';

/** ISO-8601 UTC, to the second — the marker is read by humans during an incident. */
function isoUtcSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Marker body. The FIRST line is the record (operators and tooling read only
 * that); a forced stamp adds a second line so the ledger never overstates how
 * fresh the node was.
 */
export function baselineMarkerContent(upTo: string, at: Date, forced: boolean): string {
  const first = `baseline: fresh bootstrap of ${upTo} at ${isoUtcSeconds(at)} — never run on this node`;
  const second = forced
    ? '\nforced: the ledger already had converge history; stamped by an operator with --force'
    : '';
  return `${first}${second}\n`;
}

function emptyResult(
  status: HostMigrationBaselineResult['status'],
  catalog: HostMigrationCatalog,
  opts: HostMigrationBaselineOptions,
  reason: string,
): HostMigrationBaselineResult {
  return {
    status,
    dryRun: opts.dryRun,
    upTo: opts.upTo,
    source: catalog.source,
    stamped: [],
    alreadyRecorded: [],
    pending: [],
    invalid: [],
    failed: [],
    reason,
  };
}

/** Refuse unless the ledger is provably fresh (or the operator forced it). */
function freshnessGate(
  deps: HostMigrationBaselineDeps,
  force: boolean,
): { refusal: { status: 'refused' | 'failed'; reason: string } | null; forced: boolean } {
  let history: { done: number; failing: number };
  try {
    history = deps.ledgerHistory();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { refusal: { status: 'failed', reason: `host-migration ledger unreadable — cannot prove this node is fresh: ${msg}` }, forced: false };
  }
  const hasHistory = history.done > 0 || history.failing > 0;
  if (!hasHistory) return { refusal: null, forced: false };
  if (force) return { refusal: null, forced: true };
  return {
    refusal: {
      status: 'refused',
      reason:
        `this node already has converge history (${history.done} .done, ${history.failing} .failing marker(s)) — ` +
        'a baseline is for a FRESH node only; here it would silently skip migrations that must still run. ' +
        'Pass --force only if you are certain this node was bootstrapped at --up-to and nothing <= it needs to run.',
    },
    forced: false,
  };
}

export function stampHostMigrationBaseline(
  catalog: HostMigrationCatalog,
  opts: HostMigrationBaselineOptions,
  deps: HostMigrationBaselineDeps,
): HostMigrationBaselineResult {
  if (!isValidVersion(opts.upTo)) {
    return emptyResult('failed', catalog, opts, `--up-to ${JSON.stringify(opts.upTo)} is not a CalVer release`);
  }
  if (catalog.source === 'absent') {
    return emptyResult('failed', catalog, opts, 'no host-migration catalog in this binary — nothing could be baselined');
  }
  const gate = freshnessGate(deps, opts.force);
  if (gate.refusal) return emptyResult(gate.refusal.status, catalog, opts, gate.refusal.reason);

  const content = baselineMarkerContent(opts.upTo.trim().replace(/^v/, ''), deps.now(), gate.forced);
  const stamped: string[] = [];
  const alreadyRecorded: string[] = [];
  const pending: string[] = [];
  const invalid: string[] = [];
  const failed: { key: string; error: string }[] = [];

  for (const s of orderHostMigrations(catalog.scripts)) {
    if (!hostMigrationValid(s)) {
      invalid.push(s.key); // never runs either way; never gets a marker path
      continue;
    }
    if (compareVersions(s.version, opts.upTo) > 0) {
      pending.push(s.key); // a bootstrap of upTo did NOT produce this — it must run
      continue;
    }
    if (deps.existingMarker(s.key) !== null) {
      alreadyRecorded.push(s.key); // never rewrite a .done / .skipped / .baseline
      continue;
    }
    if (opts.dryRun) {
      stamped.push(s.key);
      continue;
    }
    try {
      deps.writeBaseline(s.key, content);
      stamped.push(s.key);
    } catch (err) {
      failed.push({ key: s.key, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    status: failed.length > 0 ? 'failed' : 'ok',
    dryRun: opts.dryRun,
    upTo: opts.upTo,
    source: catalog.source,
    stamped,
    alreadyRecorded,
    pending,
    invalid,
    failed,
  };
}
