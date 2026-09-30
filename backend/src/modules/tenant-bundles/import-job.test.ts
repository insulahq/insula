import { describe, it, expect } from 'vitest';

import {
  assertSafeUnitName,
  assertSafeArchivePath,
  buildImportScript,
  buildImportJobSpec,
  parseImportUnitResults,
  parseImportObjectResults,
  importCompleted,
  assertSafeArtifactName,
  repoUriKey,
  IMPORT_CREDS_MOUNT_PATH,
  unitStagePath,
  IMPORT_STAGE_ROOT,
  IMPORT_SOURCE_ROOT,
  type BuildImportJobInput,
  type ImportUnit,
  type ImportObjectUpload,
} from './import-job.js';

const UNITS: ImportUnit[] = [
  { component: 'files', name: 'archive', sizeBytes: 1024 },
  { component: 'mailboxes', name: 'user@example.test', sizeBytes: 2048 },
];

const BASE: BuildImportJobInput = {
  jobName: 'import-abc',
  namespace: 'tenant-example-1234abcd',
  tenantId: 't-1',
  importId: 'imp-1',
  bundleId: 'bkp-1',
  pvcName: 'tenant-files',
  archiveRelPath: '.insula-imports/imp-1.tar.gz',
  units: UNITS,
  credsSecretName: 'import-creds',
  stageSizeLimit: '8Gi',
};

