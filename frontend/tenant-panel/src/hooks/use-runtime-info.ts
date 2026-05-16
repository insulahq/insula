import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';

/**
 * Surfaces the platform-api pod's identity (version, branch, node name)
 * to the sidebar. Cached at module scope — fetched once per page load
 * because none of these values change while a session is open.
 */
export interface RuntimeInfo {
  readonly version: string;
  readonly branch: string | null;
  readonly node: string | null;
  readonly pod: string | null;
  readonly environment: string | null;
}

let cachedRuntimeInfo: RuntimeInfo | null = null;

export function useRuntimeInfo(): RuntimeInfo | null {
  const [info, setInfo] = useState<RuntimeInfo | null>(cachedRuntimeInfo);

  useEffect(() => {
    if (cachedRuntimeInfo) return;
    let cancelled = false;
    apiFetch<{ data: RuntimeInfo }>('/api/v1/auth/runtime-info')
      .then((res) => {
        if (cancelled) return;
        cachedRuntimeInfo = res.data;
        setInfo(res.data);
      })
      .catch(() => {
        // Silent — the sidebar block just stays hidden if the fetch
        // fails (e.g., logged-out flash, transient blip).
      });
    return () => { cancelled = true; };
  }, []);

  return info;
}
