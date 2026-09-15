# FBL (Feedback Loop) Complaint Processing

How the platform ingests spam complaints from mailbox providers, and
the manual registration steps an operator must perform.

## How it works

1. Mailbox providers (Microsoft, Yahoo) forward spam complaints as ARF
   reports to a registered address. The platform provisions
   **`fbl@<apex>`** (a normal mailbox under the SYSTEM tenant's apex
   email domain) for this, re-asserted by the mail self-heal pass.
2. Stalwart's report analysis intercepts mail addressed to
   `postmaster@*` and `fbl@*`, parses ARF/DMARC/TLS reports, and stores
   them server-side (`x:ArfExternalReport`).
3. The platform polls those stored reports (every 5 minutes, plus an
   immediate pull when the telemetry webhook signals one), attributes
   each complaint to a tenant via the reported/sender domain, persists
   it to `email_fbl_complaints`, and deletes the consumed report.
4. Complaint **rates** are complaints ÷ sends over rolling 7d/30d
   windows (sends come from the `email_send_counters` accounting).
   Surfaced via `GET /api/v1/admin/mail/complaints` +
   `/admin/mail/complaints/summary` and the Monitoring → Mail tab.

Reference thresholds (acted on by the notify-only alerts):
| 7-day complaint rate | Meaning |
|---|---|
| > 0.1% | Throttle territory — investigate the sender |
| > 0.3% | Suspend territory — providers will start blocking |

## Operator: registering the FBLs (manual, production IPs required)

The platform cannot do this for you — providers verify ownership of
the sending IPs/domains.

1. **Prerequisite:** the apex domain has email enabled (Admin →
   Email → Domains) so `fbl@<apex>` exists. Verify:
   `GET /api/v1/admin/mail/complaints/summary` returns 200, and the
   platform-api log line `report intake` shows `mailbox: exists`.
2. **Microsoft (Outlook/Hotmail) — JMRP + SNDS:** enroll at
   sendersupport.olc.protection.outlook.com (JMRP) with `fbl@<apex>`
   as the complaint address; add your outbound IPs to SNDS.
3. **Yahoo/AOL — CFL:** enroll at senders.yahooinc.com, complaint
   address `fbl@<apex>`, select the sending domains/IPs.
4. **Gmail:** has no FBL. Register the apex (and any high-volume
   customer domains) in Google Postmaster Tools for aggregate spam-rate
   monitoring instead.

## Verifying the pipeline (synthetic test)

Inject a synthetic ARF complaint — no real provider needed:

```sh
# From a shell with cluster access; sends a minimal ARF report to the
# intake address via the Stalwart pod's local SMTP port.
kubectl exec -n mail deploy/stalwart-mail -c rsyncd -- sh -c '
{ sleep 2; printf "EHLO test\r\n"; sleep 1
  printf "MAIL FROM:<complaints@provider.example>\r\n"; sleep 1
  printf "RCPT TO:<fbl@YOUR-APEX>\r\n"; sleep 1
  printf "DATA\r\n"; sleep 1
  printf "From: complaints@provider.example\r\nTo: fbl@YOUR-APEX\r\n"
  printf "Subject: complaint\r\nMIME-Version: 1.0\r\n"
  printf "Content-Type: multipart/report; report-type=feedback-report; boundary=b\r\n\r\n"
  printf -- "--b\r\nContent-Type: text/plain\r\n\r\ncomplaint\r\n"
  printf -- "--b\r\nContent-Type: message/feedback-report\r\n\r\n"
  printf "Feedback-Type: abuse\r\nVersion: 1\r\n"
  printf "Original-Mail-From: <user@TENANT-DOMAIN>\r\n"
  printf "Reported-Domain: TENANT-DOMAIN\r\nSource-IP: 192.0.2.1\r\n\r\n"
  printf -- "--b\r\nContent-Type: message/rfc822\r\n\r\n"
  printf "From: user@TENANT-DOMAIN\r\nSubject: x\r\n\r\nbody\r\n"
  printf -- "--b--\r\n.\r\n"; sleep 2; printf "QUIT\r\n"; sleep 1
} | nc 127.0.0.1 25'
```

Within ~10 seconds the complaint appears in
`GET /api/v1/admin/mail/complaints` attributed to the tenant owning
`TENANT-DOMAIN`.

## DMARC aggregate reports (ROADMAP R5)

The same intake path carries DMARC. Stalwart's report-analysis parses the
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

- Complaint rows: pruned at 90 days (data-retention scheduler).
- Stalwart-side report objects: deleted as soon as they're persisted;
  Stalwart's own 30d retention is only a backstop.
- Tenant deletion: complaint rows survive with `tenant_id = NULL`
  (platform reputation history outlives any one tenant).
