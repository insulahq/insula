#!/usr/bin/env bash
#
# Guard: the global-search registries stay in step with the routes they point at.
#
# Both panels' header search is fed by a HAND-AUTHORED registry of pages and
# tabs (frontend/*/src/search/registry.ts). Hand-authored is the right call —
# most of what an operator searches for is a TAB, which no amount of reading
# the Sidebar would surface — but it rots in three ways, and all three are
# silent:
#
#   1. Someone adds a page and forgets the entry. The page is simply
#      unfindable. Nothing fails, nobody notices, and the box quietly gets
#      less useful with every release.
#   2. Someone renames or deletes a route. The entry still matches on typing
#      and now navigates to "Page Not Found".
#   3. Someone renames a tab key. ?tab= stops matching the page's tab union,
#      the page silently falls back to its DEFAULT tab, and search looks like
#      it works while landing on the wrong view every time.
#
# None of those is caught by typecheck, lint, or any unit test: a registry is
# data, and the route table is a different file. Hence this.
#
# NOTE for editors: the node program below is embedded in a SINGLE-QUOTED
# shell string, so it must contain no ASCII single quote anywhere — not in
# code, not in a comment, not in an apostrophe. Quote characters that need to
# be matched are built with String.fromCharCode.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node --no-warnings --input-type=module -e '
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const PANELS = [
  { name: "admin-panel",  dir: "frontend/admin-panel"  },
  { name: "tenant-panel", dir: "frontend/tenant-panel" },
];

const SQUOTE = String.fromCharCode(39);
const DQUOTE = String.fromCharCode(34);
const BTICK  = String.fromCharCode(96);

/**
 * Pages that are deliberately NOT searchable because they only work with
 * state handed to them by another surface. Listing one here is a claim that
 * navigating to it cold is broken or useless — not a way to silence the
 * guard for a page nobody got round to adding.
 *
 *   /backups/restore — the tenant-bundle restore cart. The Restoration
 *   Wizard populates the cart and then navigates here; opened cold it has
 *   nothing to restore. App.tsx says the same in its own comment.
 */
const STATE_ONLY_ROUTES = new Set(["/backups/restore"]);

/** Route wrappers that are not the page component. */
const WRAPPERS = new Set(["ProtectedRoute", "LifecycleGate", "Suspense", "Navigate", "Route", "Fragment", "TabRoute"]);

let problems = 0;
const fail = (panel, msg, hint) => {
  console.log(`  x [${panel}] ${msg}`);
  if (hint) console.log(`    ${hint}`);
  problems++;
};

/**
 * Full route paths declared in an App.tsx, with the component each renders.
 *
 * Child routes are written relative to their parent (a Route with path
 * "tenants" wrapping one with path "list" means /tenants/list), so nesting
 * has to be tracked rather than reading each path= in isolation.
 */
