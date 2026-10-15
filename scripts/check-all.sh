#!/usr/bin/env bash
# Entry point for `bun run check:all`.
#
# `bun run check:all --bail` appends extra arguments to this script.
# Forward them to the gate runner. A `&&` chain in package.json would
# stick `--bail` on the last command instead, and the pre-commit hook
# depends on that flag reaching scripts/check-all.ts.
#
# Redocly runs after the gates. The gate runner's own exit status wins
# when both fail, after both have printed.
set -uo pipefail

cd "$(dirname "$0")/.."

bun scripts/check-all.ts "$@"
gate_status=$?

bun run check:openapi
spec_status=$?

if [[ "$gate_status" -ne 0 ]]; then
	exit "$gate_status"
fi
exit "$spec_status"
