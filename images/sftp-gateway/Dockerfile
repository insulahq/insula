FROM golang:1.26-alpine@sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308 AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o sftp-gateway .

FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
# Package fixes published after the base image was built (an image is only
# rebuilt when its sources change): take them at build time.
RUN apk upgrade --no-cache && apk add --no-cache ca-certificates
COPY --from=builder /build/sftp-gateway /usr/local/bin/sftp-gateway
EXPOSE 23022 8080
ENTRYPOINT ["sftp-gateway"]
