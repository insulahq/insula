/**
 * `platform-ops domain …` — platform-apex operations (R18 consolidation).
 *
 * `domain rename` wraps the R16 `renamePlatformDomain` service IN-PROCESS (the
 * CLI imports the backend module directly — ADR-045 item 18). It moves every
 * reconciler-driven platform hostname + TLS cert to the new apex WITHOUT
 * touching `ingress_base_domain` (the tenant CNAME target). DNS for the new
 * hosts must exist for cert-manager (HTTP-01) — the command prints exactly which.
 */
import type { Deps } from './deps.js';

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

async function domainRename(args: string[], deps: Deps): Promise<number> {
  // Accept `--to <apex>` or a bare positional apex.
  const positional = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
  const newApex = flagValue(args, '--to') ?? positional;
  if (!newApex) {
    deps.err('domain rename: provide the new apex via --to <apex> (e.g. brand.example.com)');
    return 2;
  }

  const out = await deps.renameDomain({ newApex, kubeconfig: flagValue(args, '--kubeconfig') });
  if (!out.ok || !out.result) {
    deps.err(`domain rename: failed${out.errorCode ? ` (${out.errorCode})` : ''}: ${out.detail ?? ''}`);
    return 1;
  }

  const r = out.result;
  if (args.includes('--json')) {
    deps.out(JSON.stringify(r));
    return 0;
  }
  deps.out(`Platform apex: ${r.previousApex ?? '(unset)'} -> ${r.newApex}`);
  deps.out(
    `  reconciled: panels=${r.reconciled.panels} webmail=${r.reconciled.webmail} ` +
      `mail=${r.reconciled.mail} stalwart=${r.reconciled.stalwartWebadmin} tunnel=${r.reconciled.tunnelAnchor}`,
  );
  deps.out(`  ingress_base_domain (tenant CNAME target) is unchanged.`);
  if (r.dnsRequired.length > 0) {
    deps.out('  DNS to ensure (point each at the ingress; needed for the LE cert):');
    for (const d of r.dnsRequired) deps.out(`    ${d.host}  — ${d.note}`);
  }
  return 0;
}

export async function domainCommand(args: string[], deps: Deps): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'rename':
      return domainRename(rest, deps);
    default:
      deps.err(`domain: expected 'rename', got ${sub ? `'${sub}'` : 'none'}`);
      return 2;
  }
}
