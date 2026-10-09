# Hoja de ruta de IArk - DIAgrams

[← Índice de la documentación](indice.md)

Qué es la suite hoy, adónde va y qué falta. Lo que ya está hecho, fase por fase y tanda por tanda, está en [historial.md](historial.md); aquí solo hay lo vigente. Última revisión: 2026-10-08.

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
| CLI | **Hecho**: `generate`, `layout`, `convert`, `import`, `validate`, `schema`, `prompt`, `diff`, `trace`, `project`, `auth`, `serve` y los comandos de cada módulo | [cli.md](cli.md) |
| IA | **Hecho**: API de Anthropic, Claude en Foundry, cualquier modelo de Foundry, modo sin clave (`iark prompt`) y `--from-repo`. Probado de verdad solo con DeepSeek-V4-Pro (28-09-2026) | [ia.md](ia.md) |
| Importadores | **Hecho**: `.drawio`, Structurizr DSL, Mermaid, Terraform, Kubernetes, DDL de SQL, dbt y ArchiMate. Integración y seguridad solo importan Mermaid | [importadores.md](importadores.md) |
| Federación y embebido | **Hecho**: manifiesto `iark.manifest/1`, shell, SDK de anfitrión y Web Component `<iark-module>` | [embebido.md](embebido.md) |
| Trazabilidad | **Hecho** (v1): referencias por URN, `iark trace`, `POST /api/trace` y vista web | [trazabilidad.md](trazabilidad.md) |
| Versionado de diagramas | **Hecho**: `iark diff` y pestaña «Comparar» (sin instantáneas en el navegador) | [cli.md](cli.md#comparar-versiones-de-un-diagrama-iark-diff) |
| Proyectos y nube | **Hecho**: carpeta de trabajo, navegador, servidor propio con tokens, inicio de sesión de GitHub, compartir proyectos, API y pantalla de administración de cuentas | [proyectos.md](proyectos.md) · [servicio.md](servicio.md) · [cuentas-github.md](cuentas-github.md) |
| Despliegue | **Hecho**: GitHub Pages automático, imagen Docker y `deploy/` con Caddy | [despliegue-pages.md](despliegue-pages.md) · [despliegue-nube.md](despliegue-nube.md) |
| Pruebas | **Hecho**: unitarias, e2e estables y prueba real de la imagen (`docker:smoke`) | [desarrollo.md](desarrollo.md) |
| Endurecimiento | **En curso** (Fase 1) | [abajo](#fase-1-endurecer-en-curso) |

## Plan de robustecimiento en cuatro fases

Cada fase termina en una **puerta**: una condición que se puede comprobar y que habilita la siguiente.

| Fase | Estado | Puerta |
|---|---|---|
| **1 · Endurecer** | **En curso** | Sin hallazgos de seguridad altos y `master` protegido |
| **2 · Abrir** | Pendiente | Un módulo de terceros carga sin tocar el repositorio |
| **3 · Profundizar** | Pendiente | Cada módulo importa formatos reales |
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

- **Migración de documentos y versión del contrato**: cada módulo declara la versión de su documento (`documentVersion`), pero nada migra entre versiones todavía; el kernel debe migrar, y el contrato `DomainModule` ([`types.ts`](../packages/kernel/src/module/types.ts)) llevar su propia versión para poder cambiarlo sin romper módulos externos.
- **Plugins e `iark.config` con paquetes publicables**: hoy los módulos se registran a mano en `src/cli/registry.ts` y los paquetes `@iark/*` se consumen desde su código fuente. El objetivo es publicarlos (declarando bien sus dependencias) y cargar módulos, importadores y paquetes de iconos desde una configuración.
- **Trazabilidad v2**: evolución de la v1 (referencias por URN, referencias sin resolver y alcance de un elemento); su alcance se fija al empezar la fase.

**Puerta**: un módulo de terceros carga sin tocar el repositorio.

### Fase 3 «Profundizar»

Que cada módulo sea útil con los archivos reales de quien lo usa.

- **Importadores clave**: integración y seguridad solo importan Mermaid; cada módulo debe importar los formatos reales de su mundo. Se suman los límites conocidos de los actuales (módulos locales de Terraform, ids de ArchiMate que dependen del idioma, «Abrir archivo…» con un solo archivo).
- **IA con verificación y evals**: medir la calidad de lo que genera cada proveedor y módulo (hoy solo hay una prueba real, de C4), verificar el resultado más allá del esquema, probar los proveedores que están sin probar y completar `--from-repo` (monorepos, manifiesto de auditoría del envío).
- **C4 en el lienzo común**: C4 conserva su editor propio y en el banco de trabajo va embebido en un iframe; unificarlo con el lienzo de los módulos (y con ello el resaltado de «Comparar» llegaría al lienzo C4).
- **Accesibilidad**: auditoría y arreglos del editor y del banco de trabajo (teclado, lectores de pantalla, contraste).
- **Rendimiento**: diagramas grandes en el lienzo y en el autolayout, y el tamaño de los trozos de la compilación (hoy `chunkSizeWarningLimit: 2000`).

**Puerta**: cada módulo importa formatos reales.

### Fase 4 «Escalar»

Que una instancia gestionada se pueda operar y medir.

- **Cuentas transaccionales**: las cuentas son un JSON con un único escritor (una sola réplica); pasar a un almacén transaccional y a varias réplicas.
- **Observabilidad y auditoría**: el servidor no registra accesos ni quién cambió qué; registros estructurados, métricas y auditoría.
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
| Versionado | No hay instantáneas guardadas en el navegador (se compara con archivos, git o un JSON abierto) | 4 |
| Versionado | El resaltado de cambios no llega al lienzo C4 embebido (es un iframe; el panel sí funciona) | 3 |
| Versionado | La pestaña «Comparar» comparte nombre con la vista «Comparar» de Plataforma (entornos lado a lado); podría llamarse «Versiones» | 3 |
| IA desde repo | Solo los manifiestos y puntos de entrada más comunes; monorepos y repos enormes (árbol a profundidad 3, cuotas globales) | 3 |
| IA desde repo | Un archivo versionado pero ignorado por `.gitignore` no se ve en una carpeta local (en un clon el `.gitignore` no se aplica) | 3 |
| IA desde repo | Falta un manifiesto de auditoría del envío; el intérprete de `.gitignore` sigue siendo O(n·m) por regla y sin presupuesto global de trabajo | 3 |
| Plataforma | `counterpartResource` (re-apuntado de dependencias al promover) usa `counterpartOf` si existe, pero su deducción por nombre y clase sigue siendo propia: falta que reutilice el emparejado de la comparación (`pairResources`) | 3 |
| Plataforma | El lienzo no marca en los nodos que un recurso tiene equivalente declarado (solo lo dicen el selector y la comparación) | 3 |
| Importadores | Los módulos locales de Terraform no se resuelven; los ids de ArchiMate salen del nombre y dependen del idioma elegido (`lang`) | 3 |
| Importadores | «Abrir archivo…» del encabezado admite un solo archivo (el de «Abrir archivo a importar…» admite varios `.tf`) | 3 |
| Paquetes | Quedan imports de solo pruebas sin declarar en su paquete y resueltos por la raíz (`fast-xml-parser` en data, platform y security, `mermaid` en data, `@anthropic-ai/sdk` en c4 y `vitest`) | 2 |
| Proyectos | IndexedDB se puede borrar con los datos del sitio (hay *Exportar*); dos personas o pestañas sobre el mismo diagrama no se mezclan (el segundo guardado pregunta qué versión conservar) | 4 |
| Proyectos | No hay trabajo sin conexión (un guardado que falla por la red se reintenta solo, pero solo lo que sigue en memoria) ni tiempo real entre personas (la lista se relee al volver el foco y cada 30 s) | 4 |

El pendiente sobre el entorno de pruebas («el entorno de este repositorio no trae `fake-indexeddb` instalado») pasó a las [trampas conocidas](desarrollo.md#trampas-conocidas) de `docs/desarrollo.md`.

## Límites conocidos y fuera de alcance

Fuera de alcance de la v1: servidor MCP, vistas de despliegue y de código de C4, colaboración en tiempo real, importar `.drawio` o DSL de Structurizr desde el modo embebido (el anfitrión puede usar `fromDrawio` / `fromStructurizrDsl` del núcleo) y exportar a DSL de Structurizr.

La exportación SVG y PNG desde el modo embebido figuraba aquí como fuera de alcance y ya está implementada: ver [embebido.md](embebido.md).

Límites de diseño vigentes, con su explicación en cada documento:

- **Servicio**: `iark serve` solo habla HTTP, no registra accesos, y con `--tokens` los tokens no caducan y sus roles valen para toda la carpeta de trabajo (con `--accounts`, inicio de sesión de GitHub, hay permisos por proyecto) ([servicio.md](servicio.md)).
- **Proyectos**: sin trabajo sin conexión ni tiempo real; cada guardado envía el documento entero (límite de 5 MB) y la lista incluye todos los diagramas, pensado para carpetas pequeñas o medianas ([proyectos.md](proyectos.md)).
- **Importadores**: lo que no se mapea se avisa, no se importa (capas y formas ocultas en `.drawio`, despliegue y vistas `dynamic` en el DSL de Structurizr, `.drawio.svg` y `.drawio.png`…) ([importadores.md](importadores.md)).
- **Módulos**: al importar DDL o dbt no se deduce nada de gobierno (solo lo que declare el `meta` de dbt), y los importadores de plataforma no escriben `counterpartOf` porque nada en esos formatos dice qué recurso es el equivalente de otro entorno ([datos.md](modulos/datos.md), [plataforma.md](modulos/plataforma.md)).
