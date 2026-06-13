# migration-tools — tooling image for the Plesk→platform migration legs
# (R1). The discovery leg reuses mail-backup-tools (ssh + python3 only);
# the DB + content legs need a MySQL/MariaDB client + rsync that that
# image does not carry, so they run as Jobs on THIS image.
#
# Used by (backend spawns these Jobs in the tenant namespace):
#   - DB leg     — plesk-db-sync.sh: ssh to Plesk, `mysqldump` each client
#                  database, stream it straight into the tenant's MariaDB
#                  Service (no intermediate file).
#   - Content leg (later PR) — plesk-content-sync.sh: rsync the vhost
#                  docroot off Plesk into the tenant PVC.
#
# Tools shipped:
#   - openssh-client — ssh + ssh-keyscan to the Plesk box (accept-new).
#   - mariadb-client — the LOCAL `mariadb`/`mysql` client that receives the
#                      dump stream and writes it into the tenant MariaDB.
#                      (mysqldump runs on the REMOTE Plesk box, which has
#                       its own client; we don't need a local mysqldump.)
#   - rsync          — content-leg docroot sync (Plesk has rsync too).
#   - gzip + tar     — compress streams / archives.
#   - ca-certificates, coreutils — TLS + sha256sum/standard tools.
#
# debian:trixie-slim base matches mail-backup-tools / firewall images so the
# platform's distinct base-image surface stays small. Trivy CRITICAL/HIGH
# (fixable) must pass. Image budget: <140 MiB.

FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssh-client \
      sshpass \
      mariadb-client \
      rsync \
      gzip \
      tar \
      ca-certificates \
      coreutils \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
           /usr/share/doc/* /usr/share/man/*

# DB leg: stream each Plesk database into the tenant MariaDB.
# Argv: env-driven (PLESK_HOST/PORT/USER, DB_HOST, DB_NAMES). See script header.
COPY plesk-db-sync.sh /usr/local/bin/plesk-db-sync.sh
RUN chmod 755 /usr/local/bin/plesk-db-sync.sh

# Content leg (later PR): rsync a vhost docroot off Plesk into the tenant PVC.
COPY plesk-content-sync.sh /usr/local/bin/plesk-content-sync.sh
RUN chmod 755 /usr/local/bin/plesk-content-sync.sh

# No-op default so `docker run …` doesn't error; the orchestrator always
# overrides command/args.
CMD ["sh", "-c", "echo migration-tools image ready; sleep 1"]
