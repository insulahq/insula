/**
 * Credential redaction for platform-ops operator output (ADR-045 / W17).
 *
 * DR / DB errors can echo a Postgres DSN (`postgres://user:pass@host/db`) or
 * an `age` diagnostic. Strip the `scheme://user:pass@` authority before any
 * message reaches stdout/stderr or a log. Single source of truth so every
 * surface (entrypoint fatal handler, dr-ops detail, dr verify stderr) scrubs
 * identically.
 *
 * Known limitation: this targets the standard `user:pass@host` authority form
 * the platform uses; it does not redact credentials passed as query params
 * (`?password=...`), which this codebase does not emit.
 */
export function scrubCreds(s: string): string {
  return s.replace(/:\/\/[^@\s/]*@/g, '://***@');
}