describe('assertSafeUnitName', () => {
  it('accepts the only two legitimate shapes', () => {
    expect(() => assertSafeUnitName('archive')).not.toThrow();
    expect(() => assertSafeUnitName('first.last+tag@example.test')).not.toThrow();
  });

  it('refuses traversal and shell metacharacters rather than escaping them', () => {
    // These reach a shell command line inside a pod that has the tenant's file
    // space mounted. An archive containing one is malformed or hostile.
    for (const bad of [
      '../../etc/passwd', 'a/b', '..', '.', 'a..b',
      "a';rm -rf /;'", 'a$(id)', 'a`id`', 'a|b', 'a;b', 'a b', 'a\nb', 'a\0b', '',
    ]) {
      expect(() => assertSafeUnitName(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('refuses an implausibly long name', () => {
    expect(() => assertSafeUnitName('a'.repeat(321))).toThrow(/implausible length/);
  });
});

describe('assertSafeArchivePath', () => {
  it('accepts a path inside the upload directory', () => {
    expect(() => assertSafeArchivePath('.insula-imports/imp-1.tar.gz')).not.toThrow();
  });

  it('refuses anything outside it, or traversing out of it', () => {
    // A traversal here would let the Job read any file on the tenant PVC into a
    // restic snapshot.
    for (const bad of [
      'imp-1.tar.gz', '/etc/passwd', '.insula-imports/../../etc/passwd',
      '.insula-imports/sub/dir.tar.gz', '.insula-imports/', '.insula-importsX/a.tar.gz',
      '.insula-imports/a;b', '.insula-imports/..',
    ]) {
      expect(() => assertSafeArchivePath(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('buildImportScript', () => {
  const script = buildImportScript(BASE);

  it('reads the archive off the mounted PVC, not over the network', () => {
    // The ARCHIVE is never fetched over the network — the chunked upload
    // already put it on the PVC, so there is no second transfer of the bulk.
    expect(script).toContain(`${IMPORT_SOURCE_ROOT}/.insula-imports/imp-1.tar.gz`);
    expect(script).toContain(`tar -xzf "$ARCHIVE" -C ${IMPORT_STAGE_ROOT}`);
    expect(script).not.toMatch(/curl[^\n]*\$ARCHIVE/);
    // With no object artifacts there is no network egress at all.
    expect(script).not.toContain('curl');
  });

  it('fails when the archive is absent instead of producing an empty import', () => {
    expect(script).toMatch(/\[ -f "\$ARCHIVE" \] \|\| \{ echo "ERROR: uploaded archive not found/);
  });

  it('asserts every promised unit landed before touching the repo', () => {
    // /bin/sh is dash — no pipefail — so a short read can leave tar exiting 0.
    // Unit presence is the completeness signal, and it must be checked BEFORE
    // the first restic call or a truncated archive writes a partial snapshot.
    const firstBackup = script.indexOf('restic -r "$REPO" backup');
    for (const u of UNITS) {
      const assertIdx = script.indexOf(`[ -e '${unitStagePath(u)}' ]`);
      expect(assertIdx, u.name).toBeGreaterThan(-1);
      expect(assertIdx).toBeLessThan(firstBackup);
    }
  });

  it('tags every snapshot with the import id so a failed run is prunable', () => {
    // Partial snapshots from a failed import have to be findable; the tag is
    // the only handle, because no rows are written until every unit succeeds.
    const tagCount = script.match(/--tag 'import=imp-1'/g) ?? [];
    expect(tagCount).toHaveLength(UNITS.length);
  });

  it('deletes each unit after its backup so peak staging falls', () => {
    for (const u of UNITS) {
      const backupIdx = script.indexOf(`backup '${unitStagePath(u)}'`);
      const rmIdx = script.indexOf(`rm -rf '${unitStagePath(u)}'`);
      expect(rmIdx, u.name).toBeGreaterThan(backupIdx);
    }
  });

  it('accepts restic exit 3 but nothing else, matching capture', () => {
    // 3 means some files were unreadable but a valid snapshot was written.
    expect(script).toContain('[ "$RC" = "3" ] && echo "WARN: restic backup completed with partial read errors (exit 3)"');
    expect(script).toContain('{ [ "$RC" = "0" ] || [ "$RC" = "3" ]; } ||');
  });

  it('requires a 64-hex snapshot id from restic before reporting a unit done', () => {
    expect(script).toContain('"snapshot_id":"[0-9a-f]\\{64\\}"');
    expect(script).toContain('[ -n "$SNAP" ] || { echo "ERROR: no snapshot_id in restic output"');
  });

  it('★ reads a SEPARATE repo URI per component', () => {
    // Under the `per-component` layout `files` and `mailboxes` are different
    // repositories. One shared $REPO would write the mailbox snapshots where
    // no restore path looks — and the import would still report success.
    expect(script).toContain(`${IMPORT_CREDS_MOUNT_PATH}/repo_uri_files`);
    expect(script).toContain(`${IMPORT_CREDS_MOUNT_PATH}/repo_uri_mailboxes`);
    expect(repoUriKey('files')).toBe('repo_uri_files');
    expect(repoUriKey('mailboxes')).toBe('repo_uri_mailboxes');
    // and never a single component-less key
    expect(script).not.toMatch(/repo_uri"\)/);
  });

  it('fails the unit when its repo URI is absent instead of backing up nowhere', () => {
    expect(script).toMatch(/\[ -n "\$REPO" \] \|\| \{ echo "ERROR: repo uri missing for files/);
  });

  it('refuses to build at all for a hostile unit name', () => {
    expect(() => buildImportScript({ ...BASE, units: [{ component: 'files', name: "a';id;'", sizeBytes: 1 }] }))
      .toThrow(/unexpected characters/);
  });
});

describe('buildImportJobSpec', () => {
  const job = buildImportJobSpec(BASE) as Record<string, any>;
  const pod = job.spec.template.spec;

  it('mounts the tenant PVC READ-ONLY', () => {
    // The import reads one archive. It must never be able to mutate tenant
    // files, whatever the archive contains.
    const mount = pod.containers[0].volumeMounts.find((m: any) => m.name === 'source');
    expect(mount).toMatchObject({ mountPath: IMPORT_SOURCE_ROOT, readOnly: true });
    const vol = pod.volumes.find((v: any) => v.name === 'source');
    expect(vol.persistentVolumeClaim).toMatchObject({ claimName: 'tenant-files', readOnly: true });
  });

  it('bounds staging with a sizeLimit so an under-declared manifest evicts the Job, not the node', () => {
    const stage = pod.volumes.find((v: any) => v.name === 'stage');
    expect(stage.emptyDir.sizeLimit).toBe('8Gi');
  });

  it('never retries — a re-run would double-snapshot the same import', () => {
    expect(job.spec.backoffLimit).toBe(0);
  });

  it('reaps itself', () => {
    expect(job.spec.ttlSecondsAfterFinished).toBeGreaterThan(0);
  });

  it('carries the import id as a label so its Job and snapshots correlate', () => {
    expect(job.metadata.labels['platform.io/import-id']).toBe('imp-1');
  });
});

describe('parseImportUnitResults', () => {
  it('extracts a completed unit', () => {
    const snap = 'b'.repeat(64);
    const [r] = parseImportUnitResults(
      `noise\nIMPORT_UNIT_DONE importId=imp-1 component=mailboxes name=user@example.test snapshot=${snap} sizeBytes=99 addedBytes=42\n`,
    );
    expect(r).toEqual({
      component: 'mailboxes', name: 'user@example.test', snapshotId: snap, sizeBytes: 99, addedBytes: 42,
    });
  });

  it('drops a line whose snapshot id is not 64 hex', () => {
    // backup_components.sha256 is read back as a restic snapshot id by every
    // restore and browse path, and the mailbox Job THROWS on a malformed one.
    // A partial parse must produce no row rather than a row that fails later.
    for (const bad of ['deadbeef', 'z'.repeat(64), '', 'B'.repeat(64)]) {
      expect(parseImportUnitResults(
        `IMPORT_UNIT_DONE importId=imp-1 component=files name=archive snapshot=${bad} sizeBytes=1`,
      )).toEqual([]);
    }
  });

  it('drops a line naming a component that is not restic-backed', () => {
    expect(parseImportUnitResults(
      `IMPORT_UNIT_DONE importId=imp-1 component=secrets name=tls snapshot=${'c'.repeat(64)}`,
    )).toEqual([]);
  });

  it('ignores unrelated log noise entirely', () => {
    expect(parseImportUnitResults('Extracting...\nWARN: something\nIMPORT_EXTRACTED units=2\n')).toEqual([]);
  });
});

describe('importCompleted', () => {
  it('is true only for this import id', () => {
    expect(importCompleted('IMPORT_DONE importId=imp-1 units=2', 'imp-1')).toBe(true);
    expect(importCompleted('IMPORT_DONE importId=other units=2', 'imp-1')).toBe(false);
    // A log that stops after the units but before the marker is an incomplete
    // run — rows must not be written for it.
    expect(importCompleted(`IMPORT_UNIT_DONE importId=imp-1 component=files name=archive snapshot=${'a'.repeat(64)}`, 'imp-1')).toBe(false);
  });
});


const OBJECTS: ImportObjectUpload[] = [
  { component: 'config', name: 'db-rows.json.gz', tokenKey: 'upload_token_config' },
  { component: 'secrets', name: 'tls.json.gz.enc', tokenKey: 'upload_token_secrets' },
];

const WITH_OBJECTS: BuildImportJobInput = {
  ...BASE,
  objectArtifacts: OBJECTS,
  internalApiBase: 'http://platform-api.platform.svc:3000',
};

describe('buildImportScript — object artifacts', () => {
  const script = buildImportScript(WITH_OBJECTS);

  it('PUTs each artifact at the internal upload route the capture Job already uses', () => {
    for (const o of OBJECTS) {
      expect(script).toContain(
        `http://platform-api.platform.svc:3000/api/v1/internal/bundles/bkp-1/components/${o.component}/${o.name}`,
      );
    }
    // --upload-file implies PUT, which is the method the route registers.
    expect(script).toContain('--upload-file');
  });

  it('★ reads the token from the mounted Secret and never inlines it', () => {
    // A token in `command` is readable by anyone with pod-read in the tenant
    // namespace. It must arrive through the creds mount instead.
    for (const o of OBJECTS) {
      expect(script).toContain(`TOKEN="$(cat ${IMPORT_CREDS_MOUNT_PATH}/${o.tokenKey})"`);
    }
  });

  it('★ keeps the token off curl\'s argv', () => {
    // `curl ...?token=$TOKEN` is expanded by the shell BEFORE exec, so the
    // real token would sit in /proc/<pid>/cmdline and `ps` for the life of
    // the upload. It goes into a config file instead.
    const curlLines = script.split('\n').filter((l) => l.includes('curl '));
    expect(curlLines.length).toBeGreaterThan(0);
    for (const l of curlLines) {
      expect(l, l).not.toContain('token=');
      expect(l, l).not.toContain('$TOKEN');
    }
    expect(script).toContain('--config /tmp/curlrc');
    expect(script).toMatch(/printf 'url = "%s\?token=%s"/);
    // …and the file does not outlive the upload, on either path
    expect(script).toContain('rm -f /tmp/curlrc');
    expect(script).toContain('umask 077');
  });

  it('uploads only AFTER every restic unit succeeded', () => {
    // An import that dies mid-restic must leave nothing in the object store.
    const lastBackup = script.lastIndexOf('restic -r "$REPO" backup');
    for (const o of OBJECTS) {
      expect(script.indexOf(`components/${o.component}/${o.name}`), o.name).toBeGreaterThan(lastBackup);
    }
  });

  it('fails the Job when a promised artifact is absent rather than reporting success', () => {
    expect(script).toMatch(/\[ -f "\$ART" \] \|\| \{ echo "ERROR: archive is missing config\/db-rows.json.gz/);
  });

  it('deletes each artifact once uploaded', () => {
    expect(script).toContain('rm -f "$ART"');
  });

  it('counts the objects in the completion marker', () => {
    expect(script).toContain('IMPORT_DONE importId=imp-1 units=2 objects=2');
  });

  it('refuses to build without an API base, rather than emitting a broken URL', () => {
    expect(() => buildImportScript({ ...BASE, objectArtifacts: OBJECTS }))
      .toThrow(/internalApiBase is required/);
  });

  it('refuses a hostile artifact or token name', () => {
    for (const bad of ['../../etc/passwd', 'a/b', 'a;id', 'a b', '..', '']) {
      expect(() => assertSafeArtifactName(bad), JSON.stringify(bad)).toThrow();
    }
    expect(() => buildImportScript({
      ...WITH_OBJECTS,
      objectArtifacts: [{ component: 'config', name: 'a;id', tokenKey: 'upload_token_config' }],
    })).toThrow(/unexpected characters/);
  });
});

describe('parseImportObjectResults', () => {
  it('extracts an uploaded artifact', () => {
    expect(parseImportObjectResults(
      'noise\nIMPORT_OBJECT_DONE importId=imp-1 component=config name=db-rows.json.gz sizeBytes=2048\n',
    )).toEqual([{ component: 'config', name: 'db-rows.json.gz', sizeBytes: 2048 }]);
  });

  it('drops a line naming a component this path never uploads', () => {
    // files/mailboxes go to restic, never to the object store. A row claiming
    // otherwise would describe a bundle that cannot be restored.
    expect(parseImportObjectResults(
      'IMPORT_OBJECT_DONE importId=imp-1 component=files name=archive sizeBytes=10',
    )).toEqual([]);
  });

  it('ignores unit lines and noise', () => {
    expect(parseImportObjectResults(
      `IMPORT_UNIT_DONE importId=imp-1 component=files name=archive snapshot=${'a'.repeat(64)} sizeBytes=1\nWARN: x`,
    )).toEqual([]);
  });
});
