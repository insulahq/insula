#!/usr/bin/env bash
#
# CI guard — the four things every notification must do.
#
# Why this guard exists
# ---------------------
# an operator upgraded production and received, among others:
#
#   "Email sending limit reached (hour)"     — which mailbox? no link.
#   "3fd54013-fc40-4e13-adaf-ed1b5dd39f28 sent 53 of 50 messages"
#   "Mailboxes over storage quota recovered."
#   "Your subscription was modified."
#
# Every one of those rendered exactly as designed. The templates were valid,
# the variables matched their payloads, the deliveries all said `sent`. Nothing
# in CI had an opinion about whether the result was worth reading.
#
# The requirement, in the operator's words: every mail and notification must
# clearly show WHAT, WHO and WHEN, and link to the appropriate page.
#
#   WHO   — the template names its subject (a tenant, mailbox, host, node,
#           rule, object), not just its category.
#   WHEN  — the template renders a timestamp.
#   LINK  — the category resolves at least one destination.
#   NO ID — no template may print a raw id, and no emitter may pass an id
#           where a human label is expected.
#
# Allowlists are short and justified. An entry is a promise that the gap is
# intentional — not a place to silence the guard.
#
# Every arm here was negative-tested before shipping, because an arm that
# cannot fail is not a check:
#
#   WHEN   found 25 categories with no timestamp on first run.
#   NO ID  flagged a comment that QUOTED the offending line (comments are now
#          stripped) — and the real `userName: userId` before it was removed.
#   LINK   fails when a STATIC_PATHS entry is deleted.
#   WHO    fails for 11 categories when the subject variables are stripped out
#          of the templates. Its FIRST draft was vacuous: `greeting` was in the
#          subject list and the shared email wrapper renders a greeting on
#          every template, so all 67 passed no matter what their bodies said.
#
# NOTE FOR EDITORS: the node program below is a single-quoted shell argument.
# An apostrophe anywhere inside it terminates that string and the guard dies
# with "SyntaxError: Unexpected end of input" — which is how it broke the
# first time. Write "the first run of this arm", never "the arm's first run".
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CATEGORIES="$REPO_ROOT/backend/src/modules/notifications/categories/seed.ts"
TEMPLATES="$REPO_ROOT/backend/src/modules/notifications/templates/seed-data.ts"
ACTION_PATH="$REPO_ROOT/backend/src/modules/notifications/action-path.ts"
EVENTS="$REPO_ROOT/backend/src/modules/notifications/events.ts"
# SLO rule descriptions are rendered into the notification body verbatim, so
# they are notification copy and answer to the same COPY arm. rules.ts imports
# nothing, so loading it here adds no runtime dependency to the guard.
SLO_RULES="$REPO_ROOT/backend/src/modules/monitoring/rules.ts"

echo "── notification usefulness guard ────────────────────────────────────"

for f in "$CATEGORIES" "$TEMPLATES" "$ACTION_PATH" "$EVENTS" "$SLO_RULES"; do
  [ -f "$f" ] || { echo "FAIL: missing $f" >&2; exit 1; }
done

CATEGORIES="$CATEGORIES" TEMPLATES="$TEMPLATES" ACTION_PATH="$ACTION_PATH" EVENTS="$EVENTS" \
  SLO_RULES="$SLO_RULES" \
  BACKEND_SRC="$REPO_ROOT/backend/src" \
node --experimental-strip-types --no-warnings --input-type=module -e '
import { readFileSync, readdirSync } from "node:fs";

const cats = await import(process.env.CATEGORIES);
const tpls = await import(process.env.TEMPLATES);
const paths = await import(process.env.ACTION_PATH);
const EVENTS_SRC = readFileSync(process.env.EVENTS, "utf8");
const slo = await import(process.env.SLO_RULES);

const ALL_CATEGORIES = cats.ALL_CATEGORIES;
const ALL_SEED_TEMPLATES = tpls.ALL_SEED_TEMPLATES;
if (!Array.isArray(ALL_CATEGORIES) || ALL_CATEGORIES.length === 0) {
  console.error("FAIL: ALL_CATEGORIES is empty — a guard over nothing passes trivially.");
  process.exit(1);
}
if (!Array.isArray(ALL_SEED_TEMPLATES) || ALL_SEED_TEMPLATES.length === 0) {
  console.error("FAIL: ALL_SEED_TEMPLATES is empty — a guard over nothing passes trivially.");
  process.exit(1);
}
if (!Array.isArray(slo.SLO_RULES) || slo.SLO_RULES.length === 0) {
  console.error("FAIL: SLO_RULES is empty — the COPY arm over the SLO rules would pass trivially.");
  process.exit(1);
}
if (typeof paths.notificationActionPath !== "function") {
  console.error("FAIL: notificationActionPath did not load — every LINK check would pass vacuously.");
  process.exit(1);
}

