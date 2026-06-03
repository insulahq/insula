# host-config-reconciler — OBSERVE-ONLY host-config drift detector (W10).
#
# Reads the host-config-desired ConfigMap + the live /proc/sys values (read-only
# mount), classifies each desired sysctl ok|drift|unreadable|not-allowed, and
# writes one host-config-drift-<node> ConfigMap. NEVER writes host state.
#
# Distroless static — no shell, no package manager. Runs as root (UID 0) inside
# a locked-down container (drop ALL caps, no privileged, readOnlyRootFilesystem,
# RuntimeDefault seccomp) because /proc/sys/* values are root-readable on most
# distros; allowPrivilegeEscalation:false enforces no setuid escalation.
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY *.go ./
# Validate in the build so `docker build` is the local CI: vet + race-free tests
# gate the binary.
RUN go vet ./... && go test ./...
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/host-config-reconciler ./...

FROM gcr.io/distroless/static:latest
COPY --from=build /out/host-config-reconciler /usr/local/bin/host-config-reconciler
ENTRYPOINT ["/usr/local/bin/host-config-reconciler"]
