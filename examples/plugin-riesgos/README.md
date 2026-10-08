# Módulo de terceros de ejemplo: registro de riesgos

Un paquete mínimo que añade a IArk - DIAgrams el módulo `risk` **sin tocar el repositorio**: esquema, validación, exportador a Markdown, importador de CSV, el comando `iark risk top` y entidades para la trazabilidad. Solo importa `@iark/kernel` y `zod` (sus `peerDependencies`).

```bash
# desde esta carpeta (el iark.config.json de aquí carga ./index.mjs)
iark modules
iark validate --module risk riesgos.json
iark convert --module risk riesgos.json --to md
iark import --module risk riesgos.csv
iark risk top riesgos.json -n 3
```

Hace falta que `@iark/kernel` y `zod` se puedan resolver desde esta carpeta (`npm install @iark/kernel zod`). Guía completa, paso a paso: [docs/plugins.md](../../docs/plugins.md).
