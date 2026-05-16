import { useQuery, useMutation } from '@tanstack/react-query';
import { apiFetch, API_BASE } from '@/lib/api-client';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface QueryResult {
  readonly columns: string[];
  readonly rows: string[][];
  readonly rowCount: number;
  readonly executionTimeMs: number;
  readonly error?: string;
}

export interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly defaultValue: string | null;
  readonly key: string;
}

interface TableDataOptions {
  readonly page?: number;
  readonly pageSize?: number;
  readonly orderBy?: string;
  readonly orderDir?: 'ASC' | 'DESC';
}

// ─── Hooks ──────────────────────────────────────────────────────────────────

export function useExecuteQuery(tenantId: string | null | undefined, deploymentId: string | undefined) {
  return useMutation({
    mutationFn: ({ database, query }: { readonly database: string; readonly query: string }) => {
      if (!tenantId || !deploymentId) throw new Error('Missing tenant or deployment');
      return apiFetch<{ data: QueryResult }>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/query`,
        { method: 'POST', body: JSON.stringify({ database, query }) },
      );
    },
  });
}

export function useDatabasesWithSize(
  tenantId: string | null | undefined,
  deploymentId: string | undefined,
) {
  return useQuery({
    queryKey: ['sql-databases-size', tenantId, deploymentId],
    queryFn: () =>
      apiFetch<{ data: readonly { name: string; sizeBytes: number }[] }>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/databases-with-size`,
      ),
    enabled: Boolean(tenantId) && Boolean(deploymentId),
    staleTime: 30_000,
  });
}

export function useListTables(
  tenantId: string | null | undefined,
  deploymentId: string | undefined,
  database: string | undefined,
) {
  return useQuery({
    queryKey: ['sql-tables', tenantId, deploymentId, database],
    queryFn: () =>
      apiFetch<{ data: readonly { name: string; sizeBytes: number; rowCount: number }[] }>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/tables?database=${encodeURIComponent(database!)}`,
      ),
    enabled: Boolean(tenantId) && Boolean(deploymentId) && Boolean(database),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always' as const,
  });
}

export function useTableStructure(
  tenantId: string | null | undefined,
  deploymentId: string | undefined,
  database: string | undefined,
  table: string | undefined,
) {
  return useQuery({
    queryKey: ['sql-structure', tenantId, deploymentId, database, table],
    queryFn: () =>
      apiFetch<{ data: readonly ColumnInfo[] }>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/table-structure?database=${encodeURIComponent(database!)}&table=${encodeURIComponent(table!)}`,
      ),
    enabled: Boolean(tenantId) && Boolean(deploymentId) && Boolean(database) && Boolean(table),
  });
}

export function useTableData(
  tenantId: string | null | undefined,
  deploymentId: string | undefined,
  database: string | undefined,
  table: string | undefined,
  options: TableDataOptions = {},
) {
  const { page = 1, pageSize = 50, orderBy, orderDir } = options;
  const offset = (page - 1) * pageSize;

  return useQuery({
    queryKey: ['sql-table-data', tenantId, deploymentId, database, table, page, pageSize, orderBy, orderDir],
    queryFn: () => {
      const params = new URLSearchParams({
        database: database!,
        table: table!,
        limit: String(pageSize),
        offset: String(offset),
      });
      if (orderBy) params.set('orderBy', orderBy);
      if (orderDir) params.set('orderDir', orderDir);

      return apiFetch<{ data: QueryResult }>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/table-data?${params}`,
      );
    },
    enabled: Boolean(tenantId) && Boolean(deploymentId) && Boolean(database) && Boolean(table),
  });
}

export function useRowCount(
  tenantId: string | null | undefined,
  deploymentId: string | undefined,
  database: string | undefined,
  table: string | undefined,
) {
  return useQuery({
    queryKey: ['sql-row-count', tenantId, deploymentId, database, table],
    queryFn: () =>
      apiFetch<{ data: { count: number } }>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/row-count?database=${encodeURIComponent(database!)}&table=${encodeURIComponent(table!)}`,
      ),
    enabled: Boolean(tenantId) && Boolean(deploymentId) && Boolean(database) && Boolean(table),
  });
}