// ── WHO: variables that name a SUBJECT rather than a category ────────────
const SUBJECT_VARS = new Set([
  "tenantName", "tenantLabel", "tenantList", "tenantCount", "tenantLink",
  "mailboxAddress", "mailboxCount", "hostname", "certSubject", "nodeName",
  "ruleName", "subject", "objectLabel", "deploymentName", "domainName",
  "clusterName", "jobName", "ip", "component", "resource", "topSenders",
  "subAccountEmail", "itemCount", "scheduleName", "targetName", "level",
  // Added after the first real run of this arm named these as gaps: each IS a
  // subject, under a name the first draft of this list did not know.
  "backupName", "taskName", "summary",
  // `dependency` names what the platform could not reach ("the Kubernetes
  // API"). Added 2026-09-18 with admin.cert_check_unavailable/_resumed, where
  // the subject is deliberately NOT a certificate: the whole point of those
  // two is that the platform could not read any certificate, so naming one
  // would be the false claim they exist to replace.
  "dependency",
  // `workload` is the Deployment whose pods are gone ("moodle", "my-mariadb").
  // It is the same class of subject as `deploymentName`, which is already here;
  // the tenant-facing copy uses `workload` because "deployment" is Kubernetes
  // vocabulary and the panel calls these applications. Added 2026-09-25 with
  // admin.tenant_workloads_down / tenant.workloads_down.
  "workload",
]);
// NOT in that list, deliberately: `userName`, `contactName` and `greeting`.
// They name the RECIPIENT, not the subject, and the shared email wrapper
// renders a greeting on every single template — so counting them made this
// arm pass for all 67 categories no matter what their bodies said. Caught by
// negative-testing the arm: stripping every real subject variable out of the
// node templates still produced OK. An arm that cannot fail is not a check.

// Categories whose subject IS the recipient, so naming one would be odd
// ("Hi Alex — Alex changed their password"). The greeting names them.
const SUBJECT_EXEMPT = new Set([
  "security.password_reset",
  "security.password_changed",
  "tenant.suspended",
  "tenant.restored",
  "tenant.archived",
  "tenant.deleted",
  // A tenant reading about their own bandwidth already knows whose it is; the
  // numbers are the content. The ADMIN copies carry `tenantLabel` and are not
  // exempt.
  "tenant.bandwidth_warning",
  "tenant.bandwidth_exceeded",
]);

// Categories where a timestamp adds nothing because the event IS the message
// and it is read immediately, or the body already carries a specific date.
const WHEN_EXEMPT = new Set([
  "security.password_reset",
  "subscription.expiry_warning",   // renders {{expiresAt}}, a more useful date
  "subscription.renewed",          // renders {{newExpiresAt}}
  "tls.certificate_issued",        // renders {{expiresAt}}
]);

