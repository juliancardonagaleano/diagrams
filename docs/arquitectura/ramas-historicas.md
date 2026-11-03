# Ramas remotas históricas (`cursor/*`)

[← Índice](../indice.md) · [Plan de implementación](plan-implementacion.md)

Inventario del **3 de noviembre de 2026 (UTC)** sobre `origin/master`. Sirve para decidir qué ramas `cursor/*` ya no aportan trabajo pendiente.

## Limpieza remota (3 nov 2026)

Se eliminaron en `origin` las ramas de la tabla «Seguras para borrar» que **aún existían**, tras comprobar con `git merge-base --is-ancestor` que seguían fusionadas en `origin/master`:

| Rama remota | Resultado |
|---|---|
| `cursor/fix-e2e-spa-routes-58e1` | Eliminada |
| `cursor/impl-app-shell-58e1` | Eliminada |
| `cursor/impl-app-shell-deep-58e1` | Eliminada |
| `cursor/impl-identity-58e1` | Eliminada |
| `cursor/impl-mfe-remotes-58e1` | Eliminada |
| `cursor/impl-shell-spa-58e1` | Eliminada |
| `cursor/impl-sse-multiprocess-58e1` | Eliminada |
| `cursor/rearch-specs-003-004-005-58e1` | Eliminada |
| `cursor/spec-002-hecha-58e1` | Eliminada |
| `cursor/spec-008-hecha-58e1` | Eliminada |
| `cursor/specs-planeacion-58e1` | Eliminada |
| `cursor/consolidate-rearch-stack-58e1` | Ya no existía en remoto |
| `cursor/post-rearch-continue-58e1` | Ya no existía en remoto |
| `cursor/ece-mcp-iark-58e1` | Ya no existía en remoto |
| `cursor/impl-borde-009-58e1` | Ya no existía en remoto |
| `cursor/impl-cli-hexagonal-58e1` | Ya no existía en remoto |
| `cursor/impl-gateway-58e1` | Ya no existía en remoto |
| `cursor/impl-identity-core-move-58e1` | Ya no existía en remoto |
| `cursor/spec-005-hecha-58e1` | Ya no existía en remoto |

Las ramas de «Revisar antes de borrar» **no** se tocaron.

## Criterio

- **Segura para borrar** — el puntero de la rama remota es **ancestro** de `origin/master` (todo lo que tenía ya está en master). No hay commits únicos en la rama.
- **Revisar antes de borrar** — la rama **no** está contenida en master: tiene commits que master aún no tiene. Puede ser basura de agente, un PR abierto o contexto que alguien quiera rescatar.
- **No listada aquí** — ramas `claude/*`, `gh-pages` y otras fuera del prefijo `cursor/` (otro criterio de limpieza).

Comprobar en cualquier momento:

```bash
git fetch origin
git merge-base --is-ancestor origin/cursor/NOMBRE-58e1 origin/master && echo merged || echo unique-commits
git log --oneline origin/master..origin/cursor/NOMBRE-58e1   # vacío ⇒ segura
```

## Seguras para borrar (inventario original; limpiadas el 3 nov 2026)

Estas ramas estaban **100 % fusionadas** en master al momento del inventario. Tras la limpieza del 3 nov 2026 **ya no deberían existir** en `origin`; si reaparecen, repetir la comprobación antes de borrar.

| Rama remota | Notas |
|---|---|
| `cursor/consolidate-rearch-stack-58e1` | Apilado de specs/rearch ya integrado |
| `cursor/post-rearch-continue-58e1` | Continuación post-rearch |
| `cursor/ece-mcp-iark-58e1` | Integración MCP ECE (config en master) |
| `cursor/fix-e2e-spa-routes-58e1` | Rutas SPA e2e |
| `cursor/impl-app-shell-58e1` | Shell de aplicación |
| `cursor/impl-app-shell-deep-58e1` | Profundización shell |
| `cursor/impl-borde-009-58e1` | Spec 009 borde |
| `cursor/impl-cli-hexagonal-58e1` | CLI hexagonal |
| `cursor/impl-gateway-58e1` | Gateway |
| `cursor/impl-identity-58e1` | Identidad |
| `cursor/impl-identity-core-move-58e1` | Movimiento identity core |
| `cursor/impl-mfe-remotes-58e1` | Remotes MFE |
| `cursor/impl-shell-spa-58e1` | Shell SPA |
| `cursor/impl-sse-multiprocess-58e1` | SSE multiproceso |
| `cursor/rearch-specs-003-004-005-58e1` | Specs 003–005 |
| `cursor/spec-002-hecha-58e1` | Spec 002 cerrada |
| `cursor/spec-005-hecha-58e1` | Spec 005 cerrada |
| `cursor/spec-008-hecha-58e1` | Spec 008 cerrada |
| `cursor/specs-planeacion-58e1` | Planeación de specs |

```bash
git push origin --delete cursor/NOMBRE-58e1   # solo tras confirmar merged
```

## Revisar antes de borrar (commits no en master)

| Rama remota | Commits únicos (aprox.) | Motivo habitual |
|---|---|---|
| `cursor/conexion-ece-58e1` | 4 | Spec 000 / as-is / protocolo; parte ya en master vía otras ramas |
| `cursor/arquitectura-protocolo-58e1` | 2 | Protocolo SDD y modelo as-is |
| `cursor/c4-as-is-model-58e1` | 2 | Modelo C4 as-is |
| `cursor/c4-as-is-cdc4` | 2 | Variante CDC4 del as-is |
| `cursor/fix-e2e-master-f583` | 1 | Parche e2e puntual |

Antes de borrar una fila de esta tabla, mirar el diff respecto a master:

```bash
git log --oneline origin/master..origin/cursor/conexion-ece-58e1
```

Si el contenido ya está duplicado en master o en otra rama activa, se puede borrar; si no, archivar o fusionar primero.

## Ramas activas de agente

Las ramas que sigan recibiendo commits (por ejemplo una higiene o un PR abierto) **no** deben borrarse hasta cerrar el PR o fusionar. Este inventario no sustituye la lista de PRs abiertos en GitHub.
