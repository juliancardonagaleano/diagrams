# IA: generar y refinar diagramas con lenguaje natural

[← Índice de la documentación](indice.md)

**CLI `iark`** para generar diagramas a partir de **instrucciones en lenguaje natural** (Claude, salida estructurada), aplicar autolayout y convertir a `.drawio` sin abrir un navegador. Se puede usar sin clave de API con cualquier otra IA o agente.

`generate`, `prompt` y `--from-repo` funcionan con cualquier módulo de la suite (`--module <id>`, por omisión `c4`). La generación vive solo en el CLI: ni el sitio estático ni `iark serve` llaman a ningún modelo.

| Proveedor | Cómo se elige | Variables |
|---|---|---|
| API de Anthropic (por omisión) | automático o `--provider anthropic` | `ANTHROPIC_API_KEY` (o `ant auth login`) |
| Claude en Foundry | `--provider foundry` | `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_FOUNDRY_BASE_URL` (o `_RESOURCE`), `ANTHROPIC_FOUNDRY_MODEL` |
| Cualquier modelo de Foundry (API compatible con OpenAI) | `--provider openai`, o por la URL | `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` |

Qué proveedores están probados de verdad está en [Prueba real de `generate`](#prueba-real-de-generate).

## Generar diagramas con IA (Claude)

```bash
export ANTHROPIC_API_KEY=…   # o `ant auth login`
npx iark generate "Sistema de banca en línea con app web (React), API (Node.js), base de datos PostgreSQL y una pasarela de pagos externa. Los clientes consultan saldos y hacen pagos." \
  --out banca.drawio --json banca.json
```

Flujo: la instrucción se envía a Claude (`claude-opus-5` por defecto) con **salida estructurada** contra el esquema del modelo *sin coordenadas*; el resultado se valida (referencias, jerarquía C4) con un reintento automático si hay errores; después se aplica **autolayout** a todas las vistas y se escriben el JSON y el `.drawio`. Con `--from base.json` la instrucción se trata como un refinamiento del documento existente ("agrega una cola Kafka entre la API y las notificaciones"), conservando los ids y posiciones ya fijados.

### Con Microsoft (Azure) Foundry: Claude u otros modelos

`generate` funciona con dos tipos de despliegue de Foundry; la plataforma se detecta por la URL, o se fuerza con `--provider`. Guarda las variables como secretos del entorno, nunca en el repositorio.

**Cualquier modelo de Foundry** (DeepSeek, Llama, Mistral, GPT…, `--provider openai`): usa el endpoint compatible con OpenAI del recurso.

```bash
export AI_BASE_URL=https://<recurso>.openai.azure.com/openai/v1    # también vale ANTHROPIC_FOUNDRY_BASE_URL
export AI_API_KEY=…                                                # o ANTHROPIC_FOUNDRY_API_KEY
export AI_MODEL=<nombre-de-tu-despliegue>                          # o ANTHROPIC_FOUNDRY_MODEL
npx iark generate "Una tienda en línea con web, API y base de datos" --json tienda.json --out tienda.drawio
```

No todos los modelos garantizan el esquema, así que el JSON Schema va también en el prompt, se pide `json_schema` (o `json_object`, o nada si el modelo no lo admite) y la respuesta se valida con zod; si es ilegible o incumple el esquema se reintenta con el error. Se descartan los bloques `<think>…</think>` de los modelos de razonamiento. La calidad del diagrama depende del modelo.

**Claude en Foundry** (`--provider foundry`): protocolo de mensajes de Anthropic, con salida estructurada garantizada.

```bash
export ANTHROPIC_FOUNDRY_API_KEY=…
export ANTHROPIC_FOUNDRY_BASE_URL=https://<recurso>.services.ai.azure.com/anthropic/   # o ANTHROPIC_FOUNDRY_RESOURCE=<recurso>
export ANTHROPIC_FOUNDRY_MODEL=<nombre-de-tu-despliegue-de-claude>
```

En Foundry no se envían los *fallbacks* del servidor (solo existen en la API de Anthropic).

## Sin clave de API: cualquier IA o agente

`iark prompt` imprime un prompt autocontenido (reglas C4 + JSON Schema + instrucción). Pégalo en el asistente que prefieras (o deja que un agente como Claude Code lo ejecute) y tuberiza la respuesta:

```bash
npx iark prompt "Plataforma de reservas de hotel con app móvil, backend y pagos" > prompt.txt
# … la IA responde con un JSON (se acepta envuelto en ```json) …
cat respuesta.json | npx iark layout --stdin --out reservas.json
npx iark convert reservas.json --out reservas.drawio
```

La pestaña **IA** del editor web hace lo mismo sin llamar a ningún servicio: "Copiar prompt para IA" y "Pegar JSON generado" (valida, aplica autolayout y carga o fusiona el modelo).

## Dibujar desde un repositorio (`--from-repo`)

`iark generate … --from-repo <carpeta|url>` y `iark prompt … --from-repo <carpeta|url>` dibujan la arquitectura leyendo un repositorio: una **carpeta local** o la **URL de git**. Se combinan con `--module` (cualquier módulo) y con `--from` (refinar un documento existente).

```bash
iark generate "Dibuja la arquitectura" --from-repo ./mi-proyecto --json arq.json            # carpeta local
iark generate "Dibuja la arquitectura" --from-repo https://github.com/org/repo.git --repo-ref v2.1 --module platform
iark generate "Solo el servicio de pedidos" --from-repo ./mono --repo-include 'services/pedidos/' --repo-exclude '**/*.test.ts'
iark generate "…" --from-repo ./mi-proyecto --dry-run        # imprime lo que se enviaría (y qué se omite y por qué), sin modelo ni clave
iark prompt   "…" --from-repo ./mi-proyecto                  # el mismo resumen dentro de un prompt para pegar donde quieras
```

- **Qué lee**: solo una lista blanca de lo que revela la arquitectura (README y docs, diagramas existentes, manifiestos, Dockerfile y compose, contratos OpenAPI/AsyncAPI/proto/GraphQL, Kubernetes/Helm/Terraform/CloudFormation, DDL y migraciones, puntos de entrada, CI y los *nombres* de un `.env.example`); lo demás llega como árbol de carpetas y rutas, nunca su contenido. Presupuesto estricto con `--repo-budget <kb>` (60 por defecto, de 1 a 1024).
- **Privacidad**: nunca se leen `.env*`, claves y certificados privados, `.npmrc`/`.netrc`, `*.tfstate`/`*.tfvars` ni los Secret de Kubernetes; todo el texto incluido pasa por una redacción de patrones de secretos antes de recortar y otra vez sobre el resumen; no se ejecuta nada del repositorio ni se siguen enlaces simbólicos; el contenido va al modelo como datos, no como instrucciones. `--dry-run` y `prompt` enseñan exactamente qué se enviaría antes de enviar nada.
- **URL de git** (`https://`, `ssh://` o `git@host:grupo/repo.git`; `--repo-ref <rama|etiqueta>`): se ejecuta solo `git clone` (sin shell, superficial, sin submódulos ni hooks, con 120 s de margen) a un directorio temporal que se borra siempre, también si falla o lo interrumpes; después no se ejecuta nada del clon. Se rechazan `http://`, `git://`, `file://`, las URL con usuario o token dentro y los valores que empiezan por «-»; un repositorio privado usa las credenciales que ya tengas en git y en ssh (IArk no las lee ni las guarda y git no pregunta contraseñas). En un clon no se aplica el `.gitignore` (solo trae lo versionado).
- **Filtros** (`--repo-include <glob>` y `--repo-exclude <glob>`, repetibles, en formato `.gitignore` y relativos a la raíz): `--repo-exclude` quita lo que cuadre de todo el resumen (árbol, componentes y contenido) y `--repo-include` limita el *contenido* a los archivos clave que cuadren (el árbol sigue entero); si ambos cuadran gana `--repo-exclude`. Solo reducen: nunca hacen legible lo que la lista de secretos prohíbe.
- Es solo del CLI: el servicio `iark serve` no lo expone, porque leería el disco del servidor.

