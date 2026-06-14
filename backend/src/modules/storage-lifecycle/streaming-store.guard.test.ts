import { describe, it, expect } from 'vitest';
import { S3StreamingStore } from './streaming-store.js';

/**
 * The backup-rclone-shim's `rclone serve s3` (gofakes3) buffers an
 * ENTIRE object in RAM until CompleteMultipartUpload — a single giant
 * `rclone rcat` OOMs it past ~1 GiB (the bug that broke every
 * destructive shrink). The pre-resize path now uses a chunked files
 * bundle, but the streaming store keeps a hard backstop: when the target
 * is the shim, the Job pre-checks `du -sb /source` and fails LOUD past
 * 512 MiB instead of OOMing mid-stream. Real S3 upstreams stream
 * multipart fine and get NO cap.
 */
describe('S3StreamingStore single-object guard', () => {
  const base = {
    bucket: 'tenant',
    region: 'us-east-1',
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
  };

  it('injects the 512 MiB du guard when the endpoint is the rclone shim', () => {
    const store = new S3StreamingStore({
      ...base,
      endpoint: 'http://backup-rclone-shim.platform.svc.cluster.local:9000',
    });
    const { script } = store.getStreamingJob('tenant-abc/snap-1.tar.gz');
    expect(script).toContain('MAX_SRC_BYTES=536870912');
    expect(script).toContain('df -kP /source');
    expect(script).toContain('exceeds the shim single-object guard');
  });

  it('does NOT cap a real (non-shim) S3 upstream', () => {
    const store = new S3StreamingStore({
      ...base,
      endpoint: 'https://fsn1.your-objectstorage.com',
    });
    const { script } = store.getStreamingJob('tenant-abc/snap-1.tar.gz');
    expect(script).not.toContain('MAX_SRC_BYTES');
    expect(script).not.toContain('single-object guard');
  });
});
