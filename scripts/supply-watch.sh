#!/usr/bin/env bash
# Wrapper systemd de la veille supply-chain (scripts/supply-watch.ts).
# /usr/bin en tête : le node pi-node du PATH par défaut casse les modules
# natifs (cf. CLAUDE.local.md) ; pnpm n'est pas sur le PATH par défaut.
set -uo pipefail
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="/usr/bin:/bin:$PNPM_HOME:$HOME/.local/bin:$PATH"
cd "$(dirname "$(readlink -f "$0")")/.." || exit 0
exec pnpm exec tsx scripts/supply-watch.ts "$@"
