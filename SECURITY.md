# Security Policy

We take the security of Insula seriously — it manages tenant websites,
databases, mailboxes, and credentials, so a vulnerability can affect real
hosted data.

## Reporting a vulnerability

**Please do not open a public issue, PR, or discussion for security reports.**

Report privately through **GitHub's private vulnerability reporting**:

1. Go to the repository's **Security** tab → **Report a vulnerability**
   (or visit `https://github.com/insulahq/insula/security/advisories/new`).
2. Describe the issue, affected component/version, and reproduction steps.

This opens a private advisory visible only to you and the maintainers.

> Maintainers: private vulnerability reporting must be enabled in
> **Settings → Code security and analysis** for the link above to work.

### What to include

- Affected component (backend, panel, a `scripts/` tool, a manifest) and
  version / commit.
- Impact and a proof-of-concept or reproduction steps.
- Any suggested remediation.

### What to expect

- **Acknowledgement** within a few days.
- An assessment and, for confirmed issues, a fix coordinated with you before
  public disclosure.
- Credit in the advisory unless you prefer to remain anonymous.

Please give us reasonable time to remediate before any public disclosure.

## Supported versions

Insula is pre-1.0 and ships under [CalVer](CONTRIBUTING.md#versioning--releases).
Only the **latest released version** receives security fixes; please reproduce
on a current build before reporting.

## Scope

In scope: the platform code in this repository — the management API, admin/
tenant panels, `scripts/` tooling (bootstrap, guards), and the Kubernetes
manifests under `k8s/`.

Out of scope: vulnerabilities in upstream dependencies (report those upstream),
and the external services this platform only consumes (PowerDNS, NetBird, Dex —
ADR-022). Misconfigurations of your own deployment are your responsibility, but
we welcome reports of insecure defaults.

## A note on AGPL-3.0

Insula is AGPL-3.0. If you run a modified network service, you must offer its
source to users — including any security-relevant changes.
