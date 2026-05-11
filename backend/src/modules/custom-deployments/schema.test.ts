import { describe, it, expect } from 'vitest';
import {
  CUSTOM_NAME_RE,
  PORT_NAME_RE,
  VOLUME_NAME_RE,
  ENV_NAME_RE,
  RESOURCE_QTY_RE,
  customPortSchema,
  customVolumeMountSchema,
  customEnvSchema,
  customHealthCheckSchema,
  customResourcesSchema,
  customServiceSchema,
  customDeploymentSpecSchema,
  createCustomDeploymentSchema,
  createCustomDeploymentSimpleSchema,
  createCustomDeploymentComposeSchema,
  updateCustomDeploymentSchema,
  customDeploymentIssueSchema,
  submitPullCredentialSchema,
  composeValidateRequestSchema,
} from './schema.js';

// These tests exercise only the Zod surface (shape, ranges, refinements).
// The backend `validator.ts` (PR-2) handles semantic checks like
// "registry reachable", "plan headroom OK", "no `runAsUser:0` without
// `allowRoot`", and the deeper Pod-spec deny-list.

describe('regex contracts', () => {
  it('CUSTOM_NAME_RE accepts DNS-compatible names', () => {
    for (const n of ['a', 'a1', 'web', 'web-prod', 'svc-2-front']) {
      expect(CUSTOM_NAME_RE.test(n)).toBe(true);
    }
  });
  it('CUSTOM_NAME_RE rejects bad names', () => {
    // Note: digit-only names (e.g. '1') ARE valid per RFC 1123 / k8s
    // DNS-label rules — both the catalog's `k8sNameRegex` and CUSTOM_NAME_RE
    // accept them. Don't include them here.
    for (const n of ['', 'A', '-web', 'web-', 'web_prod', 'WEB', '-', 'a'.repeat(64)]) {
      expect(CUSTOM_NAME_RE.test(n)).toBe(false);
    }
  });

  it('PORT_NAME_RE accepts IANA service names', () => {
    for (const n of ['http', 'https', 'p80', 'web-ui', 'api-v1']) {
      expect(PORT_NAME_RE.test(n)).toBe(true);
    }
  });
  it('PORT_NAME_RE rejects all-digit, too-long, or letterless names', () => {
    for (const n of ['', '8080', '12345', 'a'.repeat(16), '-http', 'http-', 'HTTP']) {
      expect(PORT_NAME_RE.test(n)).toBe(false);
    }
  });
  it('PORT_NAME_RE alone allows consecutive hyphens (refinement in customPortSchema rejects them)', () => {
    // The regex permits `a--b`; RFC 6335's consecutive-hyphen rule is
    // enforced via a separate `.refine` on customPortSchema.name —
    // see the customPortSchema test below.
    expect(PORT_NAME_RE.test('a--b')).toBe(true);
  });

  it('VOLUME_NAME_RE accepts a single lowercase segment', () => {
    for (const n of ['data', 'cache', 'html', 'wp-content', 'db_files']) {
      expect(VOLUME_NAME_RE.test(n)).toBe(true);
    }
  });
  it('VOLUME_NAME_RE rejects multi-segment or uppercase names', () => {
    for (const n of ['', '/data', 'data/', 'app/data', 'Data', '.data']) {
      expect(VOLUME_NAME_RE.test(n)).toBe(false);
    }
  });
  it('VOLUME_NAME_RE accepts up to 63 chars and rejects 64', () => {
    expect(VOLUME_NAME_RE.test('a' + 'b'.repeat(62))).toBe(true);  // 63
    expect(VOLUME_NAME_RE.test('a' + 'b'.repeat(63))).toBe(false); // 64
  });

  it('ENV_NAME_RE accepts POSIX env names', () => {
    for (const n of ['HOME', 'PATH', '_X', 'DB_HOST', 'A1', 'a']) {
      expect(ENV_NAME_RE.test(n)).toBe(true);
    }
  });
  it('ENV_NAME_RE rejects leading-digit or hyphenated names', () => {
    for (const n of ['', '1A', 'A-B', 'A.B', 'A B']) {
      expect(ENV_NAME_RE.test(n)).toBe(false);
    }
  });

  it('RESOURCE_QTY_RE accepts k8s quantities', () => {
    for (const q of ['100m', '250m', '1', '0.5', '512Mi', '1Gi', '2Gi', '256Mi']) {
      expect(RESOURCE_QTY_RE.test(q)).toBe(true);
    }
  });
  it('RESOURCE_QTY_RE rejects junk', () => {
    for (const q of ['', '512mb', 'half', '1.', '.5', '1.5.6', 'Gi', '500MiB']) {
      expect(RESOURCE_QTY_RE.test(q)).toBe(false);
    }
  });
});

