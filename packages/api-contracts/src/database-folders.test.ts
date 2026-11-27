import { describe, it, expect } from 'vitest';
import {
  DATABASE_ROOT_PROBLEM,
  canonicalDatabasePath,
  isUnderDatabaseRoot,
} from './database-folders.js';
import { extraMountSchema, folderProblem } from './extra-mounts.js';
import { createSftpUserSchema, updateSftpUserSchema } from './sftp-users.js';
import { createDeploymentSchema, updateDeploymentSchema } from './catalog.js';

describe('isUnderDatabaseRoot', () => {
  it.each(['database', 'database/', '/database', 'database/mariadb/shop', '//database//x', './database/x', '/./database'])(
    'is true for %j', (p) => expect(isUnderDatabaseRoot(p)).toBe(true),
  );
  it.each(['databases/shop', 'kept-databases/shop', 'Database/x', 'public_html/database', '', '/'])(
    'is false for %j', (p) => expect(isUnderDatabaseRoot(p)).toBe(false),
  );
});

describe('canonicalDatabasePath', () => {
  it('is database/<code>/<name>', () => {
    expect(canonicalDatabasePath('mariadb', 'shop')).toBe('database/mariadb/shop');
  });
});

describe('the protected folder in tenant-named folders', () => {
  it.each(['database', 'database/mariadb', 'database/mariadb/shop'])('folderProblem refuses %j', (f) => {
    expect(folderProblem(f)).toBe(DATABASE_ROOT_PROBLEM);
  });
  it.each(['databases/shop', 'kept-databases/shop', 'public_html/database'])('folderProblem allows %j', (f) => {
    expect(folderProblem(f)).toBeNull();
  });
  it('refuses an extra mount of a database folder', () => {
    const r = extraMountSchema.safeParse({ folder: 'database/postgresql/app', mount_path: '/srv/db' });
    expect(r.success).toBe(false);
  });
  it('refuses a storage path in the protected folder, on create and on update', () => {
    expect(updateDeploymentSchema.safeParse({ storage_path: 'database/mariadb/x' }).success).toBe(false);
    const create = createDeploymentSchema.safeParse({ storage_path: 'database/x' });
    expect(create.success).toBe(false);
    expect(create.error?.issues.some((i) => i.path[0] === 'storage_path' && i.message === DATABASE_ROOT_PROBLEM)).toBe(true);
  });
  const sftpUser = { auth_method: 'password', description: 'deploy' } as const;
  it.each(['/database', 'database/mariadb/shop', '/database/'])('refuses SFTP home path %j', (home) => {
    expect(createSftpUserSchema.safeParse({ ...sftpUser, home_path: home }).success).toBe(false);
    expect(updateSftpUserSchema.safeParse({ home_path: home }).success).toBe(false);
  });
  it('keeps other SFTP home paths', () => {
    expect(createSftpUserSchema.safeParse({ ...sftpUser, home_path: '/public_html' }).success).toBe(true);
    expect(updateSftpUserSchema.safeParse({ home_path: '/kept-databases/shop' }).success).toBe(true);
  });
});
