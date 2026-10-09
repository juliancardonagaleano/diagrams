# Documentación de IArk - DIAgrams

Mapa de `docs/`. Para empezar, el [README](../README.md); para saber qué viene, la [hoja de ruta](roadmap.md).

## Usar la suite

| Documento | Qué cuenta |
|---|---|
| [cli.md](cli.md) | Referencia del CLI `iark` (todos los comandos), comparar versiones con `iark diff` y uso como biblioteca. |
| [ia.md](ia.md) | Generar y refinar diagramas con IA: proveedores (Anthropic, Claude en Foundry, cualquier modelo de Foundry), sin clave de API, dibujar desde un repositorio (`--from-repo`), privacidad y estado de las pruebas reales. |
| [importadores.md](importadores.md) | Importar y exportar: `.drawio`, DSL de Structurizr y Mermaid; tabla de los formatos de cada módulo. |
| [proyectos.md](proyectos.md) | Proyectos: carpeta de trabajo y `iark project`, API HTTP de proyectos, historial de versiones, proyectos en el navegador y guardar en un servidor propio. |
| [trazabilidad.md](trazabilidad.md) | Enlaces entre módulos por URN (`iark trace`, `trazabilidad.html`). |
| [plugins.md](plugins.md) | Módulos de terceros sin tocar el repositorio: `iark.config.json`, escribir un módulo paso a paso (ejemplo en `examples/plugin-riesgos/`), seguridad, `iark serve` y Docker, paquetes `@iark/*` y qué no hace (el sitio web no los carga). |

## Módulos (especialidades)

| Documento | Módulo (`--module`) | Qué modela |
|---|---|---|
| [modulos/c4.md](modulos/c4.md) | `c4` | Contexto, contenedores y componentes de un sistema de software: formato JSON, notación, niveles y autolayout. |
| [modulos/integracion.md](modulos/integracion.md) | `integration` | Cómo se hablan los sistemas: APIs, MCP, brokers, colas, contratos y flujos (notación EIP). |
| [modulos/datos.md](modulos/datos.md) | `data` | Dónde viven los datos, de dónde vienen y quién responde: linaje, ERD, motores y DDL, productos y glosario. |
| [modulos/empresarial.md](modulos/empresarial.md) | `enterprise` | Capacidades, procesos, aplicaciones y tecnología (un subconjunto de ArchiMate/TOGAF). |
| [modulos/plataforma.md](modulos/plataforma.md) | `platform` | Entornos, redes, recursos, servicios, despliegues y pipelines; iconografía de nubes. |
| [modulos/seguridad.md](modulos/seguridad.md) | `security` | Zonas de confianza, activos, flujos de datos, amenazas STRIDE y controles. |

## Superficies web, embebido y servicio

| Documento | Qué cuenta |
|---|---|
| [suite-web.md](suite-web.md) | Banco de trabajo, widget, trazabilidad, shell y servicio: qué es cada superficie. |
| [embebido.md](embebido.md) | Embeber en otra aplicación: iframe + `postMessage`, SDK de anfitrión, protocolo de módulos, Web Component `<iark-module>` y federación por manifiesto. |
| [servicio.md](servicio.md) | `iark serve`: rutas de la API, imagen Docker y servidor para varias personas con tokens (roles, CORS, HTTPS, límites). |
| [cuentas-github.md](cuentas-github.md) | Servicio gestionado con inicio de sesión de GitHub: flujo, quién ve qué, compartir proyectos y administrar cuentas. |
| [observabilidad.md](observabilidad.md) | Operar `iark serve`: `X-Request-Id`, registro de accesos, auditoría de cambios, `/healthz` y `/readyz`, métricas de Prometheus, rotación de registros y datos personales. |

## Despliegue

| Documento | Qué cuenta |
|---|---|
| [despliegue-pages.md](despliegue-pages.md) | El sitio estático en GitHub Pages (workflow, rama `gh-pages`, URL). |
| [despliegue-nube.md](despliegue-nube.md) | Guía paso a paso del servicio con servidor: OAuth App de GitHub, DNS, primer arranque, copias de seguridad y actualización. |
| [`deploy/`](../deploy/README.md) | Los archivos de esa guía: `docker-compose.yml` con Caddy (registros a la salida estándar y `HEALTHCHECK` en `/healthz`), `Caddyfile` y `.env.example`. |

