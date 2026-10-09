# Módulo de terceros de ejemplo: registro de riesgos

Un paquete mínimo que añade a DIAgrams el módulo `risk` **sin tocar el repositorio**: esquema, validación, exportador a Markdown, importador de CSV, el comando `iark risk top` y entidades para la trazabilidad. Solo importa `@iark/kernel` y `zod` (sus `peerDependencies`).

```bash
# desde esta carpeta (el iark.config.json de aquí carga ./index.mjs)
iark modules
iark validate --module risk riesgos.json
iark convert --module risk riesgos.json --to md
iark import --module risk riesgos.csv
iark risk top riesgos.json -n 3
iark trace c4=../banca.json risk=riesgos.json
```

Dentro del repositorio, `npm install` en la raíz basta y el CLI de desarrollo hace de `iark`: `npx tsx ../../src/cli/index.ts modules`. Con el CLI instalado, `@iark/kernel` y `zod` tienen que poder resolverse desde esta carpeta (`npm install @iark/kernel zod`; mientras `@iark/kernel` no esté publicado en npm, desde el tarball de `npm run packages:build`, ver la guía). Guía completa, paso a paso: [docs/plugins.md](../../docs/plugins.md).
