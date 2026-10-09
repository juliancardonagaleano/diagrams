# Versionado de documentos, del contrato de módulos y del protocolo

[← Índice de la documentación](indice.md)

Lo que la gente guarda (archivos `.json` en git, borradores y proyectos en el navegador, documentos en un servidor) tiene que seguir abriéndose cuando el formato de un módulo evoluciona. Y los módulos y las instancias de terceros tienen que poder hablar con esta suite aunque no se hayan actualizado a la vez. Hay **tres versiones** distintas, cada una con su regla:

| Versión | Dónde se declara | Forma | Qué pasa si no coincide |
|---|---|---|---|
| **Del documento** | `DomainModule.documentVersion` y el campo `version` del documento | `mayor.menor` (`1.0`) | Más antigua: se migra. Más nueva: se rechaza con «actualiza IArk». |
| **Del contrato de módulos** | `DomainModule.contractVersion` | entero (`1`) | Mayor que la del anfitrión: el módulo no se carga. |
| **Del protocolo embebido** | `EMBED_PROTOCOL_VERSION` (`init`, `load` y manifiesto) | `mayor.menor` (`1.0`) | Mayor distinta: error `incompatible-protocol`. Menor distinta: se acepta. |

Las tres se comparan **numéricamente** (`1.10` es posterior a `1.9`), nunca como texto.

## La versión del documento y sus migraciones

Cada módulo declara `documentVersion` (hoy `1.0` en los seis) y, si el formato cambia, `migrations`: la cadena de pasos que lleva un documento de cada versión anterior a la actual.

```ts
export const dataModule: DomainModule<DataDocument> = {
  id: 'data',
  documentVersion: '2.0',
  migrations: [
    { from: '1.0', to: '1.1', description: 'El nombre pasa a workspace.name', migrate: (d) => /* … */ d },
    { from: '1.1', to: '2.0', description: 'label pasa a title', migrate: (d) => /* … */ d },
  ],
  // …
};
```

`migrateDocument(module, valor)` (en `@iark/kernel`) aplica la política, siempre **sin modificar la entrada**:

| El documento… | Resultado |
|---|---|
| no trae `version` | se da por actual (los esquemas la completan con su valor por defecto) |
| está en la versión actual | no cambia nada |
| es de una versión anterior con cadena | los pasos en orden, hasta la actual |
| es de una versión anterior sin cadena | «La versión X del documento no está soportada por el módulo «id» (versión actual: Y). Hay migraciones desde: …» |
| es de una versión **más nueva** | «Este documento se creó con una versión más nueva (X) del formato; el módulo «id» entiende hasta la Y. Actualiza IArk para abrirlo.» |

`analyzeValue` y `analyzeText` migran **antes** de validar con el esquema, así que todo lo que pasa por ellos hereda la migración: el banco de trabajo, el servicio HTTP (`POST /api/<módulo>/validate`…), `iark project check`, los borradores del navegador, los proyectos, «Comparar» y las exportaciones. El análisis de un documento migrado trae `migrated: { from, to }` y una incidencia informativa («Documento migrado de la versión X a Y; al guardarlo se escribe en la nueva»). El archivo o el borrador **no se reescriben solos**: se escribe la versión nueva cuando la persona guarda, o con `iark migrate`.

### Cómo evoluciona un esquema

Cuando un cambio de esquema **no es compatible** con lo ya guardado (se renombra un campo, se cambia su forma, se vuelve obligatorio uno que no lo era), en el mismo PR:

1. **Sube `documentVersion`** del módulo: `1.1` si el cambio se puede convertir sin perder nada, `2.0` si cambia el significado. Actualiza el literal de `version` del esquema y los ejemplos de `examples/`.
2. **Añade el paso en `migrations`** (`from` = la versión anterior, `to` = la nueva) con una `description` de una línea. `migrate` es una función pura sobre el JSON: recibe una copia del documento antiguo y devuelve el nuevo; el núcleo escribe `version: to`, no hace falta que el paso lo haga.
3. **Conserva la foto del documento antiguo.** `tests/fixtures/documentos/<módulo>-v1.0.json` es una copia congelada de un documento tal como lo guardaba la versión 1.0, y `tests/documentos-antiguos.test.ts` exige que cada foto siga analizándose `ok`. **No la edites ni la regeneres**: si el cambio de esquema la rompe, lo que falta es la migración. Añade además la foto de la versión nueva (`<módulo>-v2.0.json`) para que la siguiente evolución la proteja a ella también.
4. **Prueba el paso** con un documento de entrada de la versión antigua y el resultado esperado (el módulo `tests/helpers/moduloMigrable.ts` y `packages/kernel/src/module/migrate.test.ts` muestran el patrón: cadena 1.0 → 1.1 → 2.0, entrada no mutada, versión más nueva, sin versión).
5. **Si el módulo es C4**, los documentos guardados en el navegador también pasan por ahí (ver abajo).

Un cambio **compatible** (un campo opcional nuevo, un valor más en un enumerado) no necesita nada de esto: no subas la versión.