describe('customPortSchema', () => {
  it('accepts a minimal port', () => {
    expect(customPortSchema.safeParse({ containerPort: 80, name: 'http' }).success).toBe(true);
  });
  it('defaults protocol=TCP, exposeAsService=true, ingressEligible=false', () => {
    const parsed = customPortSchema.parse({ containerPort: 80, name: 'http' });
    expect(parsed.protocol).toBe('TCP');
    expect(parsed.exposeAsService).toBe(true);
    expect(parsed.ingressEligible).toBe(false);
  });
  it('rejects port 0 and 65536', () => {
    expect(customPortSchema.safeParse({ containerPort: 0, name: 'p' }).success).toBe(false);
    expect(customPortSchema.safeParse({ containerPort: 65536, name: 'p' }).success).toBe(false);
  });
  it('rejects bad port name', () => {
    expect(customPortSchema.safeParse({ containerPort: 80, name: '8080' }).success).toBe(false);
  });
  it('rejects consecutive hyphens (RFC 6335)', () => {
    // PORT_NAME_RE accepts 'a--b'; the refinement on customPortSchema.name
    // is what guarantees the RFC 6335 rule reaches the database.
    expect(customPortSchema.safeParse({ containerPort: 80, name: 'a--b' }).success).toBe(false);
  });
});

describe('customVolumeMountSchema', () => {
  it('accepts an absolute mount path', () => {
    expect(customVolumeMountSchema.safeParse({ name: 'data', containerPath: '/var/lib/data' }).success).toBe(true);
  });
  it('rejects relative containerPath', () => {
    expect(customVolumeMountSchema.safeParse({ name: 'data', containerPath: 'data' }).success).toBe(false);
  });
  it('rejects "//", "/./", or ".." in containerPath', () => {
    expect(customVolumeMountSchema.safeParse({ name: 'data', containerPath: '/var//data' }).success).toBe(false);
    expect(customVolumeMountSchema.safeParse({ name: 'data', containerPath: '/var/../etc' }).success).toBe(false);
    expect(customVolumeMountSchema.safeParse({ name: 'data', containerPath: '/etc/./passwd' }).success).toBe(false);
    expect(customVolumeMountSchema.safeParse({ name: 'data', containerPath: '/etc/.' }).success).toBe(false);
  });
  it('rejects system-reserved containerPath roots', () => {
    for (const p of ['/proc/self', '/sys/fs', '/dev/shm/x', '/run/secrets/kubernetes.io/serviceaccount', '/var/run/secrets']) {
      expect(customVolumeMountSchema.safeParse({ name: 'data', containerPath: p }).success).toBe(false);
    }
  });
});

describe('customEnvSchema', () => {
  it('accepts literal value', () => {
    expect(customEnvSchema.safeParse({ name: 'DB_HOST', value: 'localhost' }).success).toBe(true);
  });
  it('accepts a secretRef', () => {
    expect(customEnvSchema.safeParse({ name: 'DB_PW', valueFromSecret: 'db-creds' }).success).toBe(true);
  });
  it('rejects multiple sources at once', () => {
    expect(customEnvSchema.safeParse({ name: 'X', value: 'a', valueFromSecret: 'b' }).success).toBe(false);
  });
  it('rejects zero sources', () => {
    expect(customEnvSchema.safeParse({ name: 'X' }).success).toBe(false);
  });
});