export interface ExportResult {
  readonly pvcPath: string;
  readonly sizeBytes: number;
  readonly fileName: string;
  readonly message: string;
}

export function useExportDatabase(tenantId: string | null | undefined) {
  return useMutation({
    mutationFn: async ({ deploymentId, database }: { readonly deploymentId: string; readonly database: string }) => {
      if (!tenantId) throw new Error('No tenant selected');
      // Export to PVC — returns { pvcPath, sizeBytes, fileName, message }
      return apiFetch<{ data: ExportResult }>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/export?database=${encodeURIComponent(database)}`,
        { method: 'POST' },
      );
    },
  });
}

export function useImportSql(tenantId: string | null | undefined) {
  return useMutation({
    mutationFn: async ({
      deploymentId,
      database,
      file,
    }: {
      readonly deploymentId: string;
      readonly database: string;
      readonly file: File;
    }) => {
      if (!tenantId) throw new Error('No tenant selected');

      // Read the .sql file as text, then send as raw text body — avoids JSON encoding overhead
      // that doubles memory for large files with escape characters
      let sql: string;
      try {
        sql = await file.text();
      } catch {
        throw new Error(`Failed to read file "${file.name}" — it may be too large for the browser to process.`);
      }

      if (!sql.trim()) {
        throw new Error('The SQL file is empty.');
      }

      const token = localStorage.getItem('auth_token');
      // API_BASE imported from @/lib/api-client
      const res = await fetch(
        `${API_BASE}/api/v1/tenants/${tenantId}/deployments/${deploymentId}/import?database=${encodeURIComponent(database)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ database, sql }),
        },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: { message: 'Import failed' } }));
        const message = body.error?.message ?? `Import failed (HTTP ${res.status})`;
        if (res.status === 413) {
          throw new Error('File is too large. Maximum upload size is 50MB. For larger files, upload via File Manager and use "Import from File".');
        }
        throw new Error(message);
      }

      const result = await res.json();
      // Backend returns 200 with { success: false } for import errors (OOM, syntax, etc.)
      if (result.data && result.data.success === false && result.data.error) {
        throw new Error(result.data.error);
      }
      return result as { data: { message: string } };
    },
  });
}

export interface PvcFileEntry {
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly size: number;
  readonly modifiedAt: string | null;
  readonly permissions: string;
}

export function useListPvcFiles(
  tenantId: string | null | undefined,
  path: string,
  enabled = true,
) {
  return useQuery({
    queryKey: ['pvc-files', tenantId, path],
    queryFn: () =>
      apiFetch<{ data: { path: string; entries: readonly PvcFileEntry[] } }>(
        `/api/v1/tenants/${tenantId}/files?path=${encodeURIComponent(path)}`,
      ),
    enabled: enabled && Boolean(tenantId),
    staleTime: 0,
    gcTime: 0,
  });
}

