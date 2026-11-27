import { describe, expect, it } from 'vitest';
import { redactRepository } from './database-job.js';

describe('redactRepository', () => {
  const repo = 's3:http://backup-shim.platform.svc:9000/tenant/restic/t1';
  it('takes the repository out in every form an error prints it', () => {
    expect(redactRepository(`Fatal: unable to open repository at ${repo}: x`, repo)).toBe('Fatal: unable to open repository at <backup store>: x');
    expect(redactRepository('Get "http://backup-shim.platform.svc:9000/tenant/?location=": dial tcp 10.43.0.17:9000: connect: refused', repo))
      .toBe('Get "<backup store>": dial tcp <address>: connect: refused');
    expect(redactRepository('tenant/restic/t1/config: not found', repo)).toBe('<backup store>: not found');
    expect(redactRepository('backup-shim.platform.svc not reachable', repo)).toBe('<backup store> not reachable');
  });
  it('leaves an ordinary error alone', () => {
    expect(redactRepository("ERROR 1044 (42000): Access denied for user 'dbadmin'@'%'", repo)).toBe("ERROR 1044 (42000): Access denied for user 'dbadmin'@'%'");
  });
});
