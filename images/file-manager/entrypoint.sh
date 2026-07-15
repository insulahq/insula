#!/bin/sh
set -e

# Prepare SFTP chroot jail at /jail (emptyDir volume, NOT on the customer PVC).
# The pod spec mounts the tenant PVC at /jail/home (the kubelet mounts it before
# this entrypoint runs), so the user's SFTP root (/home/) contains only their
# files — zero platform artifacts. sftp-chroot performs NO runtime mount, so the
# pod needs no CAP_SYS_ADMIN.
#
# NOTE: there is no jail to build any more.
#
# This used to create /jail/.platform (a patchelf'd sftp-server + ld-musl +
# libs), /jail/dev/null and a stub /jail/etc/passwd — all of it required only
# because the old design chroot'ed and then EXEC'd a dynamically-linked OpenSSH
# sftp-server. All of it was readable AND writable by the tenant (the ambient
# DAC_OVERRIDE the design needed defeats the mode-711 hiding), and a tenant
# could brick their own SFTP by overwriting the jail's /etc/passwd.
#
# sftp-serve chroots into the tenant PVC and serves SFTP in-process, so the jail
# is exactly the tenant's own data and needs no scaffolding. See
# images/file-manager/cmd/sftp-serve/main.go.


exec "$@"