export function useImportSqlFromFile(tenantId: string | null | undefined) {
  return useMutation({
    mutationFn: async ({
      deploymentId,
      database,
      filePath,
    }: {
      readonly deploymentId: string;
      readonly database: string;
      readonly filePath: string;
    }) => {
      if (!tenantId) throw new Error('No tenant selected');
      const result = await apiFetch<{ data: { success: boolean; error?: string } }>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/import-from-file`,
        { method: 'POST', body: JSON.stringify({ database, file_path: filePath }) },
      );
      // Backend returns 200 with { success: false } for import errors (OOM, syntax, etc.)
      if (result.data && !result.data.success && result.data.error) {
        throw new Error(result.data.error);
      }
      return result;
    },
  });
}

// ─── SQLite Hooks ────────────────────────────────────────────────────────────
// SQLite files are queried directly via the file-manager pod.
// No deployment selector or database selector needed — the file path IS the database.

export function useSqliteQuery(tenantId: string | null | undefined) {
  return useMutation({
    mutationFn: ({ filePath, query }: { readonly filePath: string; readonly query: string }) => {
      if (!tenantId) throw new Error('No tenant selected');
      return apiFetch<{ data: QueryResult }>(
        `/api/v1/tenants/${tenantId}/sqlite/query`,
        { method: 'POST', body: JSON.stringify({ file_path: filePath, query }) },
      );
    },
  });
}

export function useSqliteTables(
  tenantId: string | null | undefined,
  filePath: string | undefined,
) {
  return useQuery({
    queryKey: ['sqlite-tables', tenantId, filePath],
    queryFn: () =>
      apiFetch<{ data: readonly string[] }>(
        `/api/v1/tenants/${tenantId}/sqlite/tables?file_path=${encodeURIComponent(filePath!)}`,
      ),
    enabled: Boolean(tenantId) && Boolean(filePath),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always' as const,
  });
}

export function useSqliteTableStructure(
  tenantId: string | null | undefined,
  filePath: string | undefined,
  table: string | undefined,
) {
  return useQuery({
    queryKey: ['sqlite-structure', tenantId, filePath, table],
    queryFn: () =>
      apiFetch<{ data: readonly ColumnInfo[] }>(
        `/api/v1/tenants/${tenantId}/sqlite/table-structure?file_path=${encodeURIComponent(filePath!)}&table=${encodeURIComponent(table!)}`,
      ),
    enabled: Boolean(tenantId) && Boolean(filePath) && Boolean(table),
  });
}

export function useSqliteTableData(
  tenantId: string | null | undefined,
  filePath: string | undefined,
  table: string | undefined,
  options: TableDataOptions = {},
) {
  const { page = 1, pageSize = 50, orderBy, orderDir } = options;
  const offset = (page - 1) * pageSize;

  return useQuery({
    queryKey: ['sqlite-table-data', tenantId, filePath, table, page, pageSize, orderBy, orderDir],
    queryFn: () => {
      const params = new URLSearchParams({
        file_path: filePath!,
        table: table!,
        limit: String(pageSize),
        offset: String(offset),
      });
      if (orderBy) params.set('orderBy', orderBy);
      if (orderDir) params.set('orderDir', orderDir);

      return apiFetch<{ data: QueryResult }>(
        `/api/v1/tenants/${tenantId}/sqlite/table-data?${params}`,
      );
    },
    enabled: Boolean(tenantId) && Boolean(filePath) && Boolean(table),
  });
}

export function useSqliteRowCount(
  tenantId: string | null | undefined,
  filePath: string | undefined,
  table: string | undefined,
) {
  return useQuery({
    queryKey: ['sqlite-row-count', tenantId, filePath, table],
    queryFn: () =>
      apiFetch<{ data: { count: number } }>(
        `/api/v1/tenants/${tenantId}/sqlite/row-count?file_path=${encodeURIComponent(filePath!)}&table=${encodeURIComponent(table!)}`,
      ),
    enabled: Boolean(tenantId) && Boolean(filePath) && Boolean(table),
  });
}

export function useSqliteExport(tenantId: string | null | undefined) {
  return useMutation({
    mutationFn: async ({ filePath }: { readonly filePath: string }) => {
      if (!tenantId) throw new Error('No tenant selected');
      const token = localStorage.getItem('auth_token');
      // API_BASE imported from @/lib/api-client
      const res = await fetch(
        `${API_BASE}/api/v1/tenants/${tenantId}/sqlite/export?file_path=${encodeURIComponent(filePath)}`,
        { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: { message: 'Export failed' } }));
        throw new Error(body.error?.message ?? 'Export failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filePath.split('/').pop() ?? 'database'}-export.sql`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
  });
}

export function useSqliteImport(tenantId: string | null | undefined) {
  return useMutation({
    mutationFn: async ({
      filePath,
      file,
    }: {
      readonly filePath: string;
      readonly file: File;
    }) => {
      if (!tenantId) throw new Error('No tenant selected');
      const sql = await file.text();
      try {
        return await apiFetch<{ data: { success: boolean; error?: string } }>(
          `/api/v1/tenants/${tenantId}/sqlite/import`,
          { method: 'POST', body: JSON.stringify({ file_path: filePath, sql }) },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Import failed';
        if (message.includes('too large') || message.includes('413') || message.includes('Payload Too Large')) {
          throw new Error('File is too large. Maximum upload size is 50MB.');
        }
        if (message.includes('Failed to fetch') || message.includes('NetworkError') || message.includes('Load failed')) {
          throw new Error('Upload failed — the file may be too large or the server is unreachable.');
        }
        throw err;
      }
    },
  });
}
