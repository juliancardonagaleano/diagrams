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
4. **Escalable**: una instancia gestionada con cuentas transaccionales, observabilidad y auditoría, colaboración en tiempo real, administración de cuentas e interfaz en español e inglés.

## Estado actual

| Área | Estado | Más |
|---|---|---|
| Núcleo y módulos | **Hecho**: `@iark/kernel` y seis módulos (`c4`, `integration`, `data`, `enterprise`, `platform`, `security`), cada uno con esquema, validación, vistas, IA, importadores, exportadores y editor | [historial](historial.md#fases-0-a-6-plan-aprobado-el-2026-09-29) |
| Web | **Hecho**: editor C4 clásico; banco de trabajo con lienzo propio en los seis módulos (C4 incluido, sin iframe); suite; trazabilidad | [suite-web.md](suite-web.md) |
| CLI | **Hecho**: `generate`, `explain`, `review`, `layout`, `convert`, `import`, `validate`, `schema`, `prompt`, `diff`, `trace`, `project`, `auth`, `serve` y los comandos de cada módulo | [cli.md](cli.md) |
| IA | **Hecho**: API de Anthropic, Claude en Foundry, cualquier modelo de Foundry, modo sin clave (`iark prompt`), `--from-repo`, verificación con `validate()`, topes de tokens, `explain`/`review` y evals. Probado de verdad solo con DeepSeek-V4-Pro (28-09-2026); lo nuevo, solo con servicios simulados | [ia.md](ia.md) |
| Importadores | **Hecho**: `.drawio`, Structurizr DSL, Mermaid, OpenAPI, AsyncAPI, Threat Dragon, Terraform, Kubernetes, CloudFormation, Helm, DDL de SQL, dbt, OpenLineage, ArchiMate y BPMN; cada módulo importa al menos un formato real además de Mermaid | [importadores.md](importadores.md) |
| Federación y embebido | **Hecho**: manifiesto `iark.manifest/1`, shell, SDK de anfitrión y Web Component `<iark-module>` | [embebido.md](embebido.md) |
| Trazabilidad | **Hecho** (v1 y v2): referencias por URN con tipo de enlace, `iark trace` (huérfanos, matriz y cobertura), `POST /api/trace` y vista web | [trazabilidad.md](trazabilidad.md) |
| Versionado de diagramas | **Hecho**: `iark diff`, pestaña «Versiones» e **historial de versiones** de cada diagrama guardado en un proyecto (restaurar, nombrar, comparar; carpeta, navegador y servidor) | [cli.md](cli.md#comparar-versiones-de-un-diagrama-iark-diff) · [proyectos.md](proyectos.md#historial-de-versiones) |
| Proyectos y nube | **Hecho**: carpeta de trabajo, navegador, servidor propio con tokens, inicio de sesión de GitHub, compartir proyectos, API y pantalla de administración de cuentas | [proyectos.md](proyectos.md) · [servicio.md](servicio.md) · [cuentas-github.md](cuentas-github.md) |
| Despliegue | **Hecho**: GitHub Pages automático, imagen Docker y `deploy/` con Caddy | [despliegue-pages.md](despliegue-pages.md) · [despliegue-nube.md](despliegue-nube.md) |
| Observabilidad | **Hecho** (v1, apagada por omisión): `X-Request-Id`, registro de accesos, auditoría de cambios, `/healthz`, `/readyz` y métricas de Prometheus en `iark serve` | [observabilidad.md](observabilidad.md) |
| Interfaz es/en | **En parte**: infraestructura, gestor de proyectos y sus diálogos, errores por código y encabezados traducidos; faltan los paneles y el lienzo | [desarrollo.md](desarrollo.md#internacionalización) |
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
- **C4 en el lienzo común** (**hecho en el banco de trabajo**; acción 16): C4 es un módulo más del lienzo común (`DomainModule.editor`, `packages/domain-c4/src/editor.ts`) y `modulos.html?module=c4` ya no incrusta el editor clásico: «Versiones» resalta lo añadido, modificado y quitado dentro del lienzo, y los enlaces `ref` entre diagramas, Alt+↓ y Alt+↑ funcionan como en los demás módulos. Se hizo por etapas y sin romper nada: el editor clásico de `src/app` (`index.html`, con el protocolo `postMessage` de los anfitriones externos y los proyectos) **sigue donde estaba**. **Falta**: retirarlo, cuando la [tabla de paridad](modulos/c4.md#diferencias-con-el-editor-clásico) esté toda en «sí» (hoy quedan «diferente» —las posiciones movidas no se guardan en el documento, soltar sobre un límite, Supr— y «no» —opciones de autolayout y chip de calidad, listas del panel lateral, estilo de tarjetas, cuadrícula con imán, exportaciones finas, pestaña IA—), y mover entonces las pruebas del editor clásico (`tests/e2e/*.spec.ts` de C4) a este lienzo.
- **Accesibilidad** (**hecha la auditoría y los arreglos que una herramienta automática ve; falta la prueba con personas y lectores de pantalla**; acción 10): la spec `tests/e2e/accesibilidad.spec.ts` audita con axe-core el editor clásico, el banco (seis módulos), la suite y la trazabilidad en los dos temas y pasó de 443 violaciones a 0 con dos exclusiones nominales de Semi UI; el lienzo se recorre y se edita con teclado (flechas, Mayús + flechas, Intro), tiene nombres accesibles, una lista de elementos y una forma de crear relaciones sin arrastrar; los pares de color de los temas los mide una prueba; hay `prefers-reduced-motion` y reflujo a 320 px ([accesibilidad.md](accesibilidad.md)). **Falta**: probar con un lector de pantalla real (NVDA, VoiceOver, TalkBack) y con dispositivos táctiles —nadie lo ha hecho—, revisar los casos «incompletos» de axe, el modo de alto contraste de Windows, volver a comprobar el teclado cuando entre `onlyRenderVisibleElements`, y quitar las dos exclusiones al sustituir los menús y diálogos de Semi UI. No se afirma conformidad con WCAG 2.2 AA.
- **Rendimiento** (hecho en lo medido, con pendientes; ver [rendimiento.md](rendimiento.md)): `npm run perf` mide diagramas de hasta 2000 nodos; el autolayout corre en un hilo de trabajo (el hilo principal ya no se congela), con estado «Calculando…» y «Cancelar», modo rápido de ELK desde 600 nodos y recorte de nodos fuera de pantalla desde 150; ELK sale de la carga inicial (`chunkSizeWarningLimit` baja de 2000 a 1600 kB, con un tope de 500 kB por trozo y excepciones razonadas fijado por un e2e). C4 en el lienzo común del banco de trabajo hereda todo eso (la cancelación llega hasta ELK) y su hilo principal se libera (con 1000 nodos, de 120 s a 33 s bloqueados). **Falta**: el editor clásico de C4 (`src/app/`, aún sin retirar) sigue sin «Calculando…», sin cancelar y sin recorte; `smartLayout` de C4 sigue evaluando candidatos en el hilo principal y tarda 89 s en asentar con 1000 nodos; simplificar los nodos a zoom lejano; el encuadre de diagramas enormes (zoom mínimo 0,1); medir la interacción (arrastrar, zoom) y la calidad del modo rápido.

**Puerta**: cada módulo importa formatos reales. **Cumplida** (acción 13): los seis módulos importan al menos un formato real además de Mermaid, probado con archivos de ejemplo escritos para el proyecto, con la CLI empaquetada de verdad y con el servicio. La fase sigue en curso por el resto de sus tareas (retirar el editor C4 clásico, ahora que C4 ya está en el lienzo común del banco de trabajo; accesibilidad, rendimiento y la prueba real de la IA con claves).

### Fase 4 «Escalar»

Que una instancia gestionada se pueda operar y medir.

- **Cuentas en varias máquinas**: las cuentas ya van en un almacén transaccional (SQLite, seguro con varios procesos sobre un disco local; el JSON queda como opción de un solo proceso). Falta, y es una decisión de quien aloja, el salto a réplicas en máquinas distintas (Postgres, interfaz asíncrona, estado del inicio de sesión compartido): ver [Camino a Postgres y réplicas](cuentas-github.md#camino-a-postgres-y-réplicas-una-decisión-pendiente-no-tomada).
- **Observabilidad y auditoría** *(hecho: registro de accesos, auditoría, salud y métricas en `iark serve`, ver [observabilidad.md](observabilidad.md))*. Queda lo que ese documento reconoce en «Límites»: probarlo con un Prometheus, `logrotate` y una plataforma reales, reunir los registros de varias réplicas cuando las haya, y trazas distribuidas.
- **Colaboración** *(hecho: trabajo sin conexión con los proyectos en un servidor, ver [proyectos.md](proyectos.md))*. *(hecho: avisos de cambios en tiempo real, ver [proyectos.md](proyectos.md))*. Queda: los cambios de dos personas no se mezclan (no hay edición simultánea) y el canal de avisos es de un solo proceso; abrir y listar proyectos sigue necesitando al servidor, y no hay instantáneas guardadas en el navegador.
- **Administración de cuentas** *(hecho: cuotas de uso por persona, acción 17)*: la pantalla de administración (invitar, roles, desactivar, cancelar invitaciones) y las cuotas por persona —espacio (documentos más historial de versiones), proyectos y diagramas por proyecto, con topes de la instancia (`--max-bytes`, `--max-projects`, `--max-diagrams`), cuota personal fijada por un administrador, uso visible para cada persona y en la administración, y rechazo `409 limit` sin perder datos— están hechas: [cuentas-github.md](cuentas-github.md#cuotas-de-uso). **Falta** lo que ese apartado reconoce en «Límites»: un tope duro del volumen, y que varias réplicas sobre una misma carpeta se coordinen.
- **Interfaz es/en** *(hecho en parte)*: la interfaz tiene un módulo de internacionalización propio (`src/i18n/`) con catálogos tipados en español e inglés, plurales y fechas con `Intl`, elección por `?lang=` > lo recordado > el navegador > español, selector accesible en el editor C4, el banco de trabajo y la suite, traducción de los errores del cliente HTTP por código y `lang` en los SDK de embebido. Está traducido lo que el plan pedía primero (gestor de proyectos, barra, historial, administración, avisos sin conexión y cuotas) y el encabezado y los menús del editor C4 y del banco; **falta** el resto del editor y del banco (lienzo, paneles, pestañas, inspector), la trazabilidad, los mensajes de validación de los módulos y los del servidor. Cómo funciona y la lista de lo que queda: [desarrollo.md](desarrollo.md#internacionalización).

**Puerta**: instancia gestionada operada y medida.

## Pendientes

Los pendientes menores y límites conocidos al 2026-10-08, con la fase en la que se resuelven (propuesta; se revisa al empezar cada fase).

| Área | Pendiente | Fase |
|---|---|---|
| Docker | No se ha probado un build en una máquina con red normal (sin el proxy del entorno de desarrollo); la imagen tampoco se ha probado con `--tokens` | 1 |
| Servicio | Un diagrama muy grande exportado por la API bloquea el servicio mientras se calcula la distribución (~90 s con 300 contenedores) | 1 |
| Seguridad | Un token guardado en el navegador queda expuesto a un XSS del sitio que lo use; `iark serve` no habla TLS (hace falta un proxy con https) | 1 |
| Nube gestionada | Las cuotas por persona son una estimación al guardar y una medida (con caché de 30 s) al mostrar, no un tope duro del volumen; con varias réplicas sobre la misma carpeta dos guardados simultáneos pueden pasarse del tope; un proyecto sin dueña (copiado a mano o creado con un token) solo tiene el tope de diagramas; no hay métrica del uso de cada persona (a propósito: sin etiquetas de persona) | 4 |
| Nube gestionada | El inicio de sesión recarga la página (sin ventana emergente) | 4 |
| Nube gestionada | Una sola máquina: las cuentas van en SQLite sobre un disco local (varios procesos, sí; varias máquinas, no); el estado del inicio de sesión de GitHub y los frenos de intentos viven en la memoria de cada proceso (detrás de un balanceador hace falta afinidad de sesión); las cuotas por persona se comprueban fuera de la transacción de las cuentas. El salto a Postgres es una decisión pendiente | 4 |
| Nube gestionada | El freno de intentos solo lee la última entrada de `X-Forwarded-For` (plataformas con otra cabecera, como `Fly-Client-IP`, comparten freno) | 4 |
| Nube gestionada | No se ha probado con un certificado público real ni en una plataforma concreta | 4 |
| Nube gestionada | La observabilidad no se ha probado con un Prometheus, un `logrotate` ni un Caddy reales; los registros y las métricas son de una sola instancia (sin reunir varias réplicas) y no hay trazas distribuidas; la auditoría no es a prueba de manipulación (envío a un sistema externo o `chattr +a`) ni cubre las lecturas | 4 |
| Versionado | El historial de versiones es local a cada almacén: no viaja en el archivo único (exportar, importar, copiar), cuenta para la cuota de espacio de quien posee el proyecto solo con `--accounts` (con `versionUsage`; sin cuentas no hay cuotas) y dos procesos que guarden el mismo diagrama a la vez pueden perder una versión del historial (no el diagrama) | 3 |
| C4 | El editor clásico (`index.html`) sigue vivo junto al lienzo común: dos editores que mantener hasta que la [tabla de paridad](modulos/c4.md#diferencias-con-el-editor-clásico) esté toda en «sí» | 3 |
| C4 | En el lienzo común lo que se arrastra se recuerda en el navegador, no se escribe en el documento (`view.elements[].x/y`): los exportadores recolocan con ELK lo que el documento no trae | 3 |
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
| Interfaz es/en | Sin traducir al inglés: del editor C4 la barra flotante (salvo las direcciones del autolayout), el panel lateral, el lienzo y sus textos para lectores de pantalla, el panel de problemas y los avisos de importar y exportar; del banco las pestañas y los paneles, el pie del editor, el inspector, los adjuntos y la comparación; la página de trazabilidad; las frases de `iark diff` del núcleo, los mensajes de validación de cada módulo y los del puente de embebido | 4 |
| Interfaz es/en | El servidor (`iark serve`), el CLI y la documentación siguen en español; un error del servidor que el cliente no reconoce se muestra en inglés con su código traducido y el texto original del servidor entre paréntesis. Lo que se guarda al producirse (el motivo de un cambio aparcado en la cola sin conexión) queda en el idioma de entonces | 4 |
| Interfaz es/en | La accesibilidad del selector y de la interfaz en inglés se comprobó con las pruebas de componente y de extremo a extremo, pero la auditoría con axe (`tests/e2e/accesibilidad.spec.ts`) no se pudo ejecutar en este entorno (falta `@axe-core/playwright`) y no se ha probado con un lector de pantalla en inglés | 4 |
| Proyectos | IndexedDB se puede borrar con los datos del sitio (hay *Exportar*); dos personas o pestañas sobre el mismo diagrama no se mezclan (el segundo guardado pregunta qué versión conservar) | 4 |
| Proyectos | Los cambios de otras personas se avisan por un canal del servidor (de un solo proceso; sin él, la lista se relee al volver el foco y cada 30 s), pero no hay edición simultánea; el trabajo sin conexión conserva lo escrito en el navegador, pero abrir y listar proyectos sigue necesitando al servidor | 4 |

El pendiente sobre el entorno de pruebas («el entorno de este repositorio no trae `fake-indexeddb` instalado») pasó a las [trampas conocidas](desarrollo.md#trampas-conocidas) de `docs/desarrollo.md`.

## Límites conocidos y fuera de alcance

Fuera de alcance de la v1: servidor MCP, vistas de despliegue y de código de C4, colaboración en tiempo real, importar `.drawio` o DSL de Structurizr desde el modo embebido (el anfitrión puede usar `fromDrawio` / `fromStructurizrDsl` del núcleo) y exportar a DSL de Structurizr.

La exportación SVG y PNG desde el modo embebido figuraba aquí como fuera de alcance y ya está implementada: ver [embebido.md](embebido.md).

Límites de diseño vigentes, con su explicación en cada documento:

- **Servicio**: `iark serve` solo habla HTTP, no registra accesos ni cambios salvo que se active (`--access-log`, `--audit-log`; llevan usuario e IP: [observabilidad.md](observabilidad.md)), y con `--tokens` los tokens no caducan y sus roles valen para toda la carpeta de trabajo (con `--accounts`, inicio de sesión de GitHub, hay permisos por proyecto) ([servicio.md](servicio.md)).
- **Proyectos**: avisos de cambios en tiempo real pero sin edición simultánea (el canal es de un solo proceso), y abrir o listar proyectos necesita al servidor (lo escrito sin red sí se conserva); cada guardado envía el documento entero (límite de 5 MB) y la lista incluye todos los diagramas, pensado para carpetas pequeñas o medianas ([proyectos.md](proyectos.md)).
- **Importadores**: lo que no se mapea se avisa, no se importa (capas y formas ocultas en `.drawio`, despliegue y vistas `dynamic` en el DSL de Structurizr, `.drawio.svg` y `.drawio.png`, datos y anotaciones en BPMN, `webhooks` en OpenAPI, plantillas de un chart de Helm…), y nada se lee de la red ni del disco al importar ([importadores.md](importadores.md)).
- **Módulos de terceros**: se cargan en el CLI y en `iark serve`, no en el sitio web (sin editor visual, sin entrada en el banco de trabajo ni en el shell); cargar uno ejecuta su código con los permisos del proceso y por eso solo se carga la configuración que señala quien ejecuta el comando; no se descargan ni se instalan solos y no hay recarga en caliente ([plugins.md](plugins.md)). Los paquetes `@iark/*` están listos para publicarse pero no se han publicado.
- **Módulos**: al importar DDL o dbt no se deduce nada de gobierno (solo lo que declare el `meta` de dbt), y los importadores de plataforma no escriben `counterpartOf` porque nada en esos formatos dice qué recurso es el equivalente de otro entorno ([datos.md](modulos/datos.md), [plataforma.md](modulos/plataforma.md)).
