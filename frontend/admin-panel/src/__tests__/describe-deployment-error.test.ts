import { describe, it, expect } from 'vitest';
import { describeDeploymentError } from '../lib/describe-deployment-error';

/**
 * The fixture is the production rejection that started this, with the tenant
 * namespace redacted (the repo is public).
 */
const QUOTA_MESSAGE =
  'pods "moodle-7f8b79576f-9lrtv" is forbidden: exceeded quota: tenant-example-quota, ' +
  'requested: limits.memory=512Mi,requests.memory=512Mi, ' +
  'used: limits.memory=544Mi,requests.memory=544Mi, ' +
  'limited: limits.memory=1Gi,requests.memory=1Gi';

/** What the Kubernetes client actually throws — the whole HTTP response. */
const RAW_K8S_BODY =
  'HTTP-Code: 403\nMessage: Forbidden\nBody: ' +
  JSON.stringify({
    kind: 'Status',
    apiVersion: 'v1',
    status: 'Failure',
    message: QUOTA_MESSAGE,
    reason: 'Forbidden',
    code: 403,
  });

describe('describeDeploymentError — quota', () => {
  it('reads the numbers out of the raw Kubernetes Status body', () => {
    const e = describeDeploymentError(RAW_K8S_BODY);
    expect(e.code).toBe('QUOTA_EXCEEDED');
    expect(e.diagnostics).toMatchObject({
      'Memory requested': '512Mi',
      'Memory already reserved': '544Mi',
      'Memory limit': '1Gi',
      'Memory quota key': 'limits.memory',
      'Memory free': '480Mi',
      'Memory short by': '32Mi',
      Reason: 'Forbidden',
      'HTTP status': 403,
    });
  });

  it('states the problem in a sentence, with no JSON in it', () => {
    const e = describeDeploymentError(RAW_K8S_BODY);
    expect(e.detail).toBe(
      'This app asks for 512Mi of memory. Of the 1Gi your plan allows, 480Mi is free '
      + '— 544Mi is already reserved.',
    );
    expect(e.detail).not.toContain('{');
    expect(e.detail).not.toContain('kind');
    expect(e.title).toBe('Not enough memory in your plan');
  });

  it('names the exact shortfall in the first remediation step', () => {
    const e = describeDeploymentError(RAW_K8S_BODY);
    expect(e.remediation[0]).toContain('32Mi');
  });

  // Retrying cannot succeed until something is freed, and ErrorPanel only
  // renders its Retry button for retryable errors.
  it('is not retryable', () => {
    expect(describeDeploymentError(RAW_K8S_BODY).retryable).toBe(false);
  });

  // Nothing may be lost: operators paste this into support tickets.
  it('keeps the raw string as a details row', () => {
    const e = describeDeploymentError(RAW_K8S_BODY);
    expect(e.diagnostics?.['Raw error']).toBe(RAW_K8S_BODY.trim());
  });

  // Tenant workloads set request == limit (ADR-037), so Kubernetes lists
  // memory twice. The table must not say "Memory" twice.
  it('reports one row per resource, not one per quota key', () => {
    const e = describeDeploymentError(QUOTA_MESSAGE);
    const memoryKeys = Object.keys(e.diagnostics ?? {}).filter((k) => k.startsWith('Memory '));
    expect(memoryKeys).toHaveLength(6);
  });

  it('handles a CPU rejection in cores, not bytes', () => {
    const e = describeDeploymentError(
      'pods "x" is forbidden: exceeded quota: q, requested: requests.cpu=500m, ' +
      'used: requests.cpu=700m, limited: requests.cpu=1',
    );
    expect(e.title).toBe('No CPU reservation left for this app');
    expect(e.diagnostics).toMatchObject({
      'CPU requested': '500m',
      'CPU free': '300m',
      'CPU short by': '200m',
    });
  });

  /**
   * ★ The two CPU quota keys are different budgets and the tenant has to be
   * able to tell which one refused them.
   *
   * Reported from production: "This app asks for 1 of cpu, but only 0m of
   * your 2 plan is free — 2 is already in use", against a tenant whose usage
   * page showed almost no CPU at all. Every number in it was right and the
   * sentence was still unusable — no units on two of the three, no noun after
   * "your 2", and "in use" for something nothing was using.
   */
  it('names which CPU budget is exhausted — the ceiling', () => {
    const e = describeDeploymentError(
      'pods "db-0" is forbidden: exceeded quota: tenant-example-quota, ' +
      'requested: limits.cpu=1, used: limits.cpu=2, limited: limits.cpu=2',
    );
    expect(e.title).toBe('No CPU ceiling left for this app');
    expect(e.detail).toContain('1 core of CPU ceiling');
    expect(e.detail).toContain('2 cores are already committed');
    expect(e.detail).toContain('charged its full burst ceiling');
    expect(e.diagnostics).toMatchObject({ 'CPU ceiling quota key': 'limits.cpu' });
    // Shrinking the app cannot help: the ceiling comes from the plan.
    expect(e.remediation.join(' ')).not.toContain('shrinking');
  });

  it('names which CPU budget is exhausted — the reservation', () => {
    const e = describeDeploymentError(
      'pods "db-0" is forbidden: exceeded quota: tenant-example-quota, ' +
      'requested: requests.cpu=1, used: requests.cpu=2, limited: requests.cpu=2',
    );
    expect(e.title).toBe('No CPU reservation left for this app');
    expect(e.detail).toContain('1 core of reserved CPU');
    expect(e.detail).toContain('Reserved is not the same as in use');
    expect(e.diagnostics).toMatchObject({ 'CPU quota key': 'requests.cpu' });
  });

  // Every quantity in the sentence carries a unit, or none of them can be
  // compared. "only 0m of your 2 plan" mixed a formatted number with a raw
  // one and read as nonsense.
  it('gives every number in the sentence a unit', () => {
    const e = describeDeploymentError(
      'pods "x" is forbidden: exceeded quota: q, requested: requests.cpu=1, ' +
      'used: requests.cpu=2, limited: requests.cpu=2',
    );
    for (const bare of [' 1.', ' 1 ', ' 2 ', ' 2.']) {
      expect(e.detail.replace(/\d+ cores?/g, 'N').replace(/\d+m/g, 'N')).not.toContain(bare);
    }
  });

  // A quantity in subject position has to agree with its verb.
  it('agrees in number', () => {
    const one = describeDeploymentError(
      'pods "x" is forbidden: exceeded quota: q, requested: requests.cpu=1, ' +
      'used: requests.cpu=1, limited: requests.cpu=1',
    );
    expect(one.detail).toContain('1 core is already reserved');
    const many = describeDeploymentError(
      'pods "x" is forbidden: exceeded quota: q, requested: requests.cpu=1, ' +
      'used: requests.cpu=2, limited: requests.cpu=2',
    );
    expect(many.detail).toContain('2 cores are already reserved');
  });

  // The backend pre-formats some of these, and deployments still carry the
  // older wording it used in their stored lastError.
  it('decodes the backend wording, old and new, to the same budget', () => {
    const envelope = (detail: string) => JSON.stringify({
      code: 'QUOTA_EXCEEDED', title: 'Quota exceeded', detail,
    });
    const old = describeDeploymentError(envelope(
      'Quota exceeded — CPU limit: requesting 1, already using 2 of 2 limit.',
    ));
    const now = describeDeploymentError(envelope(
      'Quota exceeded — CPU limit: requesting 1, already claimed 2 of 2 limit.',
    ));
    expect(old.title).toBe('No CPU ceiling left for this app');
    expect(now.title).toBe(old.title);
    expect(now.detail).toBe(old.detail);
  });

  it('keeps the two CPU budgets apart in the formatted wording too', () => {
    const e = describeDeploymentError(JSON.stringify({
      code: 'QUOTA_EXCEEDED',
      title: 'Quota exceeded',
      detail: 'Quota exceeded — CPU request: requesting 1, already claimed 2 of 2 limit.',
    }));
    expect(e.title).toBe('No CPU reservation left for this app');
  });

  it('switches the title when more than one resource is exhausted', () => {
    const e = describeDeploymentError(
      'pods "x" is forbidden: exceeded quota: q, requested: requests.cpu=500m,requests.memory=512Mi, ' +
      'used: requests.cpu=700m,requests.memory=544Mi, limited: requests.cpu=1,requests.memory=1Gi',
    );
    expect(e.title).toBe('Plan limit reached');
    expect(e.diagnostics).toMatchObject({ 'CPU requested': '500m', 'Memory requested': '512Mi' });
  });
});

