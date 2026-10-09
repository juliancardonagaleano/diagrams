# IA: generar y refinar diagramas con lenguaje natural

[← Índice de la documentación](indice.md)

**CLI `iark`** para generar diagramas a partir de **instrucciones en lenguaje natural** (Claude, salida estructurada), aplicar autolayout y convertir a `.drawio` sin abrir un navegador; para **explicar** y **revisar** un diagrama en prosa; y para comprobar que los prompts siguen funcionando (**evals**). Se puede usar sin clave de API con cualquier otra IA o agente.

`generate`, `explain`, `review`, `prompt` y `--from-repo` funcionan con cualquier módulo de la suite (`--module <id>`, por omisión `c4`). La IA vive solo en el CLI: ni el sitio estático ni `iark serve` llaman a ningún modelo (y [por qué](servicio.md#por-qué-no-hay-ia-en-el-servicio)).

Índice de esta página: [verificación](#verificar-lo-generado-con-las-reglas-del-módulo) · [topes de tokens](#topes-de-tokens-sin-precios) · [explain y review](#explicar-y-revisar-un-diagrama-iark-explain-iark-review) · [evals](#evals-de-prompts) · [prueba real](#prueba-real-de-generate).

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

Flujo: la instrucción se envía a Claude (`claude-opus-5` por defecto) con **salida estructurada** contra el esquema del modelo *sin coordenadas*; el resultado se valida (referencias, jerarquía C4) y se **verifica con las reglas del módulo** (`validate()`), con reintentos automáticos si hay errores (ver abajo); después se aplica **autolayout** a todas las vistas y se escriben el JSON y el `.drawio`. Con `--from base.json` la instrucción se trata como un refinamiento del documento existente ("agrega una cola Kafka entre la API y las notificaciones"), conservando los ids y posiciones ya fijados.

## Verificar lo generado con las reglas del módulo

Desde esta versión `generate` no se conforma con que la respuesta cumpla el esquema: la pasa por `validate()` del módulo (lo mismo que `iark validate`) y, si hay **errores**, se los devuelve al modelo para que los corrija. Con las tres plataformas (`anthropic`, `foundry` y `openai`). El bucle, con `--retries <n>` reintentos en total (1 por omisión):

1. El modelo responde. Si no es JSON, no cumple el esquema o no se puede convertir en documento (referencias inexistentes, jerarquía…), se reintenta con ese error («reintento por el esquema»).
2. Si el documento es válido, `validate()` del módulo lo revisa. Un **error** (`severity: 'error'`) bloquea y se devuelve al modelo («reintento por las reglas»). Los **avisos** y las notas no bloquean, salvo con `--strict`, que los trata también como fallo.
3. Los errores que ya traía el documento base de un refinamiento no se le achacan al modelo: no bloquean.
4. Si tras los reintentos sigue habiendo errores, `generate` termina con **código 3** y la lista de incidencias (como `validate`), sin escribir nada. `--allow-invalid` acepta igualmente el último documento (se avisa con sus errores, y el resultado queda como `accepted-invalid`); `--no-verify` desactiva la verificación (solo el esquema, como antes).

Por stderr se informa de lo que pasó: cada intento con su motivo y sus tokens, el desglose «N por el esquema, M por las reglas del módulo», el resultado de la verificación y el presupuesto gastado.

```text
  intento 1 (inicial): incumple las reglas del módulo · 2.103 tokens de entrada, 790 de salida
  intento 2 (corrige las reglas): válido · 3.402 tokens de entrada, 836 de salida
  Reintentos: 0 por el esquema, 1 por las reglas del módulo.
  Verificación con las reglas del módulo: sin errores.
  Presupuesto: 7.131 de 200.000 tokens (salida máxima por llamada 16.000; entrada máxima 100.000).
```

> **Alcance real hoy.** Solo el módulo **C4** emite *errores* en `validate()`; los otros cinco (integración, datos, empresarial, plataforma y seguridad) emiten solo avisos y notas. Para ellos el bucle de reglas no reintenta nada salvo con `--strict` (que sí devuelve los avisos). Cuando un módulo declare reglas de error, el bucle las aplicará sin tocar más código.

## Topes de tokens (sin precios)

Un reintento reenvía toda la conversación, así que el coste crece con cada intento. Tres topes, sin precios (los precios cambian y dependen de la cuenta), todos en tokens y todos opcionales:

| Opción | Variable | Por omisión | Qué hace |
|---|---|---|---|
| `--max-tokens <n>` | `IARK_AI_MAX_TOKENS` | 16.000 | Tope de tokens de **salida** por llamada. Si la respuesta se corta por él, el error lo dice y propone subirlo (en `explain`/`review` se entrega lo escrito, con un aviso). |
| `--budget-tokens <n>` | `IARK_AI_BUDGET_TOKENS` | 200.000 | Tope **total** (entrada + salida) sumado en todos los reintentos. Antes de cada llamada se comprueba que quede para la entrada estimada más una salida mínima de 256 tokens, y se recorta `max_tokens` a lo que queda; al agotarse se detiene y dice cuánto se gastó (código 4). |
| `--max-input-tokens <n>` | `IARK_AI_MAX_INPUT_TOKENS` | 100.000 | **Rechaza antes de llamar** un prompt cuya entrada estimada lo supere (código 2). |

Precedencia: opción de la línea de comandos > variable de entorno > valor por omisión; deben ser enteros positivos. La entrada se **estima** con una heurística de 3 caracteres por token (no hay tokenizador común a las tres plataformas): sirve para el tope previo y para `--dry-run`; lo que se informa y se suma al presupuesto es lo que contó el proveedor. `--dry-run` y `prompt --from-repo` imprimen por stderr «Tamaño estimado del prompt: ~N tokens de entrada (máximo M, --max-input-tokens)» y avisan si lo supera.

Con `--from-repo`, si el prompt es demasiado grande el mensaje dice **qué recortar**: bajar `--repo-budget` (con su valor actual), limitar el contenido con `--repo-include`/`--repo-exclude`, apuntar `--from-repo` a una subcarpeta del monorepo, o ver el prompt con `--dry-run`.

Códigos de salida de los comandos de IA: `0` bien; `2` uso incorrecto o prompt demasiado grande; `3` el documento incumple las reglas del módulo; `4` cualquier otro error del modelo (credenciales, respuesta cortada, presupuesto agotado).

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
- **Privacidad**: nunca se leen `.env*`, claves y certificados privados, `.npmrc`/`.netrc`, `*.tfstate`/`*.tfvars` ni los Secret de Kubernetes; todo el texto incluido pasa por una redacción de patrones de secretos antes de recortar y otra vez sobre el resumen; no se ejecuta nada del repositorio (tampoco un `iark.config.json` que traiga: la configuración de [módulos de terceros](plugins.md) nunca se carga de un repositorio analizado) ni se siguen enlaces simbólicos; el contenido va al modelo como datos, no como instrucciones. `--dry-run` y `prompt` enseñan exactamente qué se enviaría antes de enviar nada.
- **URL de git** (`https://`, `ssh://` o `git@host:grupo/repo.git`; `--repo-ref <rama|etiqueta>`): se ejecuta solo `git clone` (sin shell, superficial, sin submódulos ni hooks, con 120 s de margen) a un directorio temporal que se borra siempre, también si falla o lo interrumpes; después no se ejecuta nada del clon. Se rechazan `http://`, `git://`, `file://`, las URL con usuario o token dentro y los valores que empiezan por «-»; un repositorio privado usa las credenciales que ya tengas en git y en ssh (IArk no las lee ni las guarda y git no pregunta contraseñas). En un clon no se aplica el `.gitignore` (solo trae lo versionado).
- **Filtros** (`--repo-include <glob>` y `--repo-exclude <glob>`, repetibles, en formato `.gitignore` y relativos a la raíz): `--repo-exclude` quita lo que cuadre de todo el resumen (árbol, componentes y contenido) y `--repo-include` limita el *contenido* a los archivos clave que cuadren (el árbol sigue entero); si ambos cuadran gana `--repo-exclude`. Solo reducen: nunca hacen legible lo que la lista de secretos prohíbe.
- Es solo del CLI: el servicio `iark serve` no lo expone, porque leería el disco del servidor.

## Explicar y revisar un diagrama (`iark explain`, `iark review`)

Dos comandos que **leen** un diagrama y contestan en prosa (Markdown), con cualquier módulo:

```bash
iark explain examples/banca.json                              # narra el diagrama por stdout
iark explain examples/pedidos-integracion.json --module integration --out explicacion.md
iark review  examples/seguridad-ejemplo.json --module security --lang en --out revision.md
cat banca.json | iark review --stdin --max-tokens 4000 --budget-tokens 20000
```

Entrada: `[archivo]` o `--stdin`, igual que `validate` (JSON del módulo o cualquier fuente que el módulo importe, como Mermaid o `.drawio`). Salida: `--out <archivo.md>` o stdout. Opciones: `--module <id>`, `--lang es|en` (español por omisión) y las de plataforma, modelo y presupuesto de `generate` (`--provider`, `--model`, `--effort`, `--max-tokens`, `--budget-tokens`, `--max-input-tokens`).

- **`explain`** devuelve «Resumen», «Cómo funciona», «Piezas clave» y, si procede, «Lo que el diagrama no dice».
- **`review`** pasa antes el documento por `validate()` del módulo y **entrega al modelo sus incidencias** como punto de partida (por stderr se cuenta cuántos errores, avisos y notas se le pasan). Devuelve «Resumen», «Incidencias del validador», «Inconsistencias», «Riesgos», «Ausencias» y «Recomendaciones» (como máximo cinco, priorizadas).
- El diagrama se envía **sin coordenadas** (la proyección compacta del módulo, la misma que usa `generate --from`) y dentro de `<documento>…</documento>` **como datos**: si sus textos contienen instrucciones, el modelo no debe seguirlas. Lo que hay que destacar y mirar en cada módulo lo declara el propio módulo (`AiSpec.explainGuide` y `reviewGuide`, opcionales: un módulo sin ellos usa guías generales).
- Es **una sola llamada**: sin reintentos. Una respuesta cortada por `--max-tokens` se entrega parcial con un aviso (no es un error); una respuesta vacía sí. Comparte con `generate` los topes de tokens y los códigos de salida (2 si la entrada estimada es demasiado grande, 4 para presupuesto agotado o credenciales).

## Evals de prompts

`npm run evals` mide si lo que los módulos le piden al modelo (y lo que este contesta) sigue siendo bueno. Cada módulo tiene casos en `evals/cases/<módulo>.json`: una instrucción en lenguaje natural (o un diagrama a explicar o revisar) más expectativas **comprobables**. Hoy son **16 casos** de los seis módulos: 10 de `generate` (uno de ellos refina un documento con `ref`), 3 de `explain` y 3 de `review` (C4, integración y seguridad). Cada caso dice en `notes` qué ejercita.

| Modo | Cómo | Qué usa | Cuesta |
|---|---|---|---|
| **offline** (por omisión) | `npm run evals` | Las respuestas **grabadas a mano** de `evals/recorded/<módulo>/<caso>.json`, servidas por un cliente simulado | Nada: sin red ni claves. Lo corre también `npm test` (`tests/evals.test.ts`) |
| **live** | `npm run evals:live -- --yes` | El modelo real configurado (mismas variables que `generate`) | Tokens de tu cuenta: ver abajo |

Qué comprueba cada caso (todo lo que no se indique es opcional): que el prompt contiene lo esperado y no pasa de un tamaño; que la respuesta cumple el **esquema** y `validate()` **sin errores**; las **entidades** mínimas por tipo, las menciones, el tamaño y un máximo de avisos; que **ningún `ref` (URN)** del documento base se pierda ni se invente al refinar; en offline, que el **bucle** hizo lo esperado (intentos, reintentos por el esquema y por las reglas, verificación); y en `explain`/`review`, que sea Markdown, tenga las secciones pedidas, mencione lo esperado y tenga un tamaño razonable. Las grabaciones incluyen respuestas que **fallan el esquema** (no es JSON; referencia inexistente) y que **fallan `validate()`** (vista sin alcance; avisos con `strict`) para ejercitar el bucle de corrección.

```bash
npm run evals                                            # informe por módulo y por caso; código de salida 1 si algún caso falla
npm run evals -- --module c4 --case tienda-en-linea --verbose
npm run evals -- --json informe.json                     # además, el informe completo en JSON
npm run evals -- --update-hashes                         # reescribe la huella del prompt de las grabaciones (ver abajo)
npm run evals:live -- --yes --provider openai --max-tokens 8000 --budget-tokens 60000   # gasta tokens: ver el coste abajo
```

- **Las grabaciones no las produjo ningún modelo**: se escribieron a mano para fijar el comportamiento esperado (cada una lo dice en `notes`). Son por eso una prueba de la **maquinaria** (esquema, bucle, reglas, prompts y comprobaciones), no de la calidad de ningún modelo: para eso está el modo live. Los tokens que informa el modo offline son una **estimación** (la misma heurística de los topes), y el informe lo rotula así.
- **Huella del prompt** (`promptSha256`): cada grabación recuerda el hash del prompt de sistema con el que se escribió. Si cambias un prompt, el informe **avisa** («grabación obsoleta») pero no falla: repite `npm run evals:live`, y si todo sigue bien actualiza la huella con `--update-hashes`.
- **Live**: exige credenciales de la plataforma elegida y `--yes` (sin él no llama a nada: gasta tokens de tu cuenta). Aplica `--max-tokens` y `--budget-tokens` a **cada caso** y `--run-budget-tokens` (600.000 por omisión) a **toda la ejecución**: al agotarse, los casos que quedan se omiten y se anotan como tales. Un caso que falla en live no es un error del ejecutor: es la información que se busca. En live no se compara la forma exacta del bucle (el número de intentos varía de una vez a otra).
- **Añadir un caso**: una entrada en `evals/cases/<módulo>.json` y su grabación en `evals/recorded/<módulo>/<id>.json` (`{ "case", "notes", "responses": [ "texto" | { "content": {…}, "finish_reason"? } ] }`: una respuesta por intento, en orden). Las respuestas JSON son las de la **salida estructurada** del módulo (`iark schema --generation --module <id>`), con `null` en los campos que no se usan. `npm test` falla si un caso no tiene grabación o una grabación no tiene caso.

**Coste aproximado de `evals:live`** (orden de magnitud, no un precio): con las grabaciones como referencia, el conjunto entero son unos **54.000 tokens de entrada y 13.000 de salida** (≈ 67.000) si el modelo acierta donde las grabaciones lo hacen, y hasta **2 o 3 veces más** si necesita todos los reintentos. El tope duro de una ejecución es `--run-budget-tokens` (600.000 por omisión). Por módulo (entrada / salida): C4 15.900 / 3.800 · integración 14.300 / 3.000 · seguridad 14.300 / 3.500 · datos 3.800 / 1.300 · empresa 3.100 / 600 · plataforma 3.100 / 900. Para probar barato, un solo caso: `npm run evals:live -- --yes --module data` (unos 5.000 tokens).

## Servicio HTTP: sin IA

`iark serve` no genera, explica ni revisa con IA, y no se ha hecho por descuido: una ruta HTTP que llama a un modelo gasta dinero de quien despliega el servicio con una petición anónima. Qué habría que exigir antes de añadirla (credencial obligatoria, cuota por persona, tope de presupuesto) está en [Servicio HTTP: por qué no hay IA en el servicio](servicio.md#por-qué-no-hay-ia-en-el-servicio). Una prueba (`src/cli/serveSinIa.test.ts`) fija que no hay ninguna ruta de IA.

## Prueba real de `generate`

La generación con IA está cubierta por pruebas con clientes simulados (`packages/domain-c4/src/ai/generate.test.ts` y `packages/kernel/src/ai/*.test.ts`) y, además, se ejecutó
contra un servicio real. Estado por proveedor:

| Proveedor | Estado |
|---|---|
| **Foundry, cualquier modelo** (`--provider openai`) | **Probado** con DeepSeek‑V4‑Pro (28‑09‑2026): un intento, JSON válido, 6 elementos, 4 relaciones y 2 vistas; `validate --strict` sin errores ni avisos, todas las vistas con coordenadas y el `.drawio` con una página por vista. Variables usadas: `AI_API_KEY`, `AI_BASE_URL` y `AI_MODEL` (también valen las `ANTHROPIC_FOUNDRY_*`). |
| **Claude en Foundry** (`--provider foundry`) | **Sin probar**: requiere un despliegue de Claude en el recurso, `ANTHROPIC_FOUNDRY_BASE_URL` (`https://<recurso>.services.ai.azure.com/anthropic/`) o `ANTHROPIC_FOUNDRY_RESOURCE`, `ANTHROPIC_FOUNDRY_API_KEY` y `ANTHROPIC_FOUNDRY_MODEL` con el nombre de ese despliegue. |
| **API de Anthropic** | **Sin probar**: requiere `ANTHROPIC_API_KEY` con créditos (la suscripción de Claude.ai no incluye acceso a la API). |

La última prueba real registrada es del 28‑09‑2026 y fue sobre el módulo C4: desde entonces el repositorio no registra otra (ni con los proveedores sin probar, ni con otro `--module`, ni con `--from-repo`). **Pendiente de probar con claves reales**: el bucle de verificación con `validate()`, los topes de tokens, `explain` y `review` y los evals en modo live. Están cubiertos por pruebas con servicios simulados (`packages/kernel/src/ai/*.test.ts`, `src/cli/iaVerificacion.test.ts`, `src/cli/comentario.test.ts`, `tests/evals.test.ts`), pero ningún modelo real los ha ejecutado todavía.

### Prueba real automatizada (`tests/ai-live.test.ts`)

Para quien tenga claves, hay una prueba que **se salta sola** (en `npm test` y en el CI aparece como *skipped*) y que, con las variables, llama a un modelo de verdad. Tener `AI_*` o `ANTHROPIC_*` definidas **no basta**: hay que pedirla con `IARK_LIVE_AI=1`.

```bash
# 1. Credenciales de UNA plataforma, en el entorno (nunca en el repositorio): ver la tabla del principio de esta página.
export AI_BASE_URL=https://<recurso>.openai.azure.com/openai/v1 AI_API_KEY=… AI_MODEL=<despliegue>
# 2. Pedirla expresamente (IARK_LIVE_PROVIDER fuerza la plataforma: auto | anthropic | foundry | openai).
IARK_LIVE_AI=1 npx vitest run tests/ai-live.test.ts
IARK_LIVE_AI=1 IARK_LIVE_PROVIDER=foundry npx vitest run tests/ai-live.test.ts   # p. ej. Claude en Foundry
```

Para la API de Anthropic, esta prueba y `evals:live` exigen la clave en el entorno (`ANTHROPIC_API_KEY` o `ANTHROPIC_AUTH_TOKEN`); iniciar sesión con `ant auth login` solo vale para el CLI.

Qué comprueba, con un documento pequeño (un blog con web, API y base de datos): que **genera** un C4 que cumple el esquema y `validate()` sin errores, con el **bucle** coherente (el informe por intento termina en «válido», y los reintentos suman los intentos menos uno); que los **totales de tokens** son la suma de los intentos y caben en el presupuesto; que **`--max-tokens` pequeño** corta la respuesta y el error lo explica; que un **presupuesto que no alcanza** se rechaza antes de llamar (sin gastar); y que `explain` contesta dentro del tope de salida. **Cuesta del orden de 10.000 tokens** (hasta unos 20.000 si el modelo necesita reintentos); la comprobación del presupuesto no gasta nada. Sin las variables hay además tres pruebas que siempre corren y fijan que la puerta no se abre sola.

**Esta prueba no la ha ejecutado nadie todavía**: se escribió y se comprobó que se salta sin variables, pero ningún modelo real la ha corrido. Cuando se ejecute con una plataforma, anota aquí el resultado en la tabla de estado de arriba.

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
