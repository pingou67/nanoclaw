#!/usr/bin/env bash
# Application MANUELLE d'une mise à jour rtk — le pendant « action délibérée »
# de la veille supply-watch (qui, elle, ne fait que notifier).
#
# Le binaire container-grade (build musl statique, release officielle GitHub)
# vit à ~/.local/bin/rtk et est monté RO à /usr/local/bin/rtk dans TOUS les
# containers agents. Ce script :
#   1. choisit la plus haute release stable publiée depuis ≥ 3 jours
#      (même règle que le reste de la chaîne — un jeune release est REFUSÉE,
#      --force pour outrepasser en connaissance de cause)
#   2. télécharge le build musl, vérifie le sha256 contre checksums.txt
#   3. sanity-check le binaire, puis remplace ATOMIQUEMENT (mv) — les
#      containers en cours gardent l'ancien inode, les prochains spawns
#      prennent le nouveau (`ncl groups restart` pour forcer)
#
# Usage : scripts/apply-rtk-update.sh [version] [--force]
set -uo pipefail
export PATH="/usr/bin:/bin:$HOME/.local/bin:$PATH"

BIN="$HOME/.local/bin/rtk"
ASSET="rtk-x86_64-unknown-linux-musl.tar.gz"
COOLDOWN_DAYS="${SUPPLY_WATCH_COOLDOWN_DAYS:-3}"

FORCE=0
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) TARGET="${arg#v}" ;;
  esac
done

CUR=$("$BIN" --version 2>/dev/null | awk '{print $2}')
[ -z "$CUR" ] && { echo "binaire absent/cassé à $BIN" >&2; exit 1; }

RELEASES=$(curl -fsSL --max-time 30 "https://api.github.com/repos/rtk-ai/rtk/releases?per_page=15") \
  || { echo "API GitHub inaccessible" >&2; exit 1; }

# Sélection : version demandée, sinon la plus haute stable éligible (≥ 3 j).
PICK=$(printf '%s' "$RELEASES" | node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const cooldown = Number(process.argv[1]);
    const target = process.argv[2] || null;
    const now = Date.now();
    const cmp = (a, b) => {
      const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) { const x = (pa[i] || 0) - (pb[i] || 0); if (x) return x; }
      return 0;
    };
    const rel = JSON.parse(d)
      .filter((r) => !r.prerelease && !r.draft)
      .map((r) => ({ v: r.tag_name.replace(/^v/, ""), at: Date.parse(r.published_at) }));
    const found = target
      ? rel.find((r) => r.v === target)
      : rel.filter((r) => (now - r.at) / 86400000 >= cooldown).sort((a, b) => cmp(a.v, b.v)).pop();
    if (!found) { console.log(""); return; }
    const age = ((now - found.at) / 86400000).toFixed(1);
    console.log(found.v + " " + age);
  });
' "$COOLDOWN_DAYS" "$TARGET")

VER=$(printf '%s' "$PICK" | awk '{print $1}')
AGE=$(printf '%s' "$PICK" | awk '{print $2}')
[ -z "$VER" ] && { echo "aucune release ${TARGET:+$TARGET }trouvée${TARGET:+ }" >&2; exit 1; }

if [ "$(printf '%s\n' "$AGE" "$COOLDOWN_DAYS" | sort -g | head -1)" = "$AGE" ] && [ "$AGE" != "$COOLDOWN_DAYS" ]; then
  if [ "$FORCE" != "1" ]; then
    echo "v$VER publiée il y a $AGE j (< $COOLDOWN_DAYS j) — REFUSÉE par le délai supply-chain. --force pour outrepasser." >&2
    exit 1
  fi
  echo "⚠️  v$VER a $AGE j (< $COOLDOWN_DAYS j) — installation forcée." >&2
fi

if [ "$CUR" = "$VER" ]; then
  echo "rtk $CUR déjà installé — rien à faire."
  exit 0
fi

TMP=$(mktemp -d) || exit 1
trap 'rm -rf "$TMP"' EXIT
BASE="https://github.com/rtk-ai/rtk/releases/download/v${VER}"

curl -fsSL --max-time 120 -o "$TMP/$ASSET" "$BASE/$ASSET" || { echo "téléchargement $ASSET échoué" >&2; exit 1; }
curl -fsSL --max-time 30 -o "$TMP/checksums.txt" "$BASE/checksums.txt" || { echo "téléchargement checksums échoué" >&2; exit 1; }

EXPECTED=$(awk -v a="$ASSET" '$2 == a {print $1}' "$TMP/checksums.txt")
ACTUAL=$(sha256sum "$TMP/$ASSET" | awk '{print $1}')
if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "CHECKSUM MISMATCH v$VER (attendu=$EXPECTED obtenu=$ACTUAL) — ABANDON, binaire $CUR conservé." >&2
  exit 1
fi

tar xzf "$TMP/$ASSET" -C "$TMP" || { echo "extraction échouée" >&2; exit 1; }
[ -x "$TMP/rtk" ] || chmod +x "$TMP/rtk" 2>/dev/null
NEWVER=$("$TMP/rtk" --version 2>/dev/null | awk '{print $2}')
[ "$NEWVER" = "$VER" ] || { echo "sanity check échoué (binaire dit '$NEWVER', attendu $VER)" >&2; exit 1; }

install -m 755 "$TMP/rtk" "$BIN.new" && mv -f "$BIN.new" "$BIN" || { echo "installation atomique échouée" >&2; exit 1; }

echo "✅ rtk $CUR → $VER installé à $BIN (checksum vérifié)."
echo "Les containers en cours gardent l'ancienne version ; prochains spawns = $VER."
echo "Forcer maintenant : ncl groups restart --id <gid>"
echo "Changelog : https://github.com/rtk-ai/rtk/releases/tag/v$VER"
