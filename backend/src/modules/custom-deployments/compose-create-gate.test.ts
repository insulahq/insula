import { describe, expect, it } from 'vitest';
import { parseCompose } from './compose-parser.js';
import { composeSpecForCreate } from './compose-create-gate.js';

const parse = (composeYaml: string) => parseCompose({ composeYaml });

describe('composeSpecForCreate — create refuses what Validate refuses', () => {
  it('passes a clean stack through', () => {
    const yaml = 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "80"\n';
    expect(composeSpecForCreate(parse(yaml), yaml).services.web?.image).toBe('nginx:1.27');
  });

  it('★ refuses cap_add: SYS_ADMIN instead of building the stack without it', () => {
    const yaml = 'services:\n  collabora:\n    image: collabora/code:25.04\n    cap_add:\n      - SYS_ADMIN\n';
    const parsed = parse(yaml);
    // The parser still returns a spec — with the capability dropped. That spec
    // is what create used to deploy.
    expect(parsed.spec?.services.collabora?.capAdd).toEqual([]);
    let thrown: unknown;
    try { composeSpecForCreate(parsed, yaml); } catch (e) { thrown = e; }
    expect(thrown).toMatchObject({
      code: 'CUSTOM_DEPLOYMENT_INVALID',
      status: 422,
      message: expect.stringContaining("Compose field 'cap_add' is not supported"),
    });
    const issues = (thrown as { details: { issues: Array<{ path: string; line?: number }> } }).details.issues;
    expect(issues.find((i) => i.path === 'services.collabora.cap_add')).toMatchObject({ line: 4 });
  });

  it.each([
    ['privileged: true', 'privileged'],
    ['mem_limit: 2g', 'mem_limit'],
    ['devices:\n      - /dev/fuse', 'devices'],
  ])('refuses %s', (field, path) => {
    const yaml = `services:\n  app:\n    image: busybox:1.36\n    ${field}\n`;
    expect(() => composeSpecForCreate(parse(yaml), yaml)).toThrow(new RegExp(`'${path}' is not supported`));
  });

  it('refuses YAML that yields no spec at all', () => {
    const yaml = 'services: {}\n';
    expect(() => composeSpecForCreate(parse(yaml), yaml)).toThrow();
  });
});
