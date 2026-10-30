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
FROM golang:1.26-alpine@sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308 AS chroot-builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
RUN CGO_ENABLED=0 go build -ldflags='-s -w' -o sftp-serve ./cmd/sftp-serve

# Stage 3: Runtime
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4
# Package fixes published after the base image was built (an image is only
# rebuilt when its sources change): take them at build time.
RUN apk upgrade --no-cache \
 && apk add --no-cache git tar zip unzip sqlite openssh-sftp-server openssh-client rsync
COPY --from=chroot-builder /build/sftp-serve /usr/local/bin/sftp-serve
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/sftp-serve
WORKDIR /app
COPY server.mjs trash.mjs dirty-governor.mjs ./
EXPOSE 8111
# Run as root to read all PVC data (database dirs owned by mysql/postgres)
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.mjs"]
