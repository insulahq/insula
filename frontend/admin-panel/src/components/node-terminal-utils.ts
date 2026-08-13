/**
 * Tiny helpers shared by the node-terminal components.
 *
 * WHY ITS OWN MODULE: `titleCase` used to live in NodeTerminalModal.tsx, and
 * BackgroundTerminalsDock imported it from there. The dock is rendered by the
 * app-level NodeTerminalHost, so that single one-line utility import pulled the
 * ENTIRE modal module — including the `step-up-password` input inside
 * NodeTerminalStepUpDialog — into the entry chunk that every page view loads.
 * The operator's password manager then prompted on every navigation.
 *
 * Lazy-loading the modal did not help on its own: rolldown reported
 * INEFFECTIVE_DYNAMIC_IMPORT, because a module that is ALSO statically imported
 * anywhere stays in the chunk of that static importer. Splitting the leaf
 * utility out is what actually breaks the edge.
 *
 * Keep this module free of JSX and of any import from NodeTerminalModal.
 */

/**
 * Capitalize the first character so a node name like `k8s-local` renders as
 * `K8s-local` in the title (operator request — node names are case-insensitive
 * identifiers so this is purely cosmetic).
 */
export function titleCase(name: string): string {
  if (!name) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
