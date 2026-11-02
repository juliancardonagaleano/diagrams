# 007 · Microfrontends

[← Índice de la documentación](../../indice.md) · [Protocolo](../protocolo-sdd.md) · [As-is](../as-is.md) · [Spec 001](001-to-be-c4.md) · [Plan](../plan-implementacion.md)

## id

`007-microfrontends`

## estado

`borrador`

Esta sesión lo deja en `borrador`. No pasa a `aceptada`, `en curso` ni `hecha`.

## problema

Las seis especialidades se editan dentro del banco (`banco`, `src/modules-app`, página `modulos.html`) y la traza en otra página (`traza-ui`, `trazabilidad.html`). El shell del as-is (`shell`, `src/shell`) solo monta otra instancia si la dirección trae `/?manifest=`. El corte deja un shell SPA que compone remotos, y esos remotos todavía no existen. El manifiesto del producto es `iark.manifest/1` (`packages/kernel/src/module/manifest.ts`). No hay un contrato escrito de slot, y el SDK del anfitrión no es uno de esos remotos.

## alcance

- Fijar los remotos `mfe-c4`, `mfe-integration`, `mfe-data`, `mfe-enterprise`, `mfe-platform`, `mfe-security` y `mfe-trace` con el estilo `frontend-mfe-remote`.
- Dejar que el shell SPA de la [spec 006](006-diagrams-shell.md) los componga, sin cambiar el estilo de ese shell.
- Fijar el contrato: manifiesto, URN, documento, contexto de proyecto y API del slot.
- Dejar el SDK como librería del anfitrión.
- Dejar el orden de la implementación: primero el contrato y el manifiesto, luego un remoto por especialidad, y `mfe-trace` al final. Sigue siendo una sola PR de implementación cuando la spec esté `aceptada`.
- Dejar esta spec en `borrador`.

## fuera de alcance

- Cambiar el estilo de `diagrams-shell` a `frontend-mfe-shell`. Ese contenedor sigue en `frontend-spa`. La card del shell se cita aquí como contrato de composición.
- Convertir `@iark/domain-*` o `@iark/kernel` en remotos. Siguen siendo librería. El gateway los ejecuta ([spec 002](002-diagrams-gateway.md)).
- Convertir el SDK en remoto. `embed-c4`, `embed-modulo`, `web-component` y `protocolo` se quedan en la página del anfitrión (`anfitrion`).
- Adoptar el manifiesto de Factoría (`libs/config/microfrontends.json`, Webpack, ADR-004) o `federation.manifest.json` de Angular como manifiesto del producto.
- Portar los remotos a Angular. La convención Angular es la materialización que la 001 ya apartó.
- Un proceso `diagrams-trace`. La traza URN de cálculo sigue en el gateway. `mfe-trace` es la superficie.
- Reabrir las rutas del shell (spec 006) o el contrato HTTP de módulos.
- Código de producto y los JSON de modelo en la PR de este borrador.

## elementos del as-is que toca

Ids de [`examples/diagrams-as-is.json`](../../../examples/diagrams-as-is.json). El archivo no se edita.

`shell`, `banco`, `traza-ui`, `urn`, `sdk`, `embed-c4`, `embed-modulo`, `web-component`, `protocolo`, `mod-c4`, `mod-integration`, `mod-data`, `mod-enterprise`, `mod-platform`, `mod-security`.

`mod-*` nombran la especialidad cuyo UI sale del banco. El paquete sigue siendo librería del núcleo. `sdk` y sus tres entradas se nombran para dejarlos fuera del conjunto de remotos.

## capacidades ECE que aplican

Citas de la [spec 001](001-to-be-c4.md). Esta sesión no repitió la llamada.

| Para qué | Herramienta | `entity_id` o referencia | `path` |
|---|---|---|---|
| Estilo de cada `mfe-*` | `read_document` | `frontend-mfe-remote` | `corpus/software/arquitectura-referencia/frontend-mfe-remote.md` |
| Contrato con el que el SPA compone, sin ser su estilo | `read_document` | `frontend-mfe-shell` | `corpus/software/arquitectura-referencia/frontend-mfe-shell.md` |
| Cada remoto expone rutas, no componentes sueltos | `read_document` | `convencion-frontend-angular-mfe-structure` | `corpus/frontend-angular/convencion/convencion-frontend-angular-mfe-structure.md` |
| Manifiesto Angular que no es el del producto | `read_document` | ADR-004, título que devolvió la llamada: `ADR-004: Module Federation for Micro-Frontends` | `Factoria-Ang/.cloud/architecture/decisions/ADR-004-module-federation.md` |
| El shell que compone sigue siendo SPA | `read_document` | `frontend-spa` | `corpus/software/arquitectura-referencia/frontend-spa.md` |
| C4 antes de código | `read_document` | `principio-arquitectura-arquitectura-primero` | `corpus/arquitectura/principio/principio-arquitectura-arquitectura-primero.md` |

La card del remoto, texto de la 001: «El conjunto de rutas que la capacidad remota expone es su único punto de acoplamiento hacia afuera» y «Una capacidad remota nunca depende de quien la compone, y nunca depende directamente de otra capacidad remota». La relectura añadió: «Nunca depende de quien la compone ni de otra capacidad remota de la misma composición.»