## Desarrollo y proyecto

| Documento | Qué cuenta |
|---|---|
| [desarrollo.md](desarrollo.md) | Instalación y scripts, estructura del repositorio, pruebas, paquetes publicables (`packages:build`, `packages:check`, publicar en npm), decisiones de diseño y trampas conocidas. |
| [accesibilidad.md](accesibilidad.md) | Accesibilidad (WCAG 2.2 AA): qué se midió con axe y qué se arregló, atajos de teclado del lienzo, exclusiones nominales, lo que no se ha podido comprobar sin lector de pantalla y la lista de comprobación manual. |
| [rendimiento.md](rendimiento.md) | Diagramas grandes: cuánto tardan el autolayout y el lienzo (antes y después), qué se hizo (ELK en un hilo de trabajo, recorte de nodos fuera de pantalla, trozos de la compilación), cómo medirlo (`npm run perf`) y qué fijan las pruebas. |
| [versionado-documentos.md](versionado-documentos.md) | Cómo evoluciona un esquema sin romper lo guardado: `documentVersion` y migraciones por módulo (`iark migrate`), `contractVersion` del contrato `DomainModule` (el que cumple un [módulo de terceros](plugins.md)) y negociación de la versión del protocolo embebido y del manifiesto. |
| [roadmap.md](roadmap.md) | Visión, estado actual, pendientes reales, límites conocidos y el plan de robustecimiento en cuatro fases. |
| [historial.md](historial.md) | Lo ya hecho, por fases y por tandas, y el plan original de la suite. |
| [CONTRIBUTING.md](../CONTRIBUTING.md) · [SECURITY.md](../SECURITY.md) · [CHANGELOG.md](../CHANGELOG.md) · [LICENSE](../LICENSE) | Cómo contribuir, cómo informar de una vulnerabilidad, qué cambió en cada versión y la licencia. |

## Dónde quedó cada sección del antiguo README

El README tenía 1.294 líneas; todo su contenido se movió aquí (y el README quedó como una puerta de entrada). Si tienes un enlace a una sección vieja:

| Sección del README anterior | Ahora |
|---|---|
| Instalación · Pruebas · Estructura del proyecto · Decisiones de diseño | [desarrollo.md](desarrollo.md) (y un resumen en el [README](../README.md)) |
| Despliegue (GitHub Pages) | [despliegue-pages.md](despliegue-pages.md) |
| Formato JSON · Notación del lienzo · Niveles C1 › C2 › C3 · Autolayout inteligente · Direcciones y distribución | [modulos/c4.md](modulos/c4.md) |
| Conversión a `.drawio` · Importar un `.drawio` · Importar un DSL de Structurizr · Mermaid | [importadores.md](importadores.md) |
| Módulo de integraciones · de datos · empresarial · de plataforma · de seguridad | [integración](modulos/integracion.md), [datos](modulos/datos.md), [empresarial](modulos/empresarial.md), [plataforma](modulos/plataforma.md), [seguridad](modulos/seguridad.md) |
| Trazabilidad entre módulos | [trazabilidad.md](trazabilidad.md) |
| Proyectos (espacio de trabajo en carpeta) · API HTTP de proyectos · Historial de versiones · Proyectos en la app web · Guardar en la nube (servidor propio) desde el navegador | [proyectos.md](proyectos.md) |
| Servidor para varias personas (nube autoalojada) · Servicio HTTP (`iark serve`) · Imagen Docker | [servicio.md](servicio.md) |
| Servicio gestionado: inicio de sesión con GitHub | [cuentas-github.md](cuentas-github.md) |
| CLI `iark` · Comparar versiones (`iark diff`) · Uso programático | [cli.md](cli.md) |
| Dibujar desde un repositorio (`--from-repo`) · Generar diagramas con IA · Foundry · Sin clave de API · Prueba real de `generate` | [ia.md](ia.md) |
| Embebido en otra aplicación · Protocolo de módulos y SDK · Web Component · Federación por manifiesto | [embebido.md](embebido.md) |
| Suite web: banco de trabajo, widget, shell y servicio | [suite-web.md](suite-web.md) |
| Fuera de alcance (v1) | [roadmap.md](roadmap.md#límites-conocidos-y-fuera-de-alcance) |