const DATE_VARS = ["occurredAt", "expiresAt", "newExpiresAt", "bootedAtText", "sentAt"];
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const REF_RE = /\{\{\{?\s*(?:#(?:if|unless|each)\s+)?([A-Za-z_][\w.]*)\s*\}?\}\}/g;

function refsOf(text) {
  const out = new Set();
  for (const m of String(text ?? "").matchAll(REF_RE)) out.add(m[1]);
  return out;
}

const failures = [];
const byCat = new Map();
for (const t of ALL_SEED_TEMPLATES) {
  if (!byCat.has(t.categoryId)) byCat.set(t.categoryId, []);
  byCat.get(t.categoryId).push(t);
}

for (const cat of ALL_CATEGORIES) {
  const templates = byCat.get(cat.id) ?? [];
  if (templates.length === 0) {
    failures.push(`${cat.id}: no template on any channel`);
    continue;
  }

  const allRefs = new Set();
  for (const t of templates) {
    for (const r of refsOf(t.subjectTemplate)) allRefs.add(r);
    for (const r of refsOf(t.bodyTemplate)) allRefs.add(r);

    // NO ID — a literal id in a template reaches every reader of it.
    if (UUID_RE.test(String(t.subjectTemplate ?? "")) || UUID_RE.test(String(t.bodyTemplate ?? ""))) {
      failures.push(`${cat.id}/${t.channel}: template contains a literal id`);
    }
  }

  // WHO
  if (!SUBJECT_EXEMPT.has(cat.id)) {
    const named = [...allRefs].some((r) => SUBJECT_VARS.has(r));
    if (!named) {
      failures.push(`${cat.id}: names no subject — renders a category, not a thing (WHO)`);
    }
  }

  // WHEN — checked on EMAIL only, on purpose.
  //
  // The in-app feed renders `createdAt` beside every row and push notifications
  // carry their arrival time on the device, so a timestamp inside those bodies
  // is duplication. An email is read hours later, in a thread, with no such
  // frame — that is the channel where "when did this happen?" is unanswerable
  // without it.
  if (!WHEN_EXEMPT.has(cat.id)) {
    const emailTemplates = templates.filter((t) => t.channel === "email");
    for (const t of emailTemplates) {
      const refs = new Set([...refsOf(t.subjectTemplate), ...refsOf(t.bodyTemplate)]);
      if (!DATE_VARS.some((d) => refs.has(d))) {
        failures.push(`${cat.id}/email: renders no timestamp (WHEN)`);
      }
    }
  }

  // LINK — resolved the same way the panel and the emails resolve it.
  const link = paths.notificationActionPath({
    categoryId: cat.id,
    resourceType: "tenant",
    resourceId: "00000000-0000-4000-8000-000000000000",
  });
  if (!link) failures.push(`${cat.id}: resolves no destination (LINK)`);
}

// NO ID — an emitter that hands an id to a label/name variable. This is the
// exact shape that mailed "3fd54013-… saturated its hour sending limit".
//
// Comments are stripped first: the guard flagged a comment that QUOTED the
// offending line while explaining why it had been removed, which is the
// grep-matches-its-own-documentation trap.
const EVENTS_CODE = EVENTS_SRC
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");
for (const m of EVENTS_CODE.matchAll(/\b(\w*(?:Label|Name|Address|Subject))\s*:\s*([A-Za-z_][\w.]*)/g)) {
  const [, key, value] = m;
  if (/(^|\.)\w*[iI]d$/.test(value)) {
    failures.push(`events.ts: \`${key}: ${value}\` passes an id where a human label is expected (NO ID)`);
  }
}

// The same arm, for labels built as TEMPLATE LITERALS. The matcher above only
// sees a bare identifier, so it read straight past
//
//     objectLabel: `job ${payload.jobId}`
//
// which reached a tenant on 2026-09-17 as "IMAPSync migration: job (unnamed)"
// — the dispatcher resolved the job id against tenants, users, mailboxes and
// domains, matched none of them, and substituted its placeholder. The guard
// existed, the arm existed, and the shape was simply outside what it could see.
for (const m of EVENTS_CODE.matchAll(/\b(\w*(?:Label|Name|Address|Subject))\s*:\s*`([^`]*)`/g)) {
  const [, key, literal] = m;
  for (const interp of literal.matchAll(/\$\{([^}]*)\}/g)) {
    if (/\b\w*[iI]d\b/.test(interp[1])) {
      failures.push(
        `events.ts: \`${key}\` is built from an id (\`${interp[1].trim()}\`) where a human label is expected (NO ID)`,
      );
    }
  }
}