describe('describeDeploymentError — everything else', () => {
  it('unwraps a non-quota Kubernetes failure to its message', () => {
    const raw = 'HTTP-Code: 404\nBody: ' + JSON.stringify({
      kind: 'Status', message: 'deployments.apps "web" not found', reason: 'NotFound', code: 404,
    });
    const e = describeDeploymentError(raw);
    expect(e.code).toBe('DEPLOYMENT_FAILED');
    expect(e.detail).toBe('deployments.apps "web" not found');
    expect(e.diagnostics).toMatchObject({ Reason: 'NotFound', 'HTTP status': 404 });
    expect(e.retryable).toBe(true);
  });

  it('passes a plain message through untouched', () => {
    const e = describeDeploymentError('ImagePullBackOff: manifest unknown');
    expect(e.detail).toBe('ImagePullBackOff: manifest unknown');
  });

  // A failed JSON.parse must cost the operator nothing — the message itself is
  // more useful than an empty panel.
  it('keeps the text when a brace makes it look like JSON but it is not', () => {
    const e = describeDeploymentError('config error near { "port"');
    expect(e.detail).toBe('config error near { "port"');
  });
});

// ── The shape the platform actually stores ───────────────────────────────────
//
// `lastError` is usually NOT a raw Kubernetes body: the status reconciler
// writes its own OperatorError envelope there, JSON-encoded. Decoding only the
// Kubernetes shape meant a quota rejection reached the card as
// `{"code":"UNKNOWN","title":"Operation failed",…}` — the same unreadable JSON,
// through another door. This fixture is the exact string DEV stored for a
// deployment refused on memory.
const STORED_ENVELOPE = JSON.stringify({
  code: 'UNKNOWN',
  title: 'Operation failed',
  detail: 'Quota exceeded — memory limit: requesting 512Mi, already using 1792Mi of 2Gi limit; '
    + 'memory request: requesting 2Gi, already using 2Gi of 2Gi limit; used: limits.memory: 1792Mi; '
    + 'limited: limits.memory: 2Gi. Free up resources or upgrade the p',
  remediation: ['Open "More details" below for the upstream message.'],
  retryable: true,
  diagnostics: {
    raw: 'Quota exceeded — memory limit: requesting 512Mi, already using 1792Mi of 2Gi limit; '
      + 'memory request: requesting 2Gi, already using 2Gi of 2Gi limit; used: limits.memory: 1792Mi; '
      + 'limited: limits.memory: 2Gi. Free up resources or upgrade the plan.',
  },
});