## Prueba real de `generate`

La generación con IA está cubierta por pruebas con clientes simulados (`packages/domain-c4/src/ai/generate.test.ts` y `packages/kernel/src/ai/*.test.ts`) y, además, se ejecutó
contra un servicio real. Estado por proveedor:

| Proveedor | Estado |
|---|---|
| **Foundry, cualquier modelo** (`--provider openai`) | **Probado** con DeepSeek‑V4‑Pro (28‑09‑2026): un intento, JSON válido, 6 elementos, 4 relaciones y 2 vistas; `validate --strict` sin errores ni avisos, todas las vistas con coordenadas y el `.drawio` con una página por vista. Variables usadas: `AI_API_KEY`, `AI_BASE_URL` y `AI_MODEL` (también valen las `ANTHROPIC_FOUNDRY_*`). |
| **Claude en Foundry** (`--provider foundry`) | **Sin probar**: requiere un despliegue de Claude en el recurso, `ANTHROPIC_FOUNDRY_BASE_URL` (`https://<recurso>.services.ai.azure.com/anthropic/`) o `ANTHROPIC_FOUNDRY_RESOURCE`, `ANTHROPIC_FOUNDRY_API_KEY` y `ANTHROPIC_FOUNDRY_MODEL` con el nombre de ese despliegue. |
| **API de Anthropic** | **Sin probar**: requiere `ANTHROPIC_API_KEY` con créditos (la suscripción de Claude.ai no incluye acceso a la API). |

La última prueba real registrada es del 28‑09‑2026 y fue sobre el módulo C4: desde entonces el repositorio no registra otra (ni con los proveedores sin probar, ni con otro `--module`, ni con `--from-repo`).

La prueba real destapó un defecto que las pruebas con clientes simulados no veían: la vista de contexto salía **sin su
propio sistema** (y por tanto sin aristas) porque `generatedToDocument` descartaba el `scopeId` en todas las vistas
y ningún validador lo exigía. Ahora solo se descarta en contenedores/componentes, y `validateDocument` rechaza una vista
`systemContext` que no incluya su alcance (lo que dispara el reintento con el error), con el mismo aviso en el panel de
problemas y en `validate --strict`.

Para repetir la prueba con otro proveedor o modelo:

```bash
npm run cli -- generate "Sistema de banca en línea con app web (React), API (Node.js), PostgreSQL y una pasarela de pagos externa" \
  --json examples/banca-ia.generated.json --out examples/banca-ia.generated.drawio
npm run cli -- validate examples/banca-ia.generated.json --strict
```

y comprobar que `validate` no reporta errores, que todas las vistas tienen coordenadas y que el `.drawio` abre en
draw.io con una página por vista (la vista de contexto debe llevar el sistema y sus relaciones). Los archivos
`*.generated.*` están ignorados por git. Si el endpoint rechaza algo (formato de respuesta, parámetros de tokens,
autenticación), el ajuste va en `packages/kernel/src/ai/openaiCompat.ts`. Las credenciales van siempre en los ajustes del entorno
(*Environment variables* / *API credentials*), nunca en el chat, en el código ni en git (`.gitignore` excluye `.env*`).
