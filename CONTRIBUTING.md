# Cómo contribuir a IArk - DIAgrams

Gracias por querer mejorar el proyecto. Esta guía resume cómo preparar el entorno, qué comprobar antes de abrir una pull request y las convenciones que ya sigue el código. Para entender el producto, empieza por el [README](README.md) y la [hoja de ruta](docs/roadmap.md).

El proyecto está en español: documentación, comentarios del código, mensajes de commit y cuerpos de PR.

## Requisitos

- **Node 22** (el repositorio trae un `.nvmrc`; `nvm use` lo selecciona). `package.json` exige `>=22.12.0` en `engines` porque lo piden de verdad `commander` 15 (el CLI), Vitest 5 y Mermaid 12.
- **npm**, que viene con Node. Instala las dependencias con `npm ci` (respeta `package-lock.json`; no uses `npm install` salvo que cambies dependencias a propósito).
- Para las pruebas de extremo a extremo, un Chromium: `playwright.config.ts` usa `CHROMIUM_PATH` o, si no existe, `/opt/pw-browsers/chromium`, y no descarga ninguno.
- Docker solo si tocas el `Dockerfile`, `deploy/` o quieres ejecutar `npm run docker:smoke` (no forma parte de `npm test`).

```bash
nvm use          # Node 22
npm ci
npm run dev      # editor web en modo desarrollo
```

## Estructura del monorepo

Monorepo con workspaces de npm (`packages/*`). Los paquetes internos se consumen desde su código fuente; `npm run build` los empaqueta dentro de `dist/`.

| Carpeta | Qué es |
|---|---|
| `packages/kernel/` | `@iark/kernel`: lo común a todas las especialidades. Contrato `DomainModule`, registro de módulos, URN, manifiesto de federación, IA estructurada, sintaxis Mermaid, layout y SVG de grafos, diff, proyectos. No toca el DOM ni el sistema de archivos. |
| `packages/domain-c4/`, `domain-integration/`, `domain-data/`, `domain-enterprise/`, `domain-platform/`, `domain-security/` | Un módulo de dominio por especialidad: esquema, validación, vistas, importadores y exportadores, prompts de IA y editor. Sin DOM. |
| `src/cli/` | El CLI `iark` (commander), `iark serve` y su API, almacenes de proyectos y cuentas. |
| `src/app/` | El editor C4 (React, Vite, React Flow, Semi UI, Tailwind). |
| `src/modules-app/`, `src/trace-app/`, `src/shell/`, `src/projects/` | Banco de trabajo de módulos, trazabilidad, shell de la suite y proyectos guardados en el navegador. |
| `src/embed/` | Protocolo `postMessage`, SDK de anfitrión y Web Component `<iark-module>`. |
| `tests/` | Pruebas de integración (`tests/*.test.ts`), los datos de prueba (`tests/fixtures/`) y los e2e de Playwright (`tests/e2e/`). Las pruebas unitarias viven junto al código (`*.test.ts(x)`). |
| `schema/`, `examples/`, `public/.well-known/` | JSON Schema, documentos de ejemplo y manifiesto de federación. Son salidas generadas o ejemplos que las pruebas comprueban. |
| `docs/` | Hoja de ruta y guía de despliegue. |

Hay un mapa más detallado en el README, apartado «Estructura del proyecto».

## Antes de abrir una PR: `npm run verify`

```bash
npm run verify    # typecheck + test + build + e2e
```

`verify` encadena, en este orden:

1. `npm run typecheck`: `tsc` sobre la app, el lado Node y las pruebas (`tsconfig.app.json`, `tsconfig.node.json`, `tsconfig.test.json`).
2. `npm test`: Vitest (`vitest run`) sobre `src/**`, `packages/*/src/**` y `tests/**`.
3. `npm run build`: la biblioteca y el CLI con tsup, y el sitio con Vite.
4. `npm run e2e`: Playwright contra el sitio compilado. Con `E2E_PORT=4176 npm run e2e` cambias el puerto (por defecto 4173) si corres varios checkouts a la vez.

Si solo cambias una parte, corre lo relacionado mientras trabajas (`npx vitest run packages/domain-data`, `npx vitest run tests/trace.test.ts`) y deja `verify` completo para el final. La suite completa es pesada.

