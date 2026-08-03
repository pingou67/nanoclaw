#!/usr/bin/env bash
#
# Authentifie une session ChatGPT DÉDIÉE pour le provider codex et la dépose
# dans le coffre OneCLI. C'est le chemin sanctionné sur cet hôte — voir
# « Pourquoi ce script » plus bas.
#
# Usage :
#   scripts/codex-vault-login.sh            # appairage par code (recommandé)
#   scripts/codex-vault-login.sh --force    # remplace un secret Codex existant
#
# ── Pourquoi ce script ────────────────────────────────────────────────────
#
# Le walk-through upstream (`setup/index.ts --step provider-auth codex`) lance
# `codex login` sur l'HÔTE et s'arrête net si le binaire y est absent :
#
#     The Codex CLI is not installed on this machine.
#
# Or nous n'installons PAS codex sur l'hôte, volontairement : il vit dans
# l'image agent, épinglé dans `container/cli-tools.json`. Un second exemplaire
# sur l'hôte serait une surface d'approvisionnement de plus, non couverte par
# `scripts/supply-watch.ts`, et surtout libre de dériver de la version que les
# containers exécutent réellement — c'est-à-dire de rendre l'auth valide ici et
# cassée là-bas. Ce script fait donc le login DANS l'image, avec la version
# exacte qui servira ensuite.
#
# ── L'invariant à ne pas casser ───────────────────────────────────────────
#
# La session vaultée doit être DÉDIÉE à la passerelle : jamais une copie d'un
# `~/.codex/auth.json` personnel. OpenAI fait tourner les refresh tokens, et
# deux consommateurs partageant une session s'invalident mutuellement — le
# rejeu du jeton périmé déclenche la détection de réutilisation, qui invalide
# TOUTE la famille de sessions côté serveur. D'où le `CODEX_HOME` jetable,
# détruit sur chaque chemin de sortie (y compris Ctrl-C).
#
# Le secret déposé est identique à celui du wizard — même nom, même type, même
# host-pattern — pour que la passerelle le résolve de la même façon :
#
#     onecli secrets create --name Codex --type openai \
#         --file <auth.json> --host-pattern chatgpt.com
#
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
IMAGE="$(container_image_base):${NANOCLAW_IMAGE_TAG:-latest}"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

command -v onecli >/dev/null || { echo "onecli introuvable sur le PATH." >&2; exit 1; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
    echo "Image $IMAGE absente — lancer ./container/build.sh d'abord." >&2; exit 1; }

# Idempotence : ne pas empiler deux sessions pour le même compte sans le dire.
if onecli secrets list 2>/dev/null | grep -q '"name": *"Codex"'; then
    if [ "$FORCE" -eq 0 ]; then
        echo "Un secret « Codex » existe déjà dans le coffre."
        echo "Relancer avec --force pour le remplacer (l'ancienne session sera abandonnée)."
        exit 0
    fi
    echo "→ --force : le secret Codex existant sera remplacé."
fi

# CODEX_HOME jetable, en 0700 : le container tourne sous NOTRE uid (voir plus
# bas), donc inutile de l'ouvrir à tous — c'est un répertoire à credentials.
LOGIN_HOME="$(mktemp -d "${TMPDIR:-/tmp}/codex-vault-login-XXXXXXXX")"
cleanup() { rm -rf "$LOGIN_HOME"; }
trap cleanup EXIT INT TERM
chmod 700 "$LOGIN_HOME"

echo
echo "Appairage Codex — une URL et un code vont s'afficher."
echo "Ouvre l'URL, saisis le code, et connecte-toi avec ton compte ChatGPT Plus."
echo

# Deux réglages non évidents, chacun payé d'un échec réel (2026-08-03) :
#
#   auth_credentials_store_mode=file — depuis 0.14x, codex range ses
#   credentials dans le TROUSSEAU du système (keyring/secret-service). Un
#   container n'en a aucun : l'échange OAuth réussit, codex affiche
#   « Successfully logged in »… et le jeton n'est écrit nulle part. Le mode
#   `file` rétablit l'écriture de $CODEX_HOME/auth.json, seul format que la
#   passerelle sait avaler (`onecli secrets create --file`).
#
#   --user $(id -u):$(id -g) — sans ça, auth.json sort en 0600 appartenant à
#   l'uid 1000 (node) du container, illisible depuis l'hôte si notre uid
#   diffère : le login réussit et le dépôt échoue sur un « Permission denied ».
docker run --rm -it \
    --user "$(id -u):$(id -g)" \
    -e CODEX_HOME=/codexhome \
    -v "$LOGIN_HOME":/codexhome \
    --entrypoint codex \
    "$IMAGE" -c auth_credentials_store_mode=file login --device-auth

AUTH_JSON="$LOGIN_HOME/auth.json"
[ -f "$AUTH_JSON" ] || {
    echo "Le login s'est terminé mais aucun auth.json n'a été écrit — rien à déposer." >&2
    exit 1; }

if [ "$FORCE" -eq 1 ]; then
    OLD_ID="$(onecli secrets list 2>/dev/null \
        | python3 -c "import json,sys;print(next((s['id'] for s in json.load(sys.stdin) if s.get('name')=='Codex'),''))" || true)"
    [ -n "$OLD_ID" ] && onecli secrets delete --id "$OLD_ID" >/dev/null && echo "→ ancien secret supprimé."
fi

onecli secrets create --name Codex --type openai \
    --file "$AUTH_JSON" --host-pattern chatgpt.com >/dev/null

echo
echo "✓ Session ChatGPT déposée dans le coffre OneCLI (nom « Codex », hôte chatgpt.com)."
echo "  Le container ne verra jamais ce jeton : la passerelle le substitue à la volée."
echo
echo "Reste à l'assigner au groupe qui en a l'usage (mode selective) :"
echo "  onecli agents set-secrets --id <uuid-agent> --secrets Codex"
