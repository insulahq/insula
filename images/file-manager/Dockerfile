# NOTE: the old "patch sftp-server for chroot confinement" stage is GONE.
# It patchelf'd OpenSSH's sftp-server to find its interpreter at /.platform/lib
# so it could be exec'd INSIDE the jail — which is exactly why the jail had to
# carry a binary, a loader and libs that the tenant could read and write.
# sftp-serve chroots and serves in-process, so none of that exists any more.

# Stage 2: Build sftp-serve (static Go binary: chroot + drop privs + serve SFTP).
# CGO_ENABLED=0 is LOAD-BEARING, not a size optimisation: sftp-serve drops
# privileges with syscall.AllThreadsSyscall, which returns ENOTSUP in any binary
# linked with cgo (capabilities are per-thread and the Go runtime is
# multi-threaded). With cgo the privilege drop fails closed and the process
# refuses to serve — see images/file-manager/cmd/sftp-serve/main.go.
FROM golang:1.26-alpine AS chroot-builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
RUN CGO_ENABLED=0 go build -ldflags='-s -w' -o sftp-serve ./cmd/sftp-serve

# Stage 3: Runtime
FROM node:22-alpine3.20
RUN apk add --no-cache git tar zip unzip sqlite openssh-sftp-server openssh-client rsync
COPY --from=chroot-builder /build/sftp-serve /usr/local/bin/sftp-serve
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/sftp-serve
WORKDIR /app
COPY server.mjs .
EXPOSE 8111
# Run as root to read all PVC data (database dirs owned by mysql/postgres)
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.mjs"]
