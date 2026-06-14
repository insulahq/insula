/**
 * `platform-ops admin …` — operator admin actions (R18 consolidation).
 *
 * `admin reset-password` replaces scripts/admin-password-reset.sh's convenience
 * path: it execs the in-pod entrypoint (deps.resetAdminPassword → native bcrypt
 * in the platform-api pod). The bash script remains as the break-glass for a
 * fully-broken cluster (ADR-045 / R18).
 */
import { randomBytes } from 'node:crypto';
import type { Deps } from './deps.js';

const PW_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PW_LEN = 24;

/** 24-char alphanumeric password (rejection-sampled to avoid modulo bias). */
function generatePassword(): string {
  let out = '';
  while (out.length < PW_LEN) {
    for (const b of randomBytes(PW_LEN)) {
      // 256 % 62 != 0 → drop the top non-uniform bytes to keep it unbiased.
      if (b >= 248) continue;
      out += PW_ALPHABET[b % PW_ALPHABET.length];
      if (out.length === PW_LEN) break;
    }
  }
  return out;
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

async function adminResetPassword(args: string[], deps: Deps): Promise<number> {
  const email = flagValue(args, '--email');
  if (!email) {
    deps.err('admin reset-password: --email <addr> is required');
    return 2;
  }

  let password: string;
  let generated = false;
  if (args.includes('--random')) {
    password = generatePassword();
    generated = true;
  } else {
    // An explicit password is read from STDIN, never an argv flag — a `--password
    // <pw>` flag would leak the cleartext into `ps`/`/proc/<pid>/cmdline` for
    // any co-tenant process. Pipe it: `printf %s pw | platform-ops admin
    // reset-password --email <addr>`. Strip a single trailing newline only.
    password = (await deps.readStdin()).replace(/\r?\n$/, '');
    if (password.length < 1) {
      deps.err('admin reset-password: use --random, or pipe the new password on stdin');
      return 2;
    }
  }

  const out = await deps.resetAdminPassword({ email, password, kubeconfig: flagValue(args, '--kubeconfig') });
  if (!out.ok) {
    deps.err(`admin reset-password: failed${out.errorCode ? ` (${out.errorCode})` : ''}: ${out.detail ?? ''}`);
    return 1;
  }

  deps.out(`Password reset for ${email}${out.userId ? ` (user ${out.userId})` : ''}.`);
  if (generated) {
    // The value is printed on its OWN line with NO leading whitespace — the bash
    // script's 2-space indent is exactly the leading-space trap that broke naive
    // captures. Operators / harnesses can `tail -1` this safely.
    deps.out('Generated password (shown once — save it now):');
    deps.out(password);
  }
  return 0;
}

export async function adminCommand(args: string[], deps: Deps): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'reset-password':
      return adminResetPassword(rest, deps);
    default:
      deps.err(`admin: expected 'reset-password', got ${sub ? `'${sub}'` : 'none'}`);
      return 2;
  }
}