describe('describeDeploymentError — the stored OperatorError envelope', () => {
  it('never puts the envelope’s JSON on screen', () => {
    const e = describeDeploymentError(STORED_ENVELOPE);
    expect(e.detail).not.toContain('{');
    expect(e.detail).not.toContain('"code"');
    expect(e.detail).not.toContain('retryable');
  });

  it('recognises the quota rejection inside it and states it plainly', () => {
    const e = describeDeploymentError(STORED_ENVELOPE);
    expect(e.code).toBe('QUOTA_EXCEEDED');
    expect(e.title).toBe('Not enough memory in your plan');
    expect(e.detail).toBe(
      'This app asks for 512Mi of memory. Of the 2Gi your plan allows, 256Mi is free '
      + '— 1.75Gi is already reserved.',
    );
  });

  it('builds the same table from the formatted text as from the raw one', () => {
    const e = describeDeploymentError(STORED_ENVELOPE);
    expect(e.diagnostics).toMatchObject({
      'Memory requested': '512Mi',
      'Memory already reserved': '1792Mi',
      'Memory limit': '2Gi',
      'Memory free': '256Mi',
      'Memory short by': '256Mi',
    });
  });

  // `detail` is capped at 240 chars upstream and stops mid-word ("upgrade the
  // p"); diagnostics.raw is whole.
  it('reads the untruncated message, not the capped one', () => {
    const e = describeDeploymentError(STORED_ENVELOPE);
    expect(e.detail).not.toContain('upgrade the p');
    expect(e.diagnostics?.['Raw error']).toBe(STORED_ENVELOPE);
  });

  it('is not retryable — retrying frees nothing', () => {
    expect(describeDeploymentError(STORED_ENVELOPE).retryable).toBe(false);
  });

  it('passes a non-quota envelope through with its own advice intact', () => {
    const env = JSON.stringify({
      code: 'IMAGE_PULL_FAILED', title: 'Image could not be pulled',
      detail: 'manifest unknown', remediation: ['Check the image tag.'],
      retryable: true, diagnostics: { raw: 'ErrImagePull: manifest unknown' },
    });
    const e = describeDeploymentError(env);
    expect(e.code).toBe('IMAGE_PULL_FAILED');
    expect(e.title).toBe('Image could not be pulled');
    expect(e.detail).toBe('manifest unknown');
    expect(e.remediation).toEqual(['Check the image tag.']);
    expect(e.diagnostics).toMatchObject({ raw: 'ErrImagePull: manifest unknown', 'Raw error': env });
  });

  // Not every brace-leading string is an envelope.
  it('still handles a bare Kubernetes Status body', () => {
    const k8s = JSON.stringify({ kind: 'Status', message: 'deployments.apps "web" not found', reason: 'NotFound', code: 404 });
    const e = describeDeploymentError(k8s);
    expect(e.detail).toBe('deployments.apps "web" not found');
  });
});