describe('customHealthCheckSchema', () => {
  it('accepts httpGet probe', () => {
    expect(customHealthCheckSchema.safeParse({ type: 'httpGet', path: '/health', port: 80 }).success).toBe(true);
  });
  it('accepts tcpSocket probe', () => {
    expect(customHealthCheckSchema.safeParse({ type: 'tcpSocket', port: 5432 }).success).toBe(true);
  });
  it('accepts exec probe', () => {
    expect(customHealthCheckSchema.safeParse({ type: 'exec', command: ['/bin/healthcheck'] }).success).toBe(true);
  });
  it('rejects exec probe with empty command', () => {
    expect(customHealthCheckSchema.safeParse({ type: 'exec', command: [] }).success).toBe(false);
  });
});

describe('customResourcesSchema', () => {
  it('defaults to 100m / 128Mi', () => {
    const r = customResourcesSchema.parse({});
    expect(r.cpuRequest).toBe('100m');
    expect(r.memoryRequest).toBe('128Mi');
  });
  it('accepts explicit limits', () => {
    expect(customResourcesSchema.safeParse({
      cpuRequest: '250m', memoryRequest: '256Mi',
      cpuLimit: '500m', memoryLimit: '512Mi',
    }).success).toBe(true);
  });
  it('rejects junk', () => {
    expect(customResourcesSchema.safeParse({ cpuRequest: 'one-cpu' }).success).toBe(false);
  });
});

describe('customServiceSchema', () => {
  it('accepts a minimal service', () => {
    const r = customServiceSchema.safeParse({ image: 'nginx:1.27' });
    expect(r.success).toBe(true);
  });
  it('caps env at 200 entries', () => {
    const env = Array.from({ length: 201 }, (_, i) => ({ name: `VAR${i}`, value: 'x' }));
    expect(customServiceSchema.safeParse({ image: 'nginx', env }).success).toBe(false);
  });
  it('rejects empty image', () => {
    expect(customServiceSchema.safeParse({ image: '' }).success).toBe(false);
  });
});

describe('customDeploymentSpecSchema', () => {
  const validSpec = {
    specVersion: 1,
    sourceMode: 'simple' as const,
    services: { web: { image: 'nginx:1.27' } },
    volumes: {},
    configMaps: [],
    secrets: [],
    allowRoot: false,
  };

  it('accepts a minimal single-service spec', () => {
    expect(customDeploymentSpecSchema.safeParse(validSpec).success).toBe(true);
  });
  it('rejects zero services', () => {
    expect(customDeploymentSpecSchema.safeParse({ ...validSpec, services: {} }).success).toBe(false);
  });
  it('rejects more than 10 services', () => {
    const services: Record<string, { image: string }> = {};
    for (let i = 0; i < 11; i++) services[`s${i}`] = { image: 'nginx' };
    expect(customDeploymentSpecSchema.safeParse({ ...validSpec, services }).success).toBe(false);
  });
  it('rejects wrong specVersion', () => {
    expect(customDeploymentSpecSchema.safeParse({ ...validSpec, specVersion: 2 }).success).toBe(false);
  });
});

