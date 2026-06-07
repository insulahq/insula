---
verified: 2026.6.7
---

# Supported operating systems

`bootstrap.sh` checks the host OS before touching anything and **refuses
unsupported or end-of-life systems outright** — better a clear error at minute
zero than a half-installed platform.

## Tier 1 — recommended, fully tested

| OS | Versions |
|---|---|
| Debian | 12 (bookworm), 13 (trixie) |
| Ubuntu LTS | 22.04 (jammy), 24.04 (noble) |

## Tier 2 — supported

| OS | Versions | Notes |
|---|---|---|
| RHEL | 9 | EPEL is enabled for fail2ban/age |
| Rocky Linux | 9 | " |
| AlmaLinux | 9 | " |
| CentOS Stream | 9, 10 | " |
| Amazon Linux | 2023 | No EPEL needed — required packages ship in core repos |

## Refused (fail-fast)

CentOS Linux 7/8 · Ubuntu before 22.04 · Amazon Linux 2 (EOL 2026-06-30) ·
Alpine · Talos — and any distribution not listed above.

!!! note "Why so strict?"
    The installer manages the host firewall (nftables), kernel settings, and
    system packages. Each supported OS path is exercised by an automated
    install matrix; an unknown distribution would mean silently untested
    host-level behavior on a machine that hosts other people's websites.

??? info "Under the hood"
    Detection lives in `check_os()` in
    [`scripts/bootstrap.sh`](https://github.com/insulahq/insula/blob/main/scripts/bootstrap.sh);
    apt vs dnf handling is dispatched via `OS_FAMILY`, with Amazon Linux 2023
    flagged as `OS_VARIANT=amzn2023` for its no-EPEL package path. The DinD
    test matrix is `scripts/test-bootstrap-os-matrix.sh`.