function parseRoutes(src) {
  const routes = [];
  const stack = [];
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("</Route>")) { stack.pop(); continue; }
    if (!line.startsWith("<Route")) continue;

    const selfClosing = line.endsWith("/>");
    const pathMatch = line.match(/path=.([^"]*)./);
    const isIndex = /<Route\s+index/.test(line);
    const redirectsOnly = /element=\{<Navigate/.test(line);

    // The page component is the first <Xxx that is not a routing wrapper:
    // element={<ProtectedRoute ...><NodesPage /></ProtectedRoute>} renders
    // NodesPage, and reading the first tag would give ProtectedRoute.
    let component = null;
    for (const m of line.matchAll(/<([A-Z][A-Za-z0-9_]*)/g)) {
      if (!WRAPPERS.has(m[1])) { component = m[1]; break; }
    }

    const segment = isIndex ? "" : (pathMatch ? pathMatch[1] : "");
    const fullRaw = ("/" + [...stack, segment].filter(Boolean).join("/")).replace(/\/+/g, "/");
    // A tabbed page is declared as <page>/:tab? — the page itself is the
    // route; its tabs come from routes/tabbed-pages.ts.
    const full = fullRaw.replace(/\/:tab\?$/, "");

    if (pathMatch || isIndex) {
      routes.push({
        path: full === "" ? "/" : full,
        component,
        redirectsOnly,
        // A route that opens a nesting scope is a LAYOUT: its children are
        // the real destinations and its own index just redirects to one of
        // them. /tenants is the example — searching it should land you on
        // /tenants/list, which has its own entry.
        isLayout: !selfClosing,
      });
    }
    if (!selfClosing && pathMatch) stack.push(pathMatch[1]);
  }
  return routes;
}

/**
 * routes/tabbed-pages.ts: page path -> its tabs. The one place a tab exists,
 * so a registry tab is checked EXACTLY rather than by searching page source
 * for a quoted id.
 */
function parseTabbedPages(src) {
  const body = (src.match(/export const TABBED_PAGES = \{([\s\S]*?)\n\}/) || [])[1] || "";
  const out = new Map();
  const q = SQUOTE;
  const entryRe = new RegExp(q + "(/[^" + q + "]*)" + q + ":\\s*\\[([\\s\\S]*?)\\]", "g");
  const idRe = new RegExp(q + "([^" + q + "]+)" + q, "g");
  for (const m of body.matchAll(entryRe)) out.set(m[1], [...m[2].matchAll(idRe)].map((t) => t[1]));
  return out;
}

/** Registry entries: id + to, out of the object literals. */
function parseRegistry(src) {
  const entries = [];
  const re = /\{\s*id:\s*.(.+?).,[\s\S]*?to:\s*.(.+?).,/g;
  let m;
  while ((m = re.exec(src)) !== null) entries.push({ id: m[1], to: m[2] });
  return entries;
}

for (const panel of PANELS) {
  const appPath = `${panel.dir}/src/App.tsx`;
  const regPath = `${panel.dir}/src/search/registry.ts`;
  if (!existsSync(regPath)) { fail(panel.name, `no search registry at ${regPath}`); continue; }

  const routes = parseRoutes(readFileSync(appPath, "utf8"));
  const tabbed = parseTabbedPages(readFileSync(`${panel.dir}/src/routes/tabbed-pages.ts`, "utf8"));
  const entries = parseRegistry(readFileSync(regPath, "utf8"));
  if (tabbed.size === 0) fail(panel.name, "parsed no tabbed pages from routes/tabbed-pages.ts — the PARSER is broken");

  // Parser sanity first. Without this, a regex that stops matching makes every
  // check below pass over an empty set and the guard reports OK forever.
  if (routes.length < 10) fail(panel.name, `parsed only ${routes.length} routes from App.tsx — the PARSER is broken, not the registry`);
  if (entries.length < 10) fail(panel.name, `parsed only ${entries.length} registry entries — the PARSER is broken, not the registry`);

  const routePaths = new Set(routes.map((r) => r.path));

  /** The page an entry lands on, and the tab it names (path form or ?tab=). */
  const target = (to) => {
    const [pathOnly, qs] = to.split("?");
    const queryTab = qs ? new URLSearchParams(qs).get("tab") : null;
    if (routePaths.has(pathOnly)) return { page: pathOnly, tab: queryTab };
    const cut = pathOnly.lastIndexOf("/");
    const parent = pathOnly.slice(0, cut) || "/";
    if (cut > 0 && tabbed.has(parent) && routePaths.has(parent)) return { page: parent, tab: pathOnly.slice(cut + 1) };
    return { page: null, tab: queryTab };
  };

  // (1) Every registry target must be a real route (a tab path resolves through its page).
  for (const e of entries) {
    const pathOnly = e.to.split("?")[0];
    if (target(e.to).page === null) {
      fail(panel.name, `registry entry ${e.id} points at ${pathOnly}, which is not a route in App.tsx`,
        "The route was renamed or removed, or the entry has a typo. Search would navigate to Page Not Found.");
    }
  }

  // (2) Every reachable route must be findable.
  //     Skipped: parameterised routes (reached from a record hit, not typed),
  //     redirect-only routes, the catch-all, and /login.
  const covered = new Set(entries.map((e) => target(e.to).page).filter(Boolean));
  for (const r of routes) {
    if (r.path.includes(":") || r.path.includes("*")) continue;
    if (r.redirectsOnly || r.isLayout || r.path === "/login") continue;
    if (STATE_ONLY_ROUTES.has(r.path)) continue;
    if (!covered.has(r.path)) {
      fail(panel.name, `route ${r.path} has no search registry entry`,
        `Add one to ${regPath} so the page is findable, or make it a redirect if it is not a real destination.`);
    }
  }

  // (3) Every tab an entry names must exist on its page, exactly as listed in
  //     routes/tabbed-pages.ts. A renamed tab key would otherwise fall back to
  //     the page default: search looks fine and lands on the wrong view.
  for (const e of entries) {
    const t = target(e.to);
    if (!t.page || !t.tab) continue;
    const tabs = tabbed.get(t.page);
    if (!tabs) {
      fail(panel.name, `entry ${e.id} names tab ${t.tab} on ${t.page}, a page with no tabs`,
        "The tab would be ignored. Point the entry at the page, or give the page tabs in routes/tabbed-pages.ts.");
    } else if (!tabs.includes(t.tab)) {
      fail(panel.name, `entry ${e.id} names tab ${t.tab}, which ${t.page} does not have (tabs: ${tabs.join(", ")})`,
        "A renamed tab key silently falls back to the page default — search looks fine and lands on the wrong view.");
    }
  }

  console.log(`  ${panel.name}: ${routes.length} routes, ${entries.length} registry entries`);
}

if (problems > 0) {
  console.log("");
  console.log(`ci-search-registry-check FAILED — ${problems} problem(s)`);
  process.exit(1);
}
console.log("ci-search-registry-check: OK");
'