**Qué corre el CI.** Hoy el workflow de `master` es [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml): en cada pull request hacia `master` compila el sitio (`npm run build:app`) y, al fusionar, lo publica en `gh-pages`. Los workflows de comprobación de tipos y pruebas están en preparación en otra PR; cuando existan, esta sección dirá cuáles son obligatorios. Mientras tanto, la garantía de que la PR no rompe nada es `npm run verify` en tu equipo.

### Hook local antes de empujar

Para no olvidar las comprobaciones antes de empujar, `package.json` trae dos scripts:

```bash
npm run hooks:install   # instala el hook pre-push de git
npm run verify:fast     # comprobación rápida (la que usa el hook)
```

Si tu rama todavía no los trae (se añaden en otra PR del mismo plan de robustecimiento), actualízala desde `master` cuando esa PR esté fusionada.

## Flujo de pull requests

- **Una PR por tema.** Un cambio de comportamiento, un arreglo, un documento. Si al trabajar encuentras otra cosa, abre otra rama.
- **Ramas** `claude/<tema>` (trabajo hecho con Claude Code) o `feature/<tema>`, creadas desde `master` al día e integradas por pull request.
- **Commits pequeños** con mensaje en español: una línea de resumen que diga qué cambia y, si hace falta, una lista con el porqué y los detalles. Los commits hechos con Claude Code llevan al final los trailers `Co-Authored-By` y `Claude-Session` que indique la sesión.
- **Cuerpo de la PR** con el formato de [`.github/pull_request_template.md`](.github/pull_request_template.md): *Antes* (cómo era y por qué dolía), *Después* (cómo queda), *Cómo* (qué se tocó y por qué así) y *Verificación* (qué comandos se ejecutaron y su resultado real; no se anota lo que no se ejecutó).
- **Pruebas obligatorias para cada cambio.** Un arreglo lleva una prueba que fallaba antes; una función nueva, las que cubren su comportamiento y sus bordes. Una PR de solo documentación o configuración no necesita pruebas nuevas, pero sí que `npm run typecheck` siga pasando.
- **Mantén `master` verde.** No fusiones con pruebas rojas ni borres una prueba para que pase: corrige la causa.
- **No reintroduzcas dependencias sin declarar.** El paquete publicado y la imagen Docker solo instalan `dependencies`, y cada paquete de `packages/*` debe declarar lo que importa su código con la misma versión que la raíz. Lo comprueban [`tests/dependencias-paquetes.test.ts`](tests/dependencias-paquetes.test.ts) y [`tests/runtime-deps.test.ts`](tests/runtime-deps.test.ts); si fallan tras añadir un import, declara la librería donde corresponda en lugar de silenciar la prueba.
- **Dependencias nuevas, justificadas.** Antes de añadir una, revisa que su licencia sea compatible con MIT (MIT, ISC, BSD o Apache-2.0 no dan problemas; si es copyleft, consúltalo antes en un issue) y que de verdad hace falta: varias piezas se escribieron sin dependencias a propósito (el servidor `iark serve` usa solo `node:http`; los analizadores de HCL y de SQL son propios).
- **Si cambia un esquema, añade migración.** Antes de abrir la PR comprueba: ¿un documento guardado con la versión anterior sigue abriéndose? `tests/documentos-antiguos.test.ts` lo vigila con documentos congelados de cada módulo; si falla, la solución es una migración, no editar la foto. Lo mismo para el contrato `DomainModule` (`contractVersion`, que sube solo si un cambio obliga a tocar los módulos existentes) y para el protocolo embebido (`EMBED_PROTOCOL_VERSION`, versión mayor si un cambio rompe a quien no lo conoce). Todo en [docs/versionado-documentos.md](docs/versionado-documentos.md).
- **Salidas generadas al día.** Si cambias módulos, esquemas o el manifiesto, regenera con `npm run schema` y `npm run manifest` y sube el resultado (`schema/`, `public/.well-known/iark.json`); `tests/manifest.test.ts` falla si el manifiesto está desactualizado.

## Convenciones de código

