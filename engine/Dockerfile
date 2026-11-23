# Builds a static frpc for DSM from this repository's source.
#
# CGO is off, so the resulting binary has no libc dependency at all: it runs on
# DSM regardless of the glibc version the NAS ships.
FROM golang:1.26-alpine AS build

WORKDIR /src

# Dependencies first so the module cache layer survives source edits.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# web/frpc/embed.go embeds web/frpc/dist, which is a npm build artifact and not
# in the repo. We do not ship frpc's dashboard, so a placeholder is enough for
# the embed directive to resolve.
RUN mkdir -p web/frpc/dist \
    && printf '<!doctype html><meta charset="utf-8"><title>frpc</title>\n' > web/frpc/dist/index.html

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags "-s -w" -o /out/frpc ./cmd/frpc \
    && /out/frpc --version | tee /out/VERSION

FROM alpine:3.20 AS collect
COPY --from=build /out /out
CMD ["/out/frpc", "--version"]
