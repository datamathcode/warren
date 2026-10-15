#!/usr/bin/env bash
# Forwards `bun run check:all --bail` to the gate runner.
#
# package.json runs `bun run check:openapi` first, then this script.
# Bun appends extra arguments to the last command of that chain, so
# `--bail` lands here and is forwarded. The pre-commit hook depends on
# that flag reaching scripts/check-all.ts.
set -uo pipefail

cd "$(dirname "$0")/.."
exec bun scripts/check-all.ts "$@"
