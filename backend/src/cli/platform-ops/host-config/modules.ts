/**
 * Kernel-module convergence (ADR-045 W10 follow-up) — ensure declared modules
 * are loaded (and persisted via modules-load.d). Pure over the ModuleDeps seam.
 *
 * ADDITIVE-ONLY: load missing modules; NEVER unload (a daily timer unloading a
 * live module would be a foot-cannon). Module NAME validated (charset, no path/
 * shell metas) in BOTH the converger AND the loader; modprobe runs argv-only.
 */
import type { ModuleConvergeResult, ModuleDeps, ModuleItem, ModuleSpec } from './types.js';

const MODULE_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_MODULE_SPECS = 100;

export function moduleNameValid(name: string): boolean {
  return name.length > 0 && name.length <= 64 && MODULE_NAME.test(name);
}

export function convergeModules(
  specs: readonly ModuleSpec[] | null,
  enforcing: boolean,
  deps: ModuleDeps,
): ModuleConvergeResult {
  const mode: 'enforce' | 'dry-run' = enforcing ? 'enforce' : 'dry-run';
  if (specs === null) {
    return { ok: true, mode, desiredSource: 'absent', items: [], loadedCount: 0 };
  }
  if (specs.length > MAX_MODULE_SPECS) {
    // Refuse the whole policy — never partially (and silently) process a
    // suspiciously large list (mirrors host-packages' MAX_PACKAGE_SPECS).
    return {
      ok: false,
      mode,
      desiredSource: 'configmap',
      items: [],
      loadedCount: 0,
      reason: `host-modules-desired declares ${specs.length} modules (> ${MAX_MODULE_SPECS} cap) — refusing`,
    };
  }

  const items: ModuleItem[] = [];
  let loadedCount = 0;
  let ok = true;
  for (const spec of specs) {
    if (!moduleNameValid(spec.name)) {
      items.push({ name: spec.name, state: 'not-allowed' });
      continue;
    }
    if (deps.isLoaded(spec.name)) {
      items.push({ name: spec.name, state: 'loaded' });
      continue;
    }
    if (!enforcing) {
      items.push({ name: spec.name, state: 'would-load' });
      continue;
    }
    try {
      deps.loadModule(spec.name);
    } catch (err) {
      ok = false;
      const message = err instanceof Error ? err.message : String(err);
      items.push({ name: spec.name, state: 'load-failed', error: message });
      continue;
    }
    items.push({ name: spec.name, state: 'loaded-now' });
    loadedCount++;
  }
  return { ok, mode, desiredSource: 'configmap', items, loadedCount };
}
