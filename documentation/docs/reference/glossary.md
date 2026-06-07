---
verified: 2026.6.7
---

# Glossary

| Term | Meaning |
|---|---|
| **Tenant** | One isolated customer account: websites, databases, mailboxes, files, backups — plus the people who may log in to manage them |
| **Plan** | A reusable bundle of limits and features assigned to tenants; individual values can be overridden per tenant |
| **Subscription** | The link between a tenant and a plan, with an expiry date and renewal state |
| **Catalog** | The single library tenants deploy from — one set of entries spanning runtimes, databases/services, and full applications, fed by one or more catalog repositories |
| **Catalog repository** | A Git repo of catalog entries (manifests + images) registered with the platform. The **Official Catalog** is registered by default; operators can remove it and add their own |
| **Catalog entry** | One deployable item in the catalog — a runtime, a database/service, or a complete application |
| **Deployment** | One running instance of a catalog entry (or a custom container) for a tenant |
| **Application** | A catalog entry that is a complete, self-contained product (e.g. WordPress) bundling its own database, cache, and ingress |
| **Custom container** | A tenant-supplied container image or compose stack, run under the same isolation rules as catalog entries |
| **Route** | The rule that maps a hostname (+ path) to a workload, including TLS and WAF settings |
| **DNS mode** | How a domain's DNS is handled: managed by the platform's nameservers, or externally with a CNAME/records you set yourself |
| **Node** | One Linux server in the cluster. *Server* nodes can run the control plane; *worker* nodes run tenant workloads |
| **HA mode** | The one-action switch that replicates the platform's brain (database ×3, storage ×3, panels spread) across servers |
| **Backup target** | External storage (S3-compatible, SFTP, SMB/CIFS) that the operator registers; all backups land on targets, never only on-cluster |
| **Snapshot class** | A category of backup (system, tenant, mail) that is assigned to a backup target |
| **Tenant bundle** | One tenant's complete backup — files, databases, mail, configuration — restorable as a whole or piece-by-piece |
| **Restore cart** | The shopping-cart UI for granular restore: pick individual files, mailboxes, or databases across backups, then execute once |
| **DR bundle** | The encrypted whole-platform recovery bundle (secrets, configuration, recovery pointers) for cold restore onto fresh hardware |
| **platform-ops** | The signed on-node CLI for upgrades, migrations, diagnostics, and disaster recovery — works with the platform down ([reference](cli.md)) |
| **Webmail engine** | The webmail app served to users: Roundcube (classic) or Bulwark (JMAP-native); selectable platform-wide |
| **Passkey** | Phishing-resistant WebAuthn credential usable for sign-in or as second factor |
| **Step-up authentication** | A fresh credential check required just before sensitive actions (e.g. opening a node terminal) |
| **SYSTEM tenant** | The built-in tenant that owns the platform's own hostnames and transactional mailboxes; cannot be suspended or deleted |
| **CalVer** | The release numbering scheme: `YYYY.M.PATCH`, e.g. `2026.6.7` |