describe('createCustomDeploymentSimpleSchema', () => {
  it('accepts a minimal simple-form input', () => {
    expect(createCustomDeploymentSimpleSchema.safeParse({
      mode: 'simple',
      name: 'my-app',
      image: 'nginx:1.27',
    }).success).toBe(true);
  });
  it('rejects DNS-incompatible name', () => {
    expect(createCustomDeploymentSimpleSchema.safeParse({
      mode: 'simple', name: 'My_App', image: 'nginx',
    }).success).toBe(false);
  });
  it('rejects unpinned :latest tag at schema level? — no, schema is permissive', () => {
    // Per ADR-036 / user override: no image-pin requirement at any layer.
    // The advisory-badge logic lives in the UI/validator, not the schema.
    expect(createCustomDeploymentSimpleSchema.safeParse({
      mode: 'simple', name: 'web', image: 'nginx:latest',
    }).success).toBe(true);
    expect(createCustomDeploymentSimpleSchema.safeParse({
      mode: 'simple', name: 'web', image: 'nginx',
    }).success).toBe(true);
  });
  it('does NOT expose allow_root on the tenant input (admin-only flag)', () => {
    // Submitted allow_root is silently dropped by Zod's strip-extra
    // behavior. The resulting parsed object must not carry the field.
    const result = createCustomDeploymentSimpleSchema.safeParse({
      mode: 'simple', name: 'web', image: 'nginx',
      allow_root: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('allow_root' in result.data).toBe(false);
    }
  });
});

describe('createCustomDeploymentComposeSchema', () => {
  it('accepts a minimal compose-form input', () => {
    expect(createCustomDeploymentComposeSchema.safeParse({
      mode: 'compose',
      name: 'my-stack',
      compose_yaml: 'services:\n  web:\n    image: nginx:1.27\n',
    }).success).toBe(true);
  });
  it('caps compose_yaml at 256 KiB', () => {
    const huge = 'x'.repeat(256 * 1024 + 1);
    expect(createCustomDeploymentComposeSchema.safeParse({
      mode: 'compose', name: 'big', compose_yaml: huge,
    }).success).toBe(false);
  });
});

describe('createCustomDeploymentSchema (discriminated union)', () => {
  it('discriminates on mode', () => {
    const simple = createCustomDeploymentSchema.safeParse({
      mode: 'simple', name: 'a', image: 'nginx',
    });
    expect(simple.success).toBe(true);
    if (simple.success) expect(simple.data.mode).toBe('simple');

    const compose = createCustomDeploymentSchema.safeParse({
      mode: 'compose', name: 'b', compose_yaml: 'services: {}',
    });
    expect(compose.success).toBe(true);
    if (compose.success) expect(compose.data.mode).toBe('compose');
  });
  it('rejects unknown mode', () => {
    expect(createCustomDeploymentSchema.safeParse({
      mode: 'helm', name: 'x', image: 'nginx',
    }).success).toBe(false);
  });
});

describe('updateCustomDeploymentSchema', () => {
  it('accepts empty patch', () => {
    expect(updateCustomDeploymentSchema.safeParse({}).success).toBe(true);
  });
  it('accepts a restart-only patch', () => {
    expect(updateCustomDeploymentSchema.safeParse({ restart: true }).success).toBe(true);
  });
  it('accepts setting pull_credential_id to null (clear)', () => {
    expect(updateCustomDeploymentSchema.safeParse({ pull_credential_id: null }).success).toBe(true);
  });
});

describe('customDeploymentIssueSchema', () => {
  it('accepts a well-formed issue', () => {
    expect(customDeploymentIssueSchema.safeParse({
      severity: 'error',
      code: 'COMPOSE_FIELD_REJECTED',
      path: 'services.web.privileged',
      message: 'Privileged containers are not permitted on this platform.',
    }).success).toBe(true);
  });
  it('rejects lowercase code', () => {
    expect(customDeploymentIssueSchema.safeParse({
      severity: 'error', code: 'bad_code', path: 'x', message: 'y',
    }).success).toBe(false);
  });
});

describe('submitPullCredentialSchema', () => {
  it('accepts ghcr.io credentials', () => {
    expect(submitPullCredentialSchema.safeParse({
      registry_host: 'ghcr.io', username: 'sb', token: 'ghp_xxxxxxxxxxxx',
    }).success).toBe(true);
  });
  it('rejects schemes in registry_host', () => {
    expect(submitPullCredentialSchema.safeParse({
      registry_host: 'https://ghcr.io', username: 'sb', token: 't',
    }).success).toBe(false);
  });
  it('rejects path in registry_host', () => {
    expect(submitPullCredentialSchema.safeParse({
      registry_host: 'ghcr.io/owner', username: 'sb', token: 't',
    }).success).toBe(false);
  });
  it('rejects empty token', () => {
    expect(submitPullCredentialSchema.safeParse({
      registry_host: 'ghcr.io', username: 'sb', token: '',
    }).success).toBe(false);
  });
});

describe('composeValidateRequestSchema', () => {
  it('accepts a minimal validate request', () => {
    expect(composeValidateRequestSchema.safeParse({
      compose_yaml: 'services: {}',
    }).success).toBe(true);
  });
  it('accepts env_files map', () => {
    expect(composeValidateRequestSchema.safeParse({
      compose_yaml: 'services: {}',
      env_files: { '.env': 'KEY=value\n' },
    }).success).toBe(true);
  });
});
