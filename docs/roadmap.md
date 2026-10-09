# Hoja de ruta de IArk - DIAgrams

[← Índice de la documentación](indice.md)

Qué es la suite hoy, adónde va y qué falta. Lo que ya está hecho, fase por fase y tanda por tanda, está en [historial.md](historial.md); aquí solo hay lo vigente. Última revisión: 2026-10-09.

- [Visión TO-BE](#visión-to-be)
- [Estado actual](#estado-actual)
- [Plan de robustecimiento en cuatro fases](#plan-de-robustecimiento-en-cuatro-fases)
- [Pendientes](#pendientes)
- [Límites conocidos y fuera de alcance](#límites-conocidos-y-fuera-de-alcance)

## Visión TO-BE

IArk - DIAgrams quiere ser la forma abierta, auditable y ligera de dibujar arquitectura como datos: seis especialidades sobre un núcleo común, con documentos JSON estables que se versionan en git, se generan y verifican con IA y se enlazan entre sí por URN. Se usa de tres maneras que comparten contrato: en el navegador (sitio estático), en la línea de comandos y la integración continua (`iark`), y como servicio o widget embebido en otra aplicación.

El TO-BE tiene cuatro rasgos, que son las cuatro fases del plan de abajo:

1. **Endurecida**: sin hallazgos de seguridad altos, con compuerta de CI, rama protegida y los documentos de proyecto en su sitio (licencia, política de seguridad, guía de contribución y registro de cambios).
2. **Abierta**: cualquiera puede añadir un módulo, un importador o un paquete de iconos sin tocar este repositorio, y los documentos migran entre versiones del contrato.
3. **Profunda**: cada módulo importa los formatos reales de su mundo, la IA verifica lo que genera y se mide con evals, C4 comparte el lienzo común, y todo es accesible y rápido.
4. **Escalable**: una instancia gestionada con cuentas transaccionales, observabilidad y auditoría, colaboración y trabajo sin conexión, administración de cuentas e interfaz en español e inglés.

## Estado actual

| Área | Estado | Más |
|---|---|---|
| Núcleo y módulos | **Hecho**: `@iark/kernel` y seis módulos (`c4`, `integration`, `data`, `enterprise`, `platform`, `security`), cada uno con esquema, validación, vistas, IA, importadores, exportadores y editor | [historial](historial.md#fases-0-a-6-plan-aprobado-el-2026-09-29) |
| Web | **Hecho**: editor C4; banco de trabajo con lienzo propio en los cinco módulos que no son C4 (y el editor C4 embebido en él); suite; trazabilidad | [suite-web.md](suite-web.md) |
| CLI | **Hecho**: `generate`, `explain`, `review`, `layout`, `convert`, `import`, `validate`, `schema`, `prompt`, `diff`, `trace`, `project`, `auth`, `serve` y los comandos de cada módulo | [cli.md](cli.md) |
| IA | **Hecho**: API de Anthropic, Claude en Foundry, cualquier modelo de Foundry, modo sin clave (`iark prompt`), `--from-repo`, verificación con `validate()`, topes de tokens, `explain`/`review` y evals. Probado de verdad solo con DeepSeek-V4-Pro (28-09-2026); lo nuevo, solo con servicios simulados | [ia.md](ia.md) |
| Importadores | **Hecho**: `.drawio`, Structurizr DSL, Mermaid, OpenAPI, AsyncAPI, Threat Dragon, Terraform, Kubernetes, CloudFormation, Helm, DDL de SQL, dbt, OpenLineage, ArchiMate y BPMN; cada módulo importa al menos un formato real además de Mermaid | [importadores.md](importadores.md) |
| Federación y embebido | **Hecho**: manifiesto `iark.manifest/1`, shell, SDK de anfitrión y Web Component `<iark-module>` | [embebido.md](embebido.md) |
| Trazabilidad | **Hecho** (v1 y v2): referencias por URN con tipo de enlace, `iark trace` (huérfanos, matriz y cobertura), `POST /api/trace` y vista web | [trazabilidad.md](trazabilidad.md) |
| Versionado de diagramas | **Hecho**: `iark diff` y pestaña «Comparar» (sin instantáneas en el navegador) | [cli.md](cli.md#comparar-versiones-de-un-diagrama-iark-diff) |
| Proyectos y nube | **Hecho**: carpeta de trabajo, navegador, servidor propio con tokens, inicio de sesión de GitHub, compartir proyectos, API y pantalla de administración de cuentas | [proyectos.md](proyectos.md) · [servicio.md](servicio.md) · [cuentas-github.md](cuentas-github.md) |
| Despliegue | **Hecho**: GitHub Pages automático, imagen Docker y `deploy/` con Caddy | [despliegue-pages.md](despliegue-pages.md) · [despliegue-nube.md](despliegue-nube.md) |
| Observabilidad | **Hecho** (v1, apagada por omisión): `X-Request-Id`, registro de accesos, auditoría de cambios, `/healthz`, `/readyz` y métricas de Prometheus en `iark serve` | [observabilidad.md](observabilidad.md) |
| Pruebas | **Hecho**: unitarias, e2e estables y prueba real de la imagen (`docker:smoke`) | [desarrollo.md](desarrollo.md) |
| Endurecimiento | **En curso** (Fase 1) | [abajo](#fase-1-endurecer-en-curso) |

## Plan de robustecimiento en cuatro fases

Cada fase termina en una **puerta**: una condición que se puede comprobar y que habilita la siguiente.

| Fase | Estado | Puerta |
|---|---|---|
| **1 · Endurecer** | **En curso** | Sin hallazgos de seguridad altos y `master` protegido |
| **2 · Abrir** | Pendiente | Un módulo de terceros carga sin tocar el repositorio |
| **3 · Profundizar** | **En curso** | Cada módulo importa formatos reales (**cumplida**, acción 13) |
| **4 · Escalar** | Pendiente | Instancia gestionada operada y medida |

### Fase 1 «Endurecer» (en curso)

Que lo que ya existe sea seguro y repetible de mantener antes de abrirlo a terceros.

- **Hallazgos de seguridad altos** del diagnóstico: corregirlos hasta que no quede ninguno abierto (servicio `iark serve`, API de proyectos y cuentas).
- **Compuerta de CI**: typecheck, pruebas, build y e2e en cada PR a `master`, y la imagen Docker construida en CI. Al empezar la fase, el único workflow compila el sitio y lo publica ([despliegue-pages.md](despliegue-pages.md)).
- **Cabeceras de seguridad y origen embebido**: cabeceras HTTP del sitio y del servicio, y comprobación estricta del origen del anfitrión en el modo embebido (sin `&origin=`, hoy el iframe responde a `*`; ver [embebido.md](embebido.md)).
- **`LICENSE`, `SECURITY.md`, `CONTRIBUTING.md` y `CHANGELOG.md`** en la raíz.
- **README y roadmap**: README corto, documentación en `docs/` y hoja de ruta sin historial.
- **Cálculo del servidor fuera del hilo principal**: hoy un diagrama muy grande exportado por la API bloquea el servicio mientras se calcula la distribución (~90 s con 300 contenedores).

**Puerta**: sin hallazgos altos y `master` protegido.

### Fase 2 «Abrir»

Que la suite se pueda ampliar desde fuera.

- **Migración de documentos y versión del contrato** (**hecho**): cada módulo declara cómo migrar sus documentos (`DomainModule.migrations`, `iark migrate`), el contrato `DomainModule` ([`types.ts`](../packages/kernel/src/module/types.ts)) lleva su `contractVersion` y el protocolo embebido y el manifiesto negocian versiones; ver [versionado-documentos.md](versionado-documentos.md). Hoy los seis módulos siguen en `1.0` y no tienen migraciones reales: el mecanismo está probado con documentos antiguos congelados.
- **Plugins e `iark.config` con paquetes publicables** (**hecho en CLI y `iark serve`**; acción 15): un módulo de terceros —un paquete que implementa `DomainModule`— se carga desde un `iark.config.json` (`--config`, `IARK_CONFIG` o el del directorio actual; `--no-config` lo desactiva) y se usa como uno incorporado en el CLI, en `iark serve` y en sus hilos de cálculo, sin tocar el repositorio ([plugins.md](plugins.md); ejemplo completo en [`examples/plugin-riesgos/`](../examples/plugin-riesgos/)). Cargar un módulo ejecuta su código, así que nunca se carga de `--from-repo`, `--workspace`, una petición HTTP ni un documento. Los paquetes `@iark/kernel` y `@iark/domain-*` se pueden empaquetar e instalar solos (`npm run packages:build` y `packages:check`) y hay un workflow manual para publicarlos ([desarrollo.md](desarrollo.md#paquetes-publicables-iarkkernel-y-iarkdomain-)). **Falta**: la primera publicación real en npm (pendiente del ámbito `@iark` y del secreto `NPM_TOKEN`), y **el sitio web no carga módulos de terceros** (el banco de trabajo, el shell y el editor se compilan con los seis incorporados; cargarlos en el navegador exige un diseño de aislamiento y confianza que no existe todavía). Importadores y paquetes de iconos sueltos tampoco se cargan: solo módulos completos.
- **Trazabilidad v2 (hecha)**: enlaces tipados (`refType` junto a `ref`, con un vocabulario abierto), huérfanos, matriz de enlaces y cobertura por reglas, con `--strict` que ahora falla también con la cobertura por debajo del mínimo; en el CLI, el servicio, los proyectos, la vista web y el banco de trabajo ([trazabilidad.md](trazabilidad.md)). Fuera de esta entrega: cobertura inversa (destino → origen) y la ruta `/api/projects/<p>/trace`.

**Puerta**: un módulo de terceros carga sin tocar el repositorio. **Cumplida solo en el CLI y en `iark serve`** (acción 15): el ejemplo `examples/plugin-riesgos/` se carga y se prueba con el CLI empaquetado de verdad y con el servicio, y `packages:check` lo repite con los paquetes instalados desde tarballs. En el sitio web la puerta no se cumple (límite dicho arriba).

### Fase 3 «Profundizar»

Que cada módulo sea útil con los archivos reales de quien lo usa.

- **Importadores clave** (**hecho**, acción 13): integración importa OpenAPI y AsyncAPI, seguridad OWASP Threat Dragon, datos OpenLineage (además de DDL y dbt), empresarial BPMN (además de ArchiMate) y plataforma CloudFormation y Helm (además de Terraform y Kubernetes). Todos leen sin red ni disco, con topes de tamaño y profundidad, y avisan de lo que no entra ([importadores.md](importadores.md)). **Quedan** los límites conocidos: los módulos locales de Terraform y las referencias `$ref` a otros archivos no se resuelven, un chart de Helm sin renderizar no interpreta sus plantillas (hay que pasar la salida de `helm template`), CloudFormation no evalúa condiciones ni expande `Transform`, los ids de ArchiMate dependen del idioma y «Abrir archivo…» del encabezado admite un solo archivo.
- **IA con verificación y evals** (hecho, salvo la prueba real con claves): `generate` verifica con `validate()` del módulo y reintenta por sus errores (`--no-verify`, `--allow-invalid`, `--strict`); topes de tokens sin precios (`--max-tokens`, `--budget-tokens`, `--max-input-tokens`); `iark explain` y `iark review`; `npm run evals` (16 casos de los seis módulos con respuestas grabadas a mano, también en `npm test`) y `npm run evals:live`; el servicio HTTP queda sin IA, documentado ([ia.md](ia.md), [servicio.md](servicio.md#por-qué-no-hay-ia-en-el-servicio)). **Falta**: ejecutar `tests/ai-live.test.ts` y `evals:live` con claves reales (hoy solo hay una prueba real, de C4 y con DeepSeek-V4-Pro), probar los proveedores que están sin probar y completar `--from-repo` (monorepos, manifiesto de auditoría del envío).
- **C4 en el lienzo común**: C4 conserva su editor propio y en el banco de trabajo va embebido en un iframe; unificarlo con el lienzo de los módulos (y con ello el resaltado de «Comparar» llegaría al lienzo C4).
- **Accesibilidad**: auditoría y arreglos del editor y del banco de trabajo (teclado, lectores de pantalla, contraste).
- **Rendimiento**: diagramas grandes en el lienzo y en el autolayout, y el tamaño de los trozos de la compilación (hoy `chunkSizeWarningLimit: 2000`).

**Puerta**: cada módulo importa formatos reales. **Cumplida** (acción 13): los seis módulos importan al menos un formato real además de Mermaid, probado con archivos de ejemplo escritos para el proyecto, con la CLI empaquetada de verdad y con el servicio. La fase sigue en curso por el resto de sus tareas (C4 en el lienzo común, accesibilidad, rendimiento y la prueba real de la IA con claves).

### Fase 4 «Escalar»

Que una instancia gestionada se pueda operar y medir.

- **Cuentas transaccionales**: las cuentas son un JSON con un único escritor (una sola réplica); pasar a un almacén transaccional y a varias réplicas.
- **Observabilidad y auditoría** *(hecho: registro de accesos, auditoría, salud y métricas en `iark serve`, ver [observabilidad.md](observabilidad.md))*. Queda lo que ese documento reconoce en «Límites»: probarlo con un Prometheus, `logrotate` y una plataforma reales, reunir los registros de varias réplicas cuando las haya, y trazas distribuidas.
- **Colaboración y sin conexión**: hoy los cambios de dos personas no se mezclan, no hay tiempo real ni trabajo sin conexión, y no hay instantáneas guardadas en el navegador.
- **Administración de cuentas**: cuotas de disco por persona. La pantalla de administración (invitar, roles, desactivar, cancelar invitaciones) ya está hecha: [cuentas-github.md](cuentas-github.md#pantalla-de-administración).
- **Interfaz es/en**: la interfaz está en español.

**Puerta**: instancia gestionada operada y medida.

## Pendientes

Los pendientes menores y límites conocidos al 2026-10-08, con la fase en la que se resuelven (propuesta; se revisa al empezar cada fase).

| Área | Pendiente | Fase |
|---|---|---|
| Docker | No se ha probado un build en una máquina con red normal (sin el proxy del entorno de desarrollo); la imagen tampoco se ha probado con `--tokens` | 1 |
| Servicio | Un diagrama muy grande exportado por la API bloquea el servicio mientras se calcula la distribución (~90 s con 300 contenedores) | 1 |
| Seguridad | Un token guardado en el navegador queda expuesto a un XSS del sitio que lo use; `iark serve` no habla TLS (hace falta un proxy con https) | 1 |
| Nube gestionada | Sin cuotas de disco por persona, y la pantalla de administración de cuentas no registra quién cambió qué (las cuentas de servicio con token administran por la API) | 4 |
| Nube gestionada | El inicio de sesión recarga la página (sin ventana emergente) | 4 |
| Nube gestionada | Una sola réplica: las cuentas son un JSON con un único escritor | 4 |
| Nube gestionada | El freno de intentos solo lee la última entrada de `X-Forwarded-For` (plataformas con otra cabecera, como `Fly-Client-IP`, comparten freno) | 4 |
| Nube gestionada | No se ha probado con un certificado público real ni en una plataforma concreta | 4 |
| Nube gestionada | La observabilidad no se ha probado con un Prometheus, un `logrotate` ni un Caddy reales; los registros y las métricas son de una sola instancia (sin reunir varias réplicas) y no hay trazas distribuidas; la auditoría no es a prueba de manipulación (envío a un sistema externo o `chattr +a`) ni cubre las lecturas | 4 |
| Versionado | No hay instantáneas guardadas en el navegador (se compara con archivos, git o un JSON abierto) | 4 |
| Versionado | El resaltado de cambios no llega al lienzo C4 embebido (es un iframe; el panel sí funciona) | 3 |
| Versionado | La pestaña «Comparar» comparte nombre con la vista «Comparar» de Plataforma (entornos lado a lado); podría llamarse «Versiones» | 3 |
| IA | Falta ejecutar con claves reales la verificación con `validate()`, los topes de tokens, `explain`/`review`, `tests/ai-live.test.ts` y `npm run evals:live` (solo hay pruebas con servicios simulados); y solo C4 emite *errores* en `validate()`, así que en los otros cinco módulos el bucle de reglas solo actúa con `--strict` | 3 |
| IA | El servicio HTTP no ofrece IA a propósito: antes haría falta credencial obligatoria, cuota por persona y tope de presupuesto ([servicio.md](servicio.md#por-qué-no-hay-ia-en-el-servicio)) | 4 |
| IA desde repo | Solo los manifiestos y puntos de entrada más comunes; monorepos y repos enormes (árbol a profundidad 3, cuotas globales) | 3 |
| IA desde repo | Un archivo versionado pero ignorado por `.gitignore` no se ve en una carpeta local (en un clon el `.gitignore` no se aplica) | 3 |
| IA desde repo | Falta un manifiesto de auditoría del envío; el intérprete de `.gitignore` sigue siendo O(n·m) por regla y sin presupuesto global de trabajo | 3 |
| Plataforma | `counterpartResource` (re-apuntado de dependencias al promover) usa `counterpartOf` si existe, pero su deducción por nombre y clase sigue siendo propia: falta que reutilice el emparejado de la comparación (`pairResources`) | 3 |
| Plataforma | El lienzo no marca en los nodos que un recurso tiene equivalente declarado (solo lo dicen el selector y la comparación) | 3 |
| Importadores | Los módulos locales de Terraform no se resuelven; los ids de ArchiMate salen del nombre y dependen del idioma elegido (`lang`) | 3 |
| Importadores | OpenAPI, AsyncAPI y CloudFormation no siguen referencias a otros archivos o URL (se avisa), CloudFormation no evalúa condiciones ni expande `Transform`, y un chart de Helm sin renderizar no interpreta `templates/` (para eso, `helm template` + importador de Kubernetes) | 3 |
| Importadores | Los formatos nuevos se han probado con archivos de ejemplo escritos para el proyecto y no con modelos de herramientas reales (Camunda, Marquez, Threat Dragon, SAM…); Threat Dragon v1 no se lee | 3 |
| Importadores | «Abrir archivo…» del encabezado admite un solo archivo (el de «Abrir archivo a importar…» admite varios `.tf` o los archivos de un chart de Helm) | 3 |
| Paquetes | Quedan imports de solo pruebas sin declarar en su paquete y resueltos por la raíz (`fast-xml-parser` en data, platform y security, `mermaid` en data, `@anthropic-ai/sdk` en c4 y `vitest`) | 2 |
| Proyectos | IndexedDB se puede borrar con los datos del sitio (hay *Exportar*); dos personas o pestañas sobre el mismo diagrama no se mezclan (el segundo guardado pregunta qué versión conservar) | 4 |
| Proyectos | No hay trabajo sin conexión (un guardado que falla por la red se reintenta solo, pero solo lo que sigue en memoria) ni tiempo real entre personas (la lista se relee al volver el foco y cada 30 s) | 4 |

El pendiente sobre el entorno de pruebas («el entorno de este repositorio no trae `fake-indexeddb` instalado») pasó a las [trampas conocidas](desarrollo.md#trampas-conocidas) de `docs/desarrollo.md`.

## Límites conocidos y fuera de alcance

Fuera de alcance de la v1: servidor MCP, vistas de despliegue y de código de C4, colaboración en tiempo real, importar `.drawio` o DSL de Structurizr desde el modo embebido (el anfitrión puede usar `fromDrawio` / `fromStructurizrDsl` del núcleo) y exportar a DSL de Structurizr.

La exportación SVG y PNG desde el modo embebido figuraba aquí como fuera de alcance y ya está implementada: ver [embebido.md](embebido.md).

Límites de diseño vigentes, con su explicación en cada documento:

- **Servicio**: `iark serve` solo habla HTTP, no registra accesos ni cambios salvo que se active (`--access-log`, `--audit-log`; llevan usuario e IP: [observabilidad.md](observabilidad.md)), y con `--tokens` los tokens no caducan y sus roles valen para toda la carpeta de trabajo (con `--accounts`, inicio de sesión de GitHub, hay permisos por proyecto) ([servicio.md](servicio.md)).
- **Proyectos**: sin trabajo sin conexión ni tiempo real; cada guardado envía el documento entero (límite de 5 MB) y la lista incluye todos los diagramas, pensado para carpetas pequeñas o medianas ([proyectos.md](proyectos.md)).
- **Importadores**: lo que no se mapea se avisa, no se importa (capas y formas ocultas en `.drawio`, despliegue y vistas `dynamic` en el DSL de Structurizr, `.drawio.svg` y `.drawio.png`, datos y anotaciones en BPMN, `webhooks` en OpenAPI, plantillas de un chart de Helm…), y nada se lee de la red ni del disco al importar ([importadores.md](importadores.md)).
- **Módulos de terceros**: se cargan en el CLI y en `iark serve`, no en el sitio web (sin editor visual, sin entrada en el banco de trabajo ni en el shell); cargar uno ejecuta su código con los permisos del proceso y por eso solo se carga la configuración que señala quien ejecuta el comando; no se descargan ni se instalan solos y no hay recarga en caliente ([plugins.md](plugins.md)). Los paquetes `@iark/*` están listos para publicarse pero no se han publicado.
- **Módulos**: al importar DDL o dbt no se deduce nada de gobierno (solo lo que declare el `meta` de dbt), y los importadores de plataforma no escriben `counterpartOf` porque nada en esos formatos dice qué recurso es el equivalente de otro entorno ([datos.md](modulos/datos.md), [plataforma.md](modulos/plataforma.md)).
