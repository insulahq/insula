/**
 * Chunked upload for a single large file, used by the bundle-import flow.
 *
 * Same wire protocol as the file-manager's uploader: one POST per chunk with
 * `?offset=N`, which the sidecar `pwrite`s at that offset (no truncation), so
 * chunks may land in any order and the file is whole once all have completed.
 *
 * ★ Deliberately NOT a refactor of `use-file-manager`'s `uploadFileChunked`.
 * That one is wired into the file-manager's own progress panel and is a live
 * path tenants use daily; extracting it to serve a second caller would put
 * that at risk for no functional gain. This is the same protocol with a
 * promise + callback surface, which is what a modal needs.
 */

/** Matches the file-manager's tuning: below this, one request is faster. */
export const UPLOAD_CHUNK_THRESHOLD = 8 * 1024 * 1024;
export const UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024;
export const UPLOAD_PARALLEL_CHUNKS = 4;

export interface ChunkedUploadArgs {
  readonly apiBase: string;
  readonly tenantId: string;
  readonly file: File;
  /** Absolute path on the tenant's file space, e.g. `/.insula-imports/imp1.tar.gz`. */
  readonly path: string;
  readonly onProgress?: (loaded: number, total: number) => void;
  /** Called with an abort function as soon as the upload is cancellable. */
  readonly onAbortable?: (abort: () => void) => void;
}

function authHeader(): string | null {
  const token = localStorage.getItem('auth_token');
  return token ? `Bearer ${token}` : null;
}

function errorTextOf(xhr: XMLHttpRequest): string {
  try {
    const parsed = JSON.parse(xhr.responseText) as { error?: { message?: string } };
    if (parsed?.error?.message) return parsed.error.message;
  } catch { /* not JSON */ }
  return xhr.statusText || `HTTP ${xhr.status}`;
}

/** One chunk (or the whole file when `total` is absent). */
function putSlice(args: {
  url: string;
  body: Blob;
  register: (xhr: XMLHttpRequest) => void;
  onLoaded: (loaded: number) => void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    args.register(xhr);
    xhr.open('POST', args.url);
    const auth = authHeader();
    if (auth) xhr.setRequestHeader('Authorization', auth);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) args.onLoaded(e.loaded); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { args.onLoaded(args.body.size); resolve(); return; }
      reject(new Error(errorTextOf(xhr)));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.send(args.body);
  });
}

/**
 * Upload `file` to `path`, resolving only when every byte has landed.
 *
 * Rejects with `Upload cancelled` when aborted, so a caller can tell a user
 * cancellation apart from a failure.
 */
export async function uploadChunked(args: ChunkedUploadArgs): Promise<void> {
  const { apiBase, tenantId, file, path } = args;
  const base = `${apiBase}/api/v1/tenants/${encodeURIComponent(tenantId)}/files/upload-raw`
    + `?path=${encodeURIComponent(path)}`;

  const inFlight = new Set<XMLHttpRequest>();
  let cancelled = false;
  args.onAbortable?.(() => {
    cancelled = true;
    for (const xhr of inFlight) { try { xhr.abort(); } catch { /* already done */ } }
  });
  const register = (xhr: XMLHttpRequest): void => {
    inFlight.add(xhr);
    // An aborted upload must not leave a request running just because it
    // started between the abort call and this registration.
    if (cancelled) { try { xhr.abort(); } catch { /* ignore */ } }
  };

  // Small file: one request, no offset bookkeeping.
  if (file.size <= UPLOAD_CHUNK_THRESHOLD) {
    await putSlice({
      url: base,
      body: file,
      register,
      onLoaded: (loaded) => args.onProgress?.(Math.min(loaded, file.size), file.size),
    });
    return;
  }

  const chunkCount = Math.ceil(file.size / UPLOAD_CHUNK_SIZE);
  const loaded = new Array<number>(chunkCount).fill(0);
  const report = (): void => {
    args.onProgress?.(loaded.reduce((a, b) => a + b, 0), file.size);
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = next++;
      if (idx >= chunkCount) return;
      if (cancelled) throw new Error('Upload cancelled');
      const offset = idx * UPLOAD_CHUNK_SIZE;
      const end = Math.min(offset + UPLOAD_CHUNK_SIZE, file.size);
      await putSlice({
        url: `${base}&offset=${offset}&total=${file.size}`,
        body: file.slice(offset, end),
        register,
        onLoaded: (n) => { loaded[idx] = Math.min(n, end - offset); report(); },
      });
    }
  };

  // Bounded concurrency: N workers pulling from one index, so a slow chunk
  // never leaves the other lanes idle the way a fixed partition would.
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_PARALLEL_CHUNKS, chunkCount) }, () => worker()),
  );
  report();
}
