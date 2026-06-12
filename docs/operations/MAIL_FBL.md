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

## Data lifecycle

- Complaint rows: pruned at 90 days (data-retention scheduler).
- Stalwart-side report objects: deleted as soon as they're persisted;
  Stalwart's own 30d retention is only a backstop.
- Tenant deletion: complaint rows survive with `tenant_id = NULL`
  (platform reputation history outlives any one tenant).