`ModuleRegistry.register` comprueba la cadena al registrar el módulo (`assertModuleContract`): cada paso sube de versión, no hay dos pasos que partan de la misma, no hay huecos ni ciclos, y la cadena termina exactamente en `documentVersion`. Un módulo con la cadena rota no se carga, con un mensaje que dice qué falla.

### Migraciones en el CLI

```bash
iark migrate antiguo.json --out nuevo.json   # reescribe en la versión actual
iark migrate --check diagrama.json           # código 1 si necesita migración, 0 si no (integración continua)
```

`validate`, `convert`, `layout`, `diff` y el resto de comandos que leen documentos migran al leer y lo avisan. Ver [CLI](cli.md#documentos-de-una-versión-anterior-del-formato-iark-migrate).

### Lo que guarda el editor C4 en el navegador

El editor C4 guarda su estado en `localStorage` (`iark-diagrams`) con el `persist` de zustand. Aquí hay **dos versiones**: la del documento C4 (las migraciones de arriba, que se aplican siempre al rehidratar) y `PERSIST_VERSION` (`src/app/store/persistMigration.ts`), la de la **forma** de lo persistido (`doc`, `activeViewId`, `ui`, `lastSavedAt`). Política: **sube `PERSIST_VERSION` cuando cambie la forma persistida** y añade el paso en `migratePersistedState`. Sin `migrate`, zustand descartaba en silencio lo guardado con otra versión; ahora se conserva, y lo que no se puede migrar (de una versión más nueva) se deja intacto en vez de borrarse.

## La versión del contrato de módulos

`DomainModule` es un contrato: lo implementan los seis módulos y, en la fase 2 del [plan](roadmap.md), lo implementarán módulos de terceros. `contractVersion` es un **entero** que declara contra qué versión de ese contrato se escribió el módulo (`CONTRACT_VERSION` en `@iark/kernel`, hoy `1`). Omitirlo equivale a `1`; los seis módulos lo declaran con `CONTRACT_VERSION`.

- Un módulo con `contractVersion` **mayor** que el del anfitrión se rechaza al registrarlo (`ModuleRegistry.register`): fue escrito para un contrato que este IArk no conoce y cargarlo a medias sería peor que no cargarlo. El mensaje dice las dos versiones.
- Uno **menor o igual** se acepta: el contrato crece de forma compatible hacia atrás (campos opcionales nuevos). Si algún día cambia de forma incompatible, `CONTRACT_VERSION` sube y los módulos antiguos dejan de cargar o necesitan un adaptador, pero con un error explícito.
- Las capacidades (`iark modules --json`, `GET /api/modules`, `init` del protocolo de módulos) y el manifiesto publican el `contractVersion` de cada módulo.

Cuándo subir `CONTRACT_VERSION`: cuando un cambio en `types.ts` obligue a tocar los módulos existentes (un campo que pasa a ser obligatorio, una función que cambia de firma). Un campo opcional nuevo no lo exige.

## El protocolo embebido

El protocolo `postMessage` (el del editor C4 y el del banco de módulos) lleva una versión `mayor.menor` (`EMBED_PROTOCOL_VERSION`, hoy `1.0`) en el `init` del iframe y en el `load` del anfitrión. `negotiateProtocol(local, remoto)` (en `@iark/kernel/protocol`) decide:

- **Misma versión mayor**: compatibles; gana la menor de las dos y lo que un lado no conoce lo ignora.
- **Mayor distinta**: incompatibles. Ambos lados emiten/rechazan con un error claro (`code: 'incompatible-protocol'`) que nombra las dos versiones y quién es el más antiguo; no se funciona a medias.
- **Un lado sin versión** (un anfitrión o iframe anteriores a esta función): cuenta como `1.0`.

Detalles del apretón de manos y de cómo lo ven el SDK y el Web Component, en [Modo embebido](embebido.md#versión-del-protocolo).

### El manifiesto de federación

El manifiesto sigue siendo `iark.manifest/1` (el literal no cambia). Se le añaden dos campos **opcionales al leer**: `protocol` (cadena `mayor.menor`, la versión del protocolo embebido de la instancia) y, en cada módulo, `contractVersion` (entero). Un manifiesto antiguo, sin ellos, vale `"1.0"` y `1`. Al conectar con una instancia remota (el shell, `<iark-module manifest=…>`):

- un esquema de versión mayor (`iark.manifest/2`) o un `protocol` de versión mayor distinta se rechazan con un mensaje que dice qué actualizar;
- un módulo con `contractVersion` mayor que el de esta suite se aparta y se explica el motivo; los demás módulos de la instancia siguen disponibles.

Regenera el manifiesto del sitio con `npm run manifest` (una prueba comprueba que no se desincroniza).

## Qué pasa con una versión más nueva

Tanto un documento como un módulo, un manifiesto o un protocolo **más nuevos** que lo que entiende esta instalación se rechazan con un mensaje que pide actualizar IArk; nunca se leen a medias ni se pierde el original (los archivos no se tocan y lo guardado en el navegador se conserva). La diferencia con lo **más antiguo**: eso sí se intenta llevar a la versión actual, con las migraciones del módulo.
