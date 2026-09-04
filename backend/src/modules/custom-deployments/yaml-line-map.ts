// Map a compose issue's dotted path back to the line it came from.
//
// WHY THIS EXISTS
// ---------------
// The parser reports `path: 'services.web.deploy.resources.limits.cpus'`. That
// is precise, but in a 60-line compose file a tenant still has to hunt for it
// by eye, and the deeper the path the worse it gets. An operator asked the
// obvious question: how is anyone supposed to know WHERE the problem is?
//
// js-yaml (what the parser uses) discards positions, and the `yaml` package
// that would give them is not a backend dependency — so rather than take on a
// dependency for cosmetics, this walks the raw text and records the line each
// key path appears on. Compose is indentation-structured and shallow, which
// makes that reliable for exactly the shapes the parser accepts.
//
// Deliberately conservative: anything it cannot resolve confidently gets NO
// line rather than a wrong one. A line number pointing at the wrong field is
// worse than none — the tenant edits the wrong thing and the error persists.

/** Path segment: an object key, or a sequence index. */
type Segment = { readonly kind: 'key'; readonly name: string }
  | { readonly kind: 'index'; readonly at: number };

/**
 * Split `services.web.ports[0].source` into segments.
 * Returns null for a path this resolver has no business guessing at.
 */
export function parseIssuePath(path: string): Segment[] | null {
  if (!path) return null;
  const segments: Segment[] = [];
  for (const raw of path.split('.')) {
    if (!raw) return null;
    // `ports[0]` → key `ports`, then index 0. Multiple indices (`a[0][1]`)
    // never occur in compose, but the loop handles them anyway.
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(raw);
    if (!m) return null;
    if (m[1]) segments.push({ kind: 'key', name: m[1] });
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) {
      segments.push({ kind: 'index', at: Number(idx[1]) });
    }
  }
  return segments.length > 0 ? segments : null;
}

interface Line {
  readonly no: number;      // 1-based
  readonly indent: number;
  readonly key: string | null;   // `foo:` → 'foo'
  readonly isItem: boolean;      // starts a `- ` sequence entry
}

/** Strip a quoted or bare YAML key from the start of a line body. */
function keyOf(body: string): string | null {
  // `"foo bar": v` / `'foo': v` / `foo: v`. Not a key if the colon is inside
  // a value (e.g. `image: nginx:1.27` — the FIRST colon wins, which is right).
  const quoted = /^(['"])(.*?)\1\s*:(\s|$)/.exec(body);
  if (quoted) return quoted[2];
  const bare = /^([^\s:#][^:#]*?)\s*:(\s|$)/.exec(body);
  return bare ? bare[1].trim() : null;
}

function scan(yaml: string): Line[] {
  const out: Line[] = [];
  yaml.split('\n').forEach((raw, i) => {
    const noTabs = raw.replace(/\t/g, '  '); // tabs are illegal in YAML indent
    const trimmed = noTabs.trim();
    if (!trimmed || trimmed.startsWith('#')) return;   // blank / comment
    if (trimmed === '---' || trimmed === '...') return; // doc markers
    const indent = noTabs.length - noTabs.trimStart().length;
    const dash = /^-(\s+|$)/.exec(trimmed);
    if (!dash) {
      out.push({ no: i + 1, indent, key: keyOf(trimmed), isItem: false });
      return;
    }
    // `- source: a` is BOTH a sequence item and the first key of the mapping
    // inside it, and YAML treats that key as living at the column after the
    // dash. Emit both entries on the same line number so the resolver's
    // ordinary indent walk finds the key as a child of the item — without
    // this, `volumes[0].source` failed to resolve because the key was on the
    // item's own line rather than below it.
    const body = trimmed.slice(dash[0].length);
    out.push({ no: i + 1, indent, key: null, isItem: true });
    const inner = keyOf(body);
    if (inner !== null) {
      out.push({ no: i + 1, indent: indent + dash[0].length, key: inner, isItem: false });
    }
  });
  return out;
}

/**
 * Resolve a dotted issue path to a 1-based line number, or null.
 *
 * Walks the scanned lines depth-first: for each segment, find the matching
 * child of the current node (a key at greater indent, or the Nth `- ` item),
 * then descend. Returns the line of the LAST segment it resolved fully —
 * partial matches return null, because a half-resolved path would point at a
 * parent and mislead.
 */
export function resolveLine(yaml: string, path: string): number | null {
  const segments = parseIssuePath(path);
  if (!segments) return null;
  const lines = scan(yaml);
  if (lines.length === 0) return null;

  let lo = 0;                 // search window [lo, hi)
  let hi = lines.length;
  let indent = -1;            // indent of the current parent (-1 = document)
  let found: number | null = null;

  for (const seg of segments) {
    // Children of the current node are the entries at the next indent level
    // inside the window. Take the first indent greater than the parent's —
    // YAML nesting is monotonic, so that IS the child level.
    let childIndent = -1;
    for (let i = lo; i < hi; i++) {
      if (lines[i].indent > indent) { childIndent = lines[i].indent; break; }
    }
    if (childIndent < 0) return null;

    let matchAt = -1;
    let seen = 0;
    for (let i = lo; i < hi; i++) {
      const l = lines[i];
      if (l.indent < childIndent) break;      // left the parent entirely
      if (l.indent !== childIndent) continue; // deeper — belongs to a sibling
      if (seg.kind === 'key') {
        if (!l.isItem && l.key === seg.name) { matchAt = i; break; }
      } else if (l.isItem) {
        if (seen === seg.at) { matchAt = i; break; }
        seen += 1;
      }
    }
    if (matchAt < 0) return null;

    found = lines[matchAt].no;
    // Narrow the window to this node's subtree for the next segment. The
    // subtree ends at the next entry indented at or above this node.
    lo = matchAt + 1;
    let end = hi;
    for (let i = matchAt + 1; i < hi; i++) {
      if (lines[i].indent <= lines[matchAt].indent && !(lines[i].no === lines[matchAt].no)) {
        end = i; break;
      }
    }
    hi = end;
    indent = lines[matchAt].indent;
  }
  return found;
}

/**
 * Attach `line` to every issue whose path resolves. Issues with no path, or a
 * path that does not resolve (form fields like `name`, or a key the document
 * never contained because it failed to parse), are returned untouched.
 */
export function withResolvedLines<T extends { path?: string; line?: number }>(
  yaml: string,
  issues: readonly T[],
): T[] {
  return issues.map((issue) => {
    if (!issue.path || issue.line !== undefined) return issue;
    const line = resolveLine(yaml, issue.path);
    return line === null ? issue : { ...issue, line };
  });
}
