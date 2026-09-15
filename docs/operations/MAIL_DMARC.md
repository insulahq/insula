# DMARC Aggregate Report Processing

How the platform ingests DMARC aggregate reports, and the two failure modes
that kept the feature at zero data.

> **FBL (feedback-loop / ARF complaint) ingestion was retired on 2026-09-15.**
> Measured on production first: **zero** complaints ingested in the feature's
> entire life, and no `fbl@` mailbox had ever been created. The intake was
> anchored to the SYSTEM tenant's apex email domain, and in the real deployment
> the apex has no email domain at all — so the provisioner logged "skipped" on
> every 5-minute tick since install. FBL additionally requires manual
> per-provider enrolment (Microsoft JMRP/SNDS, Yahoo CFL) with production IPs.
> Retired rather than carried as a feature that could not reach its own intake
> address. Removed with it: the ARF poller, the `email_fbl_complaints` and
> `email_complaint_events` tables, the complaint-rate thresholds and their two
> notification categories, the `/admin/mail/complaints*` endpoints, the
> Monitoring → Mail complaints table, and the `auto` enforcement mode (which
> existed solely to act on complaint rates). Migration `0119_retire_fbl.sql`.

## How it works

Stalwart's report-analysis parses the
RFC 7489 aggregate XML itself and stores an `x:DmarcExternalReport` registry
object; `mail-events/dmarc.ts` polls those on the 5-minute mail tick (and on the
`incoming-report.*` webhook debounce), attributes each by its `policyDomain`,
writes `email_dmarc_reports` + `email_dmarc_sources`, and destroys the consumed
object. Surfaced under **Monitoring → Mail**.

### The `rua=` address must be a real mailbox

This is the failure that kept the feature at zero data before R5. The platform
published `rua=mailto:dmarc-reports@<domain>` — an address nothing ever created.
**Stalwart does not bypass RCPT validation for report addresses**: an
unregistered one is refused with `550 5.1.2 Mailbox does not exist`, so every
report was rejected at the door. Registering the address in
`ReportSettings.inboundReportAddresses` is necessary but **not sufficient** —
`postmaster@*` is in that list, has no account, and is refused.

The published address is now `dmarc@<domain>`, and `report-intake-reconciler`
creates that mailbox on every enabled email domain. Same-domain on purpose: a
cross-domain `rua` needs an RFC 7489 §7.1 authorisation record
(`<domain>._report._dmarc.<apex> TXT "v=DMARC1"`) in the reporting domain's zone,
and most reporters refuse without it — which would look identical to the bug.

**Check an existing domain:**

```bash
dig +short TXT _dmarc.<domain>            # rua= must be dmarc@<domain>
# and the mailbox must exist:
kubectl -n platform exec -i system-db-1 -c postgres -- \
  psql -U postgres -d platform -At -c \
  "SELECT m.local_part FROM mailboxes m
     JOIN email_domains ed ON ed.id = m.email_domain_id
     JOIN domains d ON d.id = ed.domain_id
    WHERE d.domain_name = '<domain>';"
```

### Verifying without waiting for a real reporter

Deliver an aggregate report yourself. Reports are gzipped XML attachments; the
address must exist first (see above).

A working probe lives in the R5 PR description; the essentials are a
`multipart/mixed` message to `dmarc@<domain>` with an `application/gzip`
attachment named `<org>!<domain>!<begin>!<end>.xml.gz`. Then read it back:

```bash
# x:DmarcExternalReport/query + /get via the Stalwart mgmt JMAP endpoint
# (urn:stalwart:jmap — NOT urn:ietf:params:jmap:stalwart, which 400s)
```

Two shape details, both of which fail silently if assumed from the RFC:

- `records`, `dkimResults`, `spfResults` are **objects keyed by decimal-string
  index**, not arrays. Iterating them as arrays yields nothing and the domain
  reports zero messages.
- results are camelCase — SPF softfail is `softFail`.

### Reading the recommendation

The policy recommendation refuses far more often than it approves, by design:

| It says | Because |
|---|---|
| keep observing — only N days of reports | under 14 days has not yet seen a weekly or monthly sender |
| keep observing — too little traffic | under 100 messages / 5 reports is not a trend |
| keep observing — below the required rate | 99% for `p=quarantine`, 99.5% for `p=reject` |
| keep observing — N sources still failing | the aggregate rate can clear the bar while a low-volume legitimate sender fails everything it sends |
| safe to move to p=… | all of the above hold |

Nothing tightens a policy automatically. `p=reject` on a domain with one
unaligned legitimate sender stops that sender's mail immediately rather than
degrading.

## Data lifecycle

- Stalwart-side report objects: deleted as soon as they're persisted;
  Stalwart's own 30d retention is only a backstop.
- Tenant deletion: report rows survive with `tenant_id = NULL` (platform
  reputation history outlives any one tenant).

## Why the intake no longer depends on the apex

The per-domain `dmarc@` loop used to sit inside an `if (apex) … else` branch
that existed only to place the apex FBL mailbox. With no apex email domain —
production's actual state — the whole branch was skipped and **not one** hosted
domain got its DMARC mailbox. Upgrading past the `rua=` generator fix alone
would therefore have repointed every record at a second address that also did
not exist. The gate was removed with the FBL retirement.
