#!/usr/bin/env bash
# Publica la app compilada (dist/pages) en la rama `gh-pages`, para GitHub Pages con
# origen "Deploy from a branch" → gh-pages / raíz. Lo usan tanto el comando manual (`npm run deploy:pages`)
# como el workflow `.github/workflows/deploy-pages.yml`, que llama a este mismo script tras compilar.
#
# Variables opcionales:
#   BASE_PATH   ruta base del sitio (por defecto `/<repositorio>/` según `origin`).
#   SKIP_BUILD  =1 reutiliza el `dist/pages` ya compilado en vez de compilar (lo usa el workflow, que compila en otro job).
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"
# Nombre del repositorio según el remoto `origin` (la carpeta local puede llamarse distinto o el remoto haberse renombrado).
repo=$(basename "$(git remote get-url origin 2>/dev/null || echo "$root")" .git)

if [ "${SKIP_BUILD:-}" = "1" ]; then
  [ -f dist/pages/index.html ] || { echo "SKIP_BUILD=1 pero no hay dist/pages/index.html: compila antes." >&2; exit 1; }
else
  # Pages sirve bajo /<repositorio>/; se puede sobrescribir con BASE_PATH.
  BASE_PATH="${BASE_PATH:-/$repo/}" OUT_DIR=dist/pages npm run build:app
fi

# Sin identidad de git configurada (p. ej. el ejecutor de Actions) el commit usaría un autor ficticio, solo para este proceso.
if ! git config user.email >/dev/null; then
  export GIT_AUTHOR_NAME="github-actions[bot]" GIT_COMMITTER_NAME="github-actions[bot]"
  export GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com" GIT_COMMITTER_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
fi

wt=$(mktemp -d)
tmp_branch="gh-pages-deploy-$$"
git worktree add --detach "$wt" >/dev/null
# Rama huérfana temporal: así no choca con una rama local `gh-pages` de un despliegue anterior.
trap 'git worktree remove --force "$wt" 2>/dev/null || true; git branch -D "$tmp_branch" >/dev/null 2>&1 || true' EXIT
(
  cd "$wt"
  git checkout -q --orphan "$tmp_branch"
  git rm -rfq .
  cp -r "$root/dist/pages/." .
  touch .nojekyll
  git add -A
  git commit -qm "Sitio compilado desde $(git -C "$root" rev-parse --short HEAD)"
  git push -f origin "$tmp_branch:gh-pages"
)
echo "Publicado en gh-pages. Origen de Pages: Settings → Pages → Deploy from a branch → gh-pages / (root)."