// ── COPY: a description is read by an operator, not a reviewer ───────────
//
// Added 2026-09-17 after the operator asked why the notification settings page
// showed "These were the last four events on the legacy notifyUser path —
// in-app only, so none of them had EVER reached a tenant by email."
//
// `description` is UI copy: the admin Notifications page renders it under the
// display name and searches it. Eleven of them carried the reasoning for
// having BUILT the category instead — "Previously in-app only", a template
// fragment, a date, a PR-era narrative. All true, none of it any help to
// somebody deciding whether to mute a category.
//
// The arm bans the markers of that narrative, not prose in general: a date, a
// PR reference, code or template syntax, an internal symbol, and the handful
// of phrases that only ever introduce history. It says WHAT and WHEN, or it
// does not belong in the field.
const COPY_BANS = [
  [/20\d\d-\d\d-\d\d|\b20\d\d-\d\d\b/, "a date — describe the notification, not when it changed"],
  [/#\d{2,}/, "a PR or issue reference"],
  [/\{\{|\}\}|`|\.ts\b|\(\)/, "code or template syntax"],
  [/\bnotifyUser\b|\bdispatchSafe\b|\bemitEvent\b|\bcategory_id\b|\bcategoryId\b|notifications table/i,
    "an internal symbol or table name"],
  [/\bpreviously\b|\bused to\b|\blegacy\b|\bsplit out of\b|\bthese were\b|\bhad EVER\b|\balready existed\b/i,
    "implementation history — say what it reports, not what it replaced"],
  [/\bon DEV\b|\bon STAGING\b|\bon PRODUCTION\b/,
    "the name of an environment — the reader is IN one"],
  [/\bfor three days\b|\bsat for\b|\bfor a year\b|\bfor months\b/i,
    "an incident anecdote — describe the condition, not the time it once went unnoticed"],
];
// Extended 2026-09-17: the first version of this arm read the notification
// CATEGORIES only, and an SLO alert sailed straight past it — a live DEV
// notification read "Detection and the repair button already existed; nothing
// escalated, so a drift sat for three days on DEV while the mail health card
// stayed green". An SLO description is pasted into the notification body, so
// it is the same field by another name. Two more markers were added with it
// (an environment name, an incident anecdote), both taken from that text.
const COPY_SUBJECTS = [
  ...ALL_CATEGORIES.map((c) => ({ label: c.id, description: c.description ?? "" })),
  ...slo.SLO_RULES.map((r) => ({ label: `slo:${r.id}`, description: r.description ?? "" })),
];
for (const c of COPY_SUBJECTS) {
  for (const [re, why] of COPY_BANS) {
    const hit = c.description.match(re);
    if (hit) {
      failures.push(`${c.label}: description contains ${why} (COPY) — ${JSON.stringify(hit[0])}`);
    }
  }
}

// ── EMITTER: a category nothing ever dispatches cannot notify anyone ─────
//
// Added 2026-09-17. The audit behind this epic found SIX categories with
// complete templates, valid variables and no caller at all — they satisfied
// every other arm of this guard while being incapable of firing. A category
// with no emitter is not a notification; it is a plan.
//
// The FIRST draft of this arm searched events.ts for the id and got two
// answers wrong in opposite directions, which is worth recording because both
// are easy to repeat:
//
//   * `admin.security_hardening_drift` read as WIRED. events.ts is where the
//     `notifyAdminSecurityHardeningDrift` function is DEFINED, so the id is
//     right there in the file — while nothing anywhere calls the function.
//     Presence at the definition proves nothing about whether it ever runs.
//   * `tenant.suspended` read as DORMANT. It is dispatched from
//     lifecycle-hooks/notify-on-transition.ts via a transition→id map, which a
//     search scoped to events.ts cannot see.
//
// So: build the emitter functions from events.ts, then ask the REST of the
// backend whether anything calls them or dispatches the id directly. The
// metadata files are excluded because listing a category is not emitting it.
const METADATA_SUFFIXES = [
  "notifications/events.ts",
  "notifications/categories/seed.ts",
  "notifications/templates/seed-data.ts",
  "notifications/action-path.ts",
];
const backendSrc = process.env.BACKEND_SRC;
const files = readdirSync(backendSrc, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts") && !f.includes(".test.") && !f.includes("__tests__"))
  .map((f) => `${backendSrc}/${f}`.replace(/\\/g, "/"));

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

// Patterns for ids that are ASSEMBLED — `admin.slo_alert_${severity}` never
// appears literally. A stricter test would report live notifications as
// dormant, which is how a guard teaches people to ignore it.
const idPattern = (lit) =>
  new RegExp("^" + lit.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\$\{[^}]*\}/g, "[\\w-]+") + "$");

// 1. Which category ids does each notify* function in events.ts dispatch?
//
// Three shapes, all present in the file: a literal, a template, and a
// PARAMETER-KEYED MAP (`dispatchSafe(db, OPERATIONAL_CATEGORY[subsystem], …)`).
// The ids in that map live outside the function body, so the six generic
// subsystem buckets read as dormant until this resolver existed — while 19
// files call the function that dispatches them.
const src = stripComments(EVENTS_SRC);
const constMaps = new Map();
for (const m of src.matchAll(/const (\w+) = \{([^}]*)\}\s*as const;/g)) {
  const ids = [];
  for (const q of m[2].matchAll(/["\x27]([a-z_]+\.[a-z_0-9]+)["\x27]/g)) ids.push(q[1]);
  if (ids.length > 0) constMaps.set(m[1], ids);
}

const fnIds = new Map();
{
  const fnRe = /export async function (notify\w+)\s*\(([\s\S]*?)\n\}/g;
  for (const m of src.matchAll(fnRe)) {
    const [, fnName, body] = m;
    const ids = [];
    for (const q of body.matchAll(/["\x27]([a-z_]+\.[a-z_0-9]+)["\x27]/g)) ids.push(q[1]);
    for (const t of body.matchAll(/`([a-z_]+\.[^`]*\$\{[^`]*)`/g)) ids.push(t[1]);
    for (const ref of body.matchAll(/dispatchSafe\(\s*\w+\s*,\s*(\w+)\s*\[/g)) {
      for (const id of constMaps.get(ref[1]) ?? []) ids.push(id);
    }
    fnIds.set(fnName, ids);
  }
}

// 2. What does the rest of the backend actually call or dispatch?
const wiredIds = new Set();
const wiredPatterns = [];
for (const file of files) {
  if (METADATA_SUFFIXES.some((suffix) => file.endsWith(suffix))) continue;
  let code;
  try { code = stripComments(readFileSync(file, "utf8")); } catch { continue; }
  for (const [fnName, ids] of fnIds) {
    // Name reference, NOT `name(`: several emitters are injected as ports
    // (`notifyDisabled: notifyAdminWalArchiveAutoDisabled`) and are never
    // written with parentheses at the call site. Nobody imports a notify
    // function in order not to use it.
    if (!new RegExp(`\\b${fnName}\\b`).test(code)) continue;
    for (const id of ids) {
      if (id.includes("${")) wiredPatterns.push(idPattern(id)); else wiredIds.add(id);
    }
  }
  for (const q of code.matchAll(/["\x27]([a-z_]+\.[a-z_0-9]+)["\x27]/g)) wiredIds.add(q[1]);
  for (const t of code.matchAll(/`([a-z_]+\.[^`]*\$\{[^`]*)`/g)) wiredPatterns.push(idPattern(t[1]));
}
const isWired = (id) => wiredIds.has(id) || wiredPatterns.some((re) => re.test(id));

// Categories that deliberately have no emitter, each with the feature it
// waits on. An entry here is a promise that the gap is intentional and
// reviewed — NOT a place to silence the arm. Operator decision 2026-09-17:
// keep both rather than delete them, because both describe things the
// platform plausibly will do.
const DORMANT = new Map([
  ["security.password_reset",
    "no self-service password-reset flow exists in the API; the only reset is the break-glass CLI"],
  ["admin.security_hardening_drift",
    "nothing defines what hardening drift IS — the snapshot is a point-in-time read with no stored baseline"],
]);

for (const c of ALL_CATEGORIES) {
  const wired = isWired(c.id);
  if (!wired && !DORMANT.has(c.id)) {
    failures.push(`${c.id}: nothing dispatches this category (EMITTER) — it cannot fire`);
  }
  if (wired && DORMANT.has(c.id)) {
    // The tripwire half: the feature arrived, so the record must stop calling
    // it dormant. Failing here is the guard doing its job.
    failures.push(
      `${c.id}: listed as DORMANT but something now dispatches it (EMITTER) — remove it from DORMANT`,
    );
  }
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} notification(s) would not be worth reading:\n`);
  for (const f of failures.sort()) console.error("  " + f);
  console.error(`
Every notification must say WHAT happened, to WHOM or to WHICH object, WHEN,
and link to the page that acts on it. A notification that renders its category
and nothing else is noise, and noise is what makes an operator stop reading
the ones that matter.`);
  process.exit(1);
}

console.log(`OK: ${ALL_CATEGORIES.length} categories — each names a subject, carries a timestamp, resolves a destination, prints no ids, has an emitter, and describes itself to an operator rather than a reviewer (${DORMANT.size} deliberately dormant).`);
console.log(`OK: ${slo.SLO_RULES.length} SLO rule descriptions read as operator copy (their text is pasted into the notification body).`);
'
