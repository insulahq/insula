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
  unitCaptureRoot,
  IMPORT_STAGE_ROOT,
  IMPORT_UPLOAD_MOUNT,
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
  namespace: 'tenant-example-test',
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
    expect(script).toContain(`${IMPORT_UPLOAD_MOUNT}/.insula-imports/imp-1.tar.gz`);
    expect(script).toContain('read_archive | tar -tzf -');
    expect(script).toContain('read_archive() { cat "$ARCHIVE"; }');
    expect(script).not.toMatch(/curl[^\n]*\$ARCHIVE/);
    // With no object artifacts there is no network egress at all.
    expect(script).not.toContain('curl');
  });

  it('fails when the archive is absent instead of producing an empty import', () => {
    expect(script).toMatch(/\[ -f "\$ARCHIVE" \] \|\| \{ echo "ERROR: uploaded archive not found/);
  });

  it('★ matches archive members by exact prefix, not by regex', () => {
    // A unit name is a mailbox ADDRESS and contains regex metacharacters. An
    // earlier version anchored with `^\\./\\?…`, which makes the SLASH
    // optional rather than the `./` pair — so it demanded a leading dot no
    // archive has, every unit read as missing, and the import refused itself
    // on a perfectly good bundle (observed on DEV).
    expect(script).not.toMatch(/grep -q '\^/);
    for (const u of UNITS) {
      expect(script, u.name).toContain(`awk -v m='components/${u.component}/${u.name}' 'index($0, m) == 1'`
        .replace(" 'index($0, m) == 1'", " 'index($0, m) == 1 { found = 1; exit } END { exit !found }'"));
    }
    // and `./`-prefixed members are normalised so the comparison holds
    expect(script).toContain("sed 's|^[.]/||'");
  });

  it('★ stages each unit AT its capture root, which is what restore and browse read', () => {
    // restic records the absolute path it is given, and every consumer resolves
    // content by that prefix: browse strips /source, files restore includes
    // /source/<p>, mailbox restore reads /capture/<addressDirName>. Snapshotting
    // a staging path instead produces a snapshot nothing can read — browse
    // returns an EMPTY tree and a restore restores nothing while reporting
    // success. Observed on DEV on the first otherwise-successful import.
    expect(unitCaptureRoot(UNITS[0]!)).toBe('/source');
    expect(unitCaptureRoot(UNITS[1]!)).toBe('/capture/user@example.test');
    for (const u of UNITS) {
      const root = unitCaptureRoot(u);
      expect(script).toContain(`--strip-components=3 'components/${u.component}/${u.name}'`.replace(/'/g, u.name.includes('@') ? "'" : "'"));
      expect(script, u.name).toContain(`backup '${root}'`);
      // …and never the raw staging path
      expect(script).not.toContain(`backup '${unitStagePath(u)}'`);
    }
  });

  it('asserts every promised unit landed before touching the repo', () => {
    // /bin/sh is dash — no pipefail — so a short read can leave tar exiting 0.
    // Unit presence is the completeness signal, and it must be checked BEFORE
    // the first restic call or a truncated archive writes a partial snapshot.
    const firstBackup = script.indexOf('restic -r "$REPO" backup');
    expect(firstBackup).toBeGreaterThan(-1);
    // One presence check per unit, ALL of them before the first restic call.
    // Matched on the manifest reads rather than the member string.
    const checks = [...script.matchAll(new RegExp(`${IMPORT_STAGE_ROOT}/manifest\\.txt`, 'g'))]
      .map((m) => m.index ?? -1);
    // one manifest write + one emptiness guard + one presence check per unit
    expect(checks).toHaveLength(UNITS.length + 2);
    for (const at of checks) expect(at).toBeLessThan(firstBackup);
    // and each unit is named in some form
    for (const u of UNITS) {
      expect(script).toContain(`components/${u.component}/`);
      expect(script, u.name).toMatch(new RegExp(u.name.replace(/[.*+?^${}()|[\]\\]/g, '\\\\?$&')));
    }
  });

  it('★ emits the file count the bundle manifest requires', () => {
    // meta.components.files.fileCount is a REQUIRED field on the manifest,
    // and putMeta validates it — a guessed 0 would have been a lie, a missing
    // one fails validation AFTER the snapshots are already written.
    expect(script).toContain('"total_files_processed":[0-9]');
    expect(script).toContain('fileCount=${FILES:-0}');
  });

  it('tags every snapshot with the import id so a failed run is prunable', () => {
    // Partial snapshots from a failed import have to be findable; the tag is
    // the only handle, because no rows are written until every unit succeeds.
    const tagCount = script.match(/--tag 'import=imp-1'/g) ?? [];
    expect(tagCount).toHaveLength(UNITS.length);
  });

  it('deletes each unit after its backup so peak staging falls', () => {
    for (const u of UNITS) {
      const root = unitCaptureRoot(u);
      const backupIdx = script.indexOf(`backup '${root}'`);
      const clearIdx = script.lastIndexOf(`find '${root}' -mindepth 1`);
      expect(backupIdx, u.name).toBeGreaterThan(-1);
      expect(clearIdx, u.name).toBeGreaterThan(backupIdx);
    }
  });

  it('★ never rm -rf a capture root — it is a mount point', () => {
    // `/source` is a subPath MOUNT, and removing a mount point fails with
    // "Device or resource busy". That aborted the whole import before a byte
    // was read. Contents are cleared instead, which works either way.
    for (const u of UNITS) {
      const root = unitCaptureRoot(u);
      expect(script, root).not.toContain(`rm -rf '${root}'`);
      expect(script, root).toContain(`find '${root}' -mindepth 1 -maxdepth 1 -exec rm -rf {} +`);
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

describe('buildImportScript — encrypted archives', () => {
  const ENC: BuildImportJobInput = { ...BASE, archiveEncrypted: true, passphraseKey: 'archive_passphrase' };
  const script = buildImportScript(ENC);

  it('★ decrypts before tar, or every unit reads as missing', () => {
    // The export writes a `Salted__` AES-256-CBC envelope. `tar` cannot read
    // those bytes: the manifest comes back empty, every promised unit looks
    // absent, and the import refuses a bundle this platform just produced.
    // Observed on the first real export->import round trip.
    expect(script).toContain('read_archive() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -md sha256');
    expect(script).toContain('read_archive | tar -tzf -');
    expect(script).toContain('read_archive | tar -xzf -');
    // never tar straight at the encrypted file
    expect(script).not.toContain('tar -tzf "$ARCHIVE"');
    expect(script).not.toContain('tar -xzf "$ARCHIVE"');
  });

  it('matches the export\'s key derivation exactly', () => {
    // These three must mirror streamEncryptedExport or the decrypt silently
    // produces noise rather than failing loudly.
    expect(script).toContain('-aes-256-cbc');
    expect(script).toContain('-pbkdf2 -iter 100000');
    expect(script).toContain('-md sha256');
  });

  it('★ keeps the passphrase off argv', () => {
    expect(script).toContain('-pass file:/var/run/restic-creds/archive_passphrase');
    expect(script).not.toMatch(/-pass\s+pass:/);
  });

  it('★ treats an empty manifest as a wrong passphrase, not as an empty bundle', () => {
    // /bin/sh is dash — no pipefail — so a failed decrypt leaves tar reading
    // garbage and the pipeline can still exit 0.
    expect(script).toMatch(/\[ -s [^ ]*manifest\.txt \] \|\|/);
    expect(script).toContain('wrong passphrase, or the upload is corrupt');
  });

  it('the plaintext path reads the file directly and names no passphrase', () => {
    const plain = buildImportScript(BASE);
    expect(plain).toContain('read_archive() { cat "$ARCHIVE"; }');
    expect(plain).not.toContain('openssl');
    expect(plain).toContain('the upload may be corrupt or truncated');
  });

  it('refuses to build an encrypted import with no passphrase key', () => {
    expect(() => buildImportScript({ ...BASE, archiveEncrypted: true }))
      .toThrow(/passphraseKey is required/);
  });
});

describe('buildImportJobSpec', () => {
  const job = buildImportJobSpec(BASE) as Record<string, any>;
  const pod = job.spec.template.spec;

  it('mounts the tenant PVC READ-ONLY, and NOT at the files capture root', () => {
    // The import reads one archive. It must never be able to mutate tenant
    // files, whatever the archive contains. And it must not occupy /source —
    // that path belongs to the files snapshot the import has to reproduce.
    const mount = pod.containers[0].volumeMounts.find((m: any) => m.name === 'upload');
    expect(mount).toMatchObject({ mountPath: IMPORT_UPLOAD_MOUNT, readOnly: true });
    expect(IMPORT_UPLOAD_MOUNT).not.toBe('/source');
    const vol = pod.volumes.find((v: any) => v.name === 'upload');
    expect(vol.persistentVolumeClaim).toMatchObject({ claimName: 'tenant-files', readOnly: true });
  });

  it('★ backs both capture roots with the ONE size-limited volume', () => {
    // Otherwise the sizeLimit bounds only the raw staging area and the actual
    // extracted data lands somewhere unbounded.
    const mounts = pod.containers[0].volumeMounts.filter((m: any) => m.name === 'stage');
    const byPath = Object.fromEntries(mounts.map((m: any) => [m.mountPath, m.subPath]));
    expect(byPath['/source']).toBe('files');
    expect(byPath['/capture']).toBe('mail');
    expect(byPath['/stage']).toBe('raw');
    expect(pod.volumes.filter((v: any) => v.name === 'stage')).toHaveLength(1);
  });

  it('bounds staging with a sizeLimit so an under-declared manifest evicts the Job, not the node', () => {
    const stage = pod.volumes.find((v: any) => v.name === 'stage');
    expect(stage.emptyDir.sizeLimit).toBe('8Gi');
  });

  it('★ carries platform-tenant-overhead and explicit resources', () => {
    // The tenant ResourceQuota is scoped to PriorityClass In [tenant-default].
    // Without this class the quota applies to a PLATFORM job running in the
    // tenant namespace, demands memory requests/limits, and the
    // job-controller cannot create a pod — the Job then sits in `Running 0/1`
    // emitting FailedCreate until its deadline. Observed on DEV.
    expect(pod.priorityClassName).toBe('platform-tenant-overhead');
    expect(pod.containers[0].resources).toEqual({
      requests: { cpu: '100m', memory: '256Mi' },
      limits: { cpu: '1500m', memory: '1Gi' },
    });
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
      `noise\nIMPORT_UNIT_DONE importId=imp-1 component=mailboxes name=user@example.test snapshot=${snap} sizeBytes=99 addedBytes=42 fileCount=7\n`,
    );
    expect(r).toEqual({
      component: 'mailboxes', name: 'user@example.test', snapshotId: snap,
      sizeBytes: 99, addedBytes: 42, fileCount: 7,
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