La card del shell, como contrato y no como estilo del contenedor: «descubre y monta capacidades remotas en tiempo de ejecución». El descubrimiento «ocurre por un manifiesto configurable por entorno, nunca por referencias fijas en el código». «Es dueña del árbol raíz de navegación». «El único acoplamiento permitido del Shell hacia una capacidad remota es el contrato de rutas que esa capacidad expone» y el shell la monta «sin conocer ni reescribir el interior de esa capacidad». «Existe exactamente un Shell por composición.»

`convencion-frontend-angular-mfe-structure` dice que shell y remote se organizan por dentro como la SPA feature-based y que la federación es una capa de composición. Cada remoto expone rutas, no componentes sueltos. Esa convención no sustituye a `iark.manifest/1`.

## decisión

Hay un solo shell, el de la spec 006, y siete remotos. El shell los compone. Su estilo no cambia: sigue `frontend-spa`. El estilo de cada remoto es `frontend-mfe-remote`.

| Remoto | Especialidad as-is | UI que hoy la muestra |
|---|---|---|
| `mfe-c4` | `mod-c4` | el slot, y el feature `classic-editor` sigue en el shell |
| `mfe-integration` | `mod-integration` | `banco` |
| `mfe-data` | `mod-data` | `banco` |
| `mfe-enterprise` | `mod-enterprise` | `banco` |
| `mfe-platform` | `mod-platform` | `banco` |
| `mfe-security` | `mod-security` | `banco` |
| `mfe-trace` | `urn`, superficie `traza-ui` | `src/trace-app` |

`mfe-c4` es el editor de la especialidad en el slot. No absorbe `classic-editor`: ese feature sigue en el shell, como los dos editores de C4 siguen en el producto. Un módulo no importa a otro. El enlace entre especialidades sigue siendo la URN. Un remoto no importa otro remoto ni importa al shell.

El paquete `@iark/domain-*` no se convierte en el remoto. El cálculo (validate, views, export, import, diff, run, trace) lo sigue ejecutando el gateway. El remoto puede llamar a esa API. Si una parte del editor sigue empaquetada en el remoto, no por eso nace un segundo núcleo ni un proceso `diagrams-trace`.

### Contrato

Cinco piezas. Las tres primeras ya existen. Las dos últimas las escribe la PR de implementación antes de publicar el primer remoto, como módulo tipado del repo, con una prueba. Este borrador no inventa firmas que el código no tiene.

1. **Manifiesto.** Sigue siendo `iark.manifest/1`, servido en `GET /.well-known/iark.json` y validado por `manifestSchema` (`packages/kernel/src/module/manifest.ts`). Hoy un módulo anuncia `endpoints.embed`, `endpoints.api` y `endpoints.schema`, y la instancia puede anunciar `projects`, `projectsAuth` y `projectsEvents`. El shell descubre el remoto por ese manifiesto, nunca por un import fijo al código del remoto. `suiteManifest` (`src/cli/suiteManifest.ts`) hoy apunta `embed` a `../` o a `../modulos.html?module=`. La PR hace que `embed` (o el campo que el versionado permita añadir) apunte a la ruta que el remoto expone. Si hace falta un campo nuevo, entra por [versionado-documentos.md](../../versionado-documentos.md): sube la versión del manifiesto, con migración, y no se llama `microfrontends.json` ni `federation.manifest.json`. El ADR-004 de Factoría no es este contrato.

2. **URN.** `urn:iark:<módulo>:<id>` (`urn`, `packages/kernel/src/module/urn.ts`). Es el único enlace entre remotos. Un remoto no importa el código de otra especialidad para resolverla.

3. **Documento.** El documento JSON del módulo, con su `documentVersion`. El remoto no inventa un formato privado. El núcleo sigue sin exigir coordenadas.

4. **Contexto de proyecto.** El shell entrega el proyecto y el diagrama que el usuario tiene abiertos: identificador de proyecto, identificador de diagrama, módulo y texto. La fuente es project-repository (`proyectos-web`) y, si el manifiesto trae `projects`, la API de `diagrams-app`. El remoto no abre el almacén ni IndexedDB por su cuenta.

5. **API del slot.** El lienzo es del shell (Shared de la spec 006). El remoto pinta dentro del slot. El shell no reescribe el interior del remoto. La API cruza el documento del módulo, la vista activa y el hecho de montar o desmontar. La firma concreta la fija el primer commit de la PR de implementación, con prueba, antes de que exista `mfe-c4`. No se copia aquí un nombre de función que el repo no tiene.

Cada remoto expone rutas. El shell monta esas rutas en su árbol (`/modules/:moduleId` para las especialidades, `/trace` para `mfe-trace`) y no importa un componente suelto del remoto.

El SDK queda fuera. `createIarkEmbed`, `createIarkModuleEmbed` y `<iark-module>` siguen abriendo un iframe del shell y hablando `postMessage`. No se publican como `mfe-*`. El anfitrión no pasa a depender de un remoto.

