import { describe, it, expect, vi, beforeEach } from 'vitest';

// The sqlite3 CLI runs in the file-manager pod; mock the k8s exec it goes through.
const mockExecFn = vi.fn();
vi.mock('@kubernetes/client-node', () => {
  class MockKubeConfig {
    loadFromFile = vi.fn();
    loadFromCluster = vi.fn();
  }
  class MockExec {
    exec = mockExecFn;
  }
  return { KubeConfig: MockKubeConfig, Exec: MockExec };
});

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { browseTable, countRows, describeTable } from './service.js';

const k8s = {
  core: {
    listNamespacedPod: vi.fn().mockResolvedValue({
      items: [{ metadata: { name: 'file-manager-0' }, status: { phase: 'Running' } }],
    }),
  },
} as unknown as K8sClients;

function answer(stdout: string, stderr = ''): void {
  mockExecFn.mockImplementation(
    (
      _ns: string, _pod: string, _container: string, _command: string[],
      stdoutStream: NodeJS.WritableStream, stderrStream: NodeJS.WritableStream,
      _stdin: null, _tty: boolean, callback: (status: Record<string, unknown>) => void,
    ) => {
      if (stdout) stdoutStream.write(Buffer.from(stdout));
      if (stderr) stderrStream.write(Buffer.from(stderr));
      setTimeout(() => callback({ status: 'Success' }), 0);
      return Promise.resolve({});
    },
  );
}

const sqlArg = (): string => (mockExecFn.mock.calls[0][3] as string[]).at(-1) as string;

describe('sqlite service — existing table names and missing tables', () => {
  beforeEach(() => {
    mockExecFn.mockReset();
  });

  it('browses a hyphenated table, quoted as an SQL identifier', async () => {
    answer('id,name\n1,"a\\b"\n');

    const result = await browseTable(k8s, undefined, 'ns', 'app/data.db', '1-StudentsTb', { orderBy: 'first name' });

    expect(sqlArg()).toBe('SELECT * FROM "1-StudentsTb" ORDER BY "first name" ASC LIMIT 50 OFFSET 0');
    expect(result.rows).toEqual([['1', 'a\\b']]);
  });

  // A table renamed or dropped since the list loaded: 404, not a 500 platform fault.
  it.each([
    ['browse', () => browseTable(k8s, undefined, 'ns', 'app/data.db', 'gone')],
    ['describe', () => describeTable(k8s, undefined, 'ns', 'app/data.db', 'gone')],
    ['count', () => countRows(k8s, undefined, 'ns', 'app/data.db', 'gone')],
  ])('%s of a missing table answers 404 TABLE_NOT_FOUND', async (_label, call) => {
    answer('', 'Error: in prepare, no such table: gone (1)\n');

    await expect(call()).rejects.toMatchObject({ code: 'TABLE_NOT_FOUND', status: 404 });
  });

  it('keeps any other SQLite failure a 500 SQLITE_ERROR', async () => {
    answer('', 'Error: stepping, database is locked (5)\n');

    await expect(countRows(k8s, undefined, 'ns', 'app/data.db', 't')).rejects.toMatchObject({
      code: 'SQLITE_ERROR', status: 500,
    });
  });
});