- **TypeScript en modo `strict`** (con `noUnusedLocals`, `noUnusedParameters` y `noFallthroughCasesInSwitch`; ver `tsconfig.base.json`). **Sin `any` nuevos**: usa tipos concretos, `unknown` con comprobación o los esquemas de `zod`. Los que existen son deuda, no un precedente.
- **Español** en comentarios, documentación, mensajes al usuario y mensajes de error. Los identificadores del código van en inglés, como hoy. Los comentarios explican el porqué (una restricción, una decisión, un caso que ya falló), no lo que el código ya dice.
- **Núcleo sin DOM.** Ni el kernel ni los módulos de dominio (`packages/*`) usan el DOM, y el kernel tampoco toca el sistema de archivos; lo que dependa del navegador o del disco vive en `src/app`, `src/modules-app` o `src/cli`.
- **Compatibilidad de los documentos.** Los cambios en el formato de un módulo son aditivos y opcionales siempre que se pueda: los documentos ya guardados (versión 1.0) tienen que seguir cargando. Si un cambio de esquema no es compatible, **sube `documentVersion`, añade la migración** en `DomainModule.migrations` y conserva la foto del documento antiguo en `tests/fixtures/documentos/` (que no se edita ni se regenera). Ver [Versionado de documentos](docs/versionado-documentos.md).
- **Formato**: no hay formateador automático. El `.editorconfig` fija UTF-8, LF, 2 espacios y línea final; sigue el estilo del archivo que editas.
- **Pruebas**: Vitest (`*.test.ts` junto al código o en `tests/`), Testing Library con `// @vitest-environment jsdom` donde haga falta DOM, y Playwright en `tests/e2e/`. En e2e no uses esperas fijas ni `networkidle`: espera una señal observable (ver `tests/e2e/canvas-helpers.ts`).
- **Iconos y marcas.** Los iconos de nubes (AWS, Azure) son glifos propios, no los logotipos oficiales, que son marcas propietarias. No contribuyas logotipos o iconos de terceros salvo que su licencia permita redistribuirlos bajo MIT, y dilo en la PR.

## Cómo añadir un módulo de dominio

Cada especialidad es un paquete `@iark/domain-*` que implementa `DomainModule`. El contrato completo, con comentarios, está en [`packages/kernel/src/module/types.ts`](packages/kernel/src/module/types.ts) (y el del editor interactivo en `packages/kernel/src/module/editor.ts`). En resumen:

1. Crea `packages/domain-<nombre>/` con su `package.json` (copia el de un módulo existente, p. ej. `packages/domain-security/`: `@iark/kernel` y `zod` como dependencias, y cualquier otra librería que importe, con la misma versión que la raíz). Copia también sus campos de publicación (`license`, `repository`, `files`, `exports` hacia `src/*.ts` y `publishConfig.exports` hacia `dist`, el script `prepack`): `tests/paquetes.test.ts` y `npm run packages:build` los exigen a todo paquete de `packages/*`.
2. Define el esquema (zod), las reglas de validación, las vistas, los importadores y exportadores, la especificación de IA y, si tiene lienzo, la de editor; exporta el módulo desde `src/index.ts`.
3. Regístralo donde ya están los demás. Hoy: el alias en `tsconfig.base.json`, `src/cli/registry.ts` (`createDefaultRegistry`), `src/modules-app/modules.ts` (el banco de trabajo), `scripts/generate-schema.ts` y un ejemplo en `examples/`. Busca con `grep -rn domain-security` dónde aparece un módulo existente y repite el patrón.
4. Regenera `npm run schema` y `npm run manifest`.
5. Escribe las pruebas del módulo junto a su código y comprueba que `tests/dependencias-paquetes.test.ts` y `tests/manifest.test.ts` siguen pasando.

No hay una guía paso a paso más detallada que esta: ante la duda, mira cómo está hecho el módulo existente más parecido y pregunta en el issue o la PR.

**¿Una especialidad que no tiene por qué vivir en este repositorio?** Escríbela como un [módulo de terceros](docs/plugins.md): un paquete aparte que implementa el mismo contrato y se carga con `iark.config.json`, sin tocar nada de lo anterior. [`examples/plugin-riesgos/`](examples/plugin-riesgos/) es un ejemplo completo. Si cambias el contrato (`packages/kernel/src/module/types.ts`) o la comprobación de la forma (`plugin.ts`), revisa que el ejemplo y `tests/plugins-cli.test.ts` sigan pasando.

## Seguridad

Si encuentras una vulnerabilidad, **no abras un issue público**: sigue [`SECURITY.md`](SECURITY.md).

## Licencia

Al contribuir aceptas que tu aportación se publique bajo la licencia [MIT](LICENSE) del proyecto.
