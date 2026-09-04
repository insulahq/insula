import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCompose } from './compose-parser.js';
import { validateCustomSpec } from './validator.js';
import { createCustomDeploymentComposeSchema } from './schema.js';

/**
 * The compose editor ships a pre-filled starter stack. It is the first thing
 * every tenant sees and the first thing they click **Validate** on, so it has
 * to come back completely clean — and twice now it has not:
 *
 *   · `http://localhost/health` in its healthcheck was blocked outright by CRS
 *     934190, so the untouched default could not be validated OR created.
 *   · `traefik/whoami:latest` tripped the platform's own UNPINNED_TAG_ADVISORY,
 *     so the starter greeted every tenant with a warning about itself.
 *
 * Both were the same shape: the platform's own default violating the
 * platform's own rules. This test reads the template out of the TSX and runs
 * it through the real parser and validator, so the two artifacts cannot drift
 * apart again.
 *
 * If this fails, fix the template — do not relax the assertion.
 */
const EDITOR_TSX = '../frontend/tenant-panel/src/components/custom-deployments/ComposeEditor.tsx';

function shippedTemplate(): string {
  const tsx = readFileSync(EDITOR_TSX, 'utf8');
  const m = /const DEFAULT_COMPOSE = `([\s\S]*?)`;/.exec(tsx);
  if (!m) throw new Error('DEFAULT_COMPOSE not found in ComposeEditor.tsx');
  return m[1];
}

describe('the shipped compose starter template', () => {
  const parsed = parseCompose({ composeYaml: shippedTemplate() });

  it('parses with no errors and no warnings', () => {
    expect(parsed.spec).not.toBeNull();
    // Assert on the whole issue list, not a count — a failure then names the
    // offending code and path instead of just "expected 0, got 1".
    expect(parsed.issues).toEqual([]);
  });

  it('passes the semantic validator clean, including the unpinned-tag advisory', () => {
    const result = validateCustomSpec(parsed.spec!, {
      callerRole: 'tenant',
      // The advisory is what `traefik/whoami:latest` used to trip. Validate
      // with it ON — that is how a real tenant's create runs when the operator
      // leaves the default setting alone.
      warnUnpinnedTags: true,
      singleServiceOnly: false,
      deploymentName: 'starter',
    });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // The template's comments promise specific numbers; if someone edits the
  // YAML without the prose (or vice versa) the starter starts lying.
  it('produces the resources its own comments advertise', () => {
    const svc = parsed.spec!.services;
    expect(svc.web.resources).toEqual({
      cpuRequest: '100m', memoryRequest: '128Mi',
      cpuLimit: '500m', memoryLimit: '512Mi',
    });
    // cache declares limits only — they must mirror into the requests.
    expect(svc.cache.resources).toEqual({
      cpuRequest: '250m', memoryRequest: '256Mi',
      cpuLimit: '250m', memoryLimit: '256Mi',
    });
  });

  it('pins every image to an immutable-looking tag', () => {
    for (const [name, svc] of Object.entries(parsed.spec!.services)) {
      expect(svc.image, `${name} must not use a moving tag`).not.toMatch(/:latest$/);
      expect(svc.image, `${name} must carry an explicit tag`).toMatch(/:.+$/);
    }
  });
});

/**
 * The layer the test above does NOT cover, and which is where the starter
 * actually broke in production.
 *
 * Running the template through the parser proves the YAML is fine. It says
 * nothing about the REQUEST the editor sends — and the editor sent
 * `name: ""`, because `name` is `.optional()` (which accepts `undefined`, not
 * an empty string) and `buildInput()` always included the field. So an
 * untouched editor's first click on Validate returned
 * "Invalid string: must match pattern /^[a-z0-9]…/" about a field the tenant
 * had never touched. Green parser tests, broken feature.
 *
 * These assert the body shape instead of the YAML.
 */
describe('the compose validate request body', () => {
  const compose_yaml = 'services:\n  web:\n    image: nginx:1.27.3\n';

  it('parses when `name` is OMITTED — the untouched-editor case', () => {
    const r = createCustomDeploymentComposeSchema.safeParse({ mode: 'compose', compose_yaml });
    expect(r.success).toBe(true);
  });

  // This is the bug, pinned. If it ever passes, `.optional()` has been changed
  // to tolerate '' and the editor's omit-when-blank logic can be dropped —
  // until then, the editor MUST NOT send a blank name.
  it('REJECTS an empty-string `name`, which is why the editor omits it', () => {
    const r = createCustomDeploymentComposeSchema.safeParse({ mode: 'compose', name: '', compose_yaml });
    expect(r.success).toBe(false);
  });

  it('accepts a real name', () => {
    const r = createCustomDeploymentComposeSchema.safeParse({ mode: 'compose', name: 'my-stack', compose_yaml });
    expect(r.success).toBe(true);
  });

  // The message a tenant reads must describe the rule, not dump the regex.
  it('explains what a valid name looks like instead of printing the pattern', () => {
    const r = createCustomDeploymentComposeSchema.safeParse({ mode: 'compose', name: 'Bad Name', compose_yaml });
    expect(r.success).toBe(false);
    const msg = r.success ? '' : r.error.issues.map((i) => i.message).join(' ');
    expect(msg).toContain('DNS-compatible');
    expect(msg).not.toContain('must match pattern');
  });

  it('the shipped template itself passes the request schema with no name', () => {
    const r = createCustomDeploymentComposeSchema.safeParse({
      mode: 'compose', compose_yaml: shippedTemplate(),
    });
    expect(r.success).toBe(true);
  });
});
