#!/bin/sh
# Hooks do not get the interactive PATH. A version-manager shim on PATH, such as proto's, selects node from the
# session cwd's `.prototools`, which can pin a node without type stripping or fail as untrusted. So a fixed install
# is tried first, and PATH last. Any failure exits non-zero, and `onFailure: "block"` denies the request.
hook="$(dirname "$0")/permission-triage.ts"
for node in "${PERMISSION_TRIAGE_NODE:-}" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -n "$node" ] && [ -x "$node" ]; then exec "$node" "$hook"; fi
done
exec node "$hook"
