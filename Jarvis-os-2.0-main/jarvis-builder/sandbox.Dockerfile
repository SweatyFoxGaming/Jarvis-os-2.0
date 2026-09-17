FROM node:20-alpine

RUN apk add --no-cache git bash

WORKDIR /workspace

# Runs LLM-generated shell commands with no human review until the
# approve-code checkpoint — the isolation boundary (not command filtering,
# per this feature's design spec) is the safety mechanism, so that boundary
# should hold even against a command that's merely careless, not just
# malicious. `node` (uid/gid 1000) is the image's own built-in non-root
# user; workspace.ts chowns the bind-mounted workspace to match before
# starting this container. Nothing in a normal git/npm/test workflow needs
# root — this only removes a capability actual tasks never used anyway.
USER node