### Orden dentro de la única PR de implementación

La spec es una. La PR de implementación también es una, cuando el estado sea `aceptada`. Los commits de esa PR van en este orden y no se reordenan:

1. El contrato y el manifiesto, con la prueba del slot y del manifiesto. Aún sin un remoto nuevo.
2. Un remoto por especialidad, en el orden de la tabla, de `mfe-c4` a `mfe-security`. Cada uno sale del slot y el banco deja de importar su UI.
3. `mfe-trace` el último. `/trace` deja de montar `src/trace-app` dentro del shell y monta el remoto.

## alternativas descartadas

- Hacer de `frontend-mfe-shell` el estilo de `diagrams-shell` para poder componer. El estilo del shell ya está elegido en la 001 y en la spec 006.
- Un remote por cada paquete `@iark/*`, de modo que el núcleo deje de ser librería.
- Publicar el SDK como `mfe-sdk` o como octavo remoto.
- Tomar `ADR-004` o `federation.manifest.json` como el manifiesto `iark.manifest/1`.
- Empezar por `mfe-trace`, o montar un remoto antes de que el contrato del slot tenga prueba.
- Crear `diagrams-trace` para alojar `mfe-trace`.
- Dejar que un remoto importe `src/shell` o importe otro `mfe-*`.

## criterios de aceptación comprobables

De este borrador:

1. La línea de la sección estado es `` `borrador` ``.
2. No existe `examples/diagrams-to-be.json`. El as-is no cambia. El diff no toca `src/`, `packages/`, `schema/`, `public/`, pruebas ni `deploy/`.
3. Las capacidades citan `frontend-mfe-remote` con `read_document` y el `path` de la spec 001, y citan el path de ADR-004 como lo que no es el contrato.
4. La decisión nombra los siete remotos, las cinco piezas del contrato y el orden contrato → especialidades → traza. Dice que el SDK no es un remoto y que el shell sigue en `frontend-spa`.
5. Los ids citados están en `examples/diagrams-as-is.json`.

De la implementación, solo con la spec `aceptada` y en su única PR:

1. El primer commit que añade un remoto llega después del commit que añade la prueba del contrato de slot y del manifiesto.
2. El commit de `mfe-trace` es el último de esa serie.
3. Ningún remoto importa el shell ni otro remoto. El manifiesto que el shell lee sigue aceptando `iark.manifest/1` para una instancia que aún no anuncia remotos.
4. No existe un paquete ni un proceso llamado `diagrams-trace`. `POST /api/trace` sigue en el gateway.
5. `npm run cli -- validate examples/diagrams-as-is.json` sigue en 59 elementos, 112 relaciones, 7 vistas y 0 avisos, salvo corrección factual de otra spec aceptada. Si el manifiesto cambia de versión, `npm run manifest` queda regenerado y la prueba de `tests/manifest.test.ts` pasa.
6. Pasan `tests/manifest.test.ts`, `src/shell/manifest.test.ts`, `packages/kernel/src/module/endpoint.test.ts` y las e2e de cada especialidad que la PR toque (`tests/e2e/modules.spec.ts`, `tests/e2e/c4-lienzo-comun.spec.ts`, `tests/e2e/module-canvas.spec.ts`, y `tests/e2e/trace.spec.ts` en el commit de la traza).
7. La PR deja la spec en `en curso` y la cierra en `hecha`. No mezcla la 006 ni la 002.

## verificación

Borrador, sin implementación. Las citas salen de la spec 001, incluida la lectura de ADR-004 en `Factoria-Ang/.cloud/architecture/decisions/ADR-004-module-federation.md`. Esta sesión no llamó al puente. `GetDynamicTools` con patrón `ece` no devolvió namespace. No se imprimen `ECE_MCP_API_KEY` ni `ECE_MCP_URL`.

El manifiesto vigente se contrastó con `packages/kernel/src/module/manifest.ts` (`MANIFEST_SCHEMA_ID` reexportado, campos `endpoints`, `projects`, `projectsEvents`) y con `src/cli/suiteManifest.ts`. No se regeneró el manifiesto.

```text
npm run cli -- validate examples/diagrams-as-is.json
Documento válido: 59 elementos, 112 relaciones, 7 vistas. 0 error(es), 0 aviso(s).
```

`examples/diagrams-to-be.json` no está. `git diff --stat -- src packages schema public examples` no imprime nada.

## riesgos

- Componer remotos desde un shell cuyo estilo es `frontend-spa`. La card llama a ese estilo standalone. El marco pide una sola elección. Los remotos llevan `frontend-mfe-remote` por la orden de Julian, y el shell no gana un segundo estilo. Se vigila que la PR de esta spec no cambie la línea de estilo de la spec 006.
- Inventar un campo de manifiesto y romper a quien ya lee `iark.manifest/1`. Por eso una instancia vieja tiene que seguir validando, y un campo nuevo pasa por el versionado.
- Duplicar el núcleo dentro de cada remoto y volver a calcular la traza en un proceso distinto del gateway.
- Empezar por la traza y descubrir tarde que el slot no tiene contrato.
