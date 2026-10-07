#!/usr/bin/env bash
# Comprueba que el sitio publicado en GitHub Pages sirve la compilación esperada y que sus páginas responden 200.
# Pages tarda ~1 min en servir un push nuevo, así que primero espera a que `index.html` apunte al mismo
# `assets/main-<hash>.js` que el `dist/pages` recién compilado (así no se da por bueno el despliegue anterior).
#
# Uso: bash scripts/verify-pages.sh <url-base> [dist/pages]
# Variables: VERIFY_TIMEOUT (segundos, 600 por defecto), VERIFY_INTERVAL (segundos entre intentos, 10 por defecto).
set -euo pipefail

base="${1:?Uso: verify-pages.sh <url-base> [dist/pages]}"
base="${base%/}/"
dist="${2:-dist/pages}"
timeout="${VERIFY_TIMEOUT:-600}"
interval="${VERIFY_INTERVAL:-10}"

main=$(grep -o 'assets/main-[A-Za-z0-9_-]*\.js' "$dist/index.html" | head -1 || true)
if [ -z "$main" ]; then
  echo "No encuentro assets/main-*.js en $dist/index.html: ¿está compilado?" >&2
  exit 1
fi

status() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$1" || true; }

echo "Esperando a que $base sirva $main (máx. ${timeout}s)…"
deadline=$((SECONDS + timeout))
while true; do
  # En una variable, no en un pipe: `grep -q` cierra la tubería y con `pipefail` haría fallar a `curl` aunque haya coincidencia.
  html=$(curl -fsS --max-time 20 "${base}index.html?v=$RANDOM" 2>/dev/null || true)
  case "$html" in *"$main"*) break ;; esac
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "Tiempo agotado: $base todavía no sirve $main." >&2
    exit 1
  fi
  sleep "$interval"
done
echo "Sirviendo la compilación nueva tras ~${SECONDS}s."

fail=0
for path in "" modulos.html suite.html trazabilidad.html .well-known/iark.json "$main"; do
  code=$(status "${base}${path}")
  printf '%s  %s%s\n' "$code" "$base" "$path"
  [ "$code" = "200" ] || fail=1
done
if [ "$fail" -ne 0 ]; then
  echo "Alguna ruta no respondió 200." >&2
  exit 1
fi
echo "Sitio verificado."
