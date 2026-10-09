# Módulo de seguridad

[← Índice de la documentación](../indice.md)

Sexta especialidad de la suite (`--module security`; la quinta de las que pidió el plan, tras integraciones, datos, empresarial y plataforma): modela **qué hay que proteger, de quién y con qué**, con el enfoque clásico de un análisis de amenazas sobre un diagrama de flujo de datos. Vive en `packages/domain-security`, sin depender del código de los demás módulos; se enlaza con ellos por URN (`urn:iark:integration:<id>`, `urn:iark:platform:<id>`).

Documento JSON (ejemplo completo en [`examples/seguridad-ejemplo.json`](../../examples/seguridad-ejemplo.json), esquema con `iark schema --module security`):

| Parte | Contenido |
|---|---|
| `zones` | zonas de confianza, anidables (`parentId`): `untrusted`, `dmz`, `internal` (por defecto) o `restricted`; cruzar de una a otra es cruzar una **frontera de confianza** |
| `assets` | `actor` (persona), `external` (sistema de un tercero), `process` (ejecuta código) `datastore` (guarda datos), `identity` (proveedor de identidad: IdP, SSO; figura de tarjeta), `secret` (secreto, clave o certificado; rombo) o `channel` (canal de confianza VPN/mTLS/túnel; se dibuja como un nodo pequeño en cheurón dentro de una zona, con un flujo a cada lado, de modo que los flujos que lo atraviesan cruzan la frontera por él), cada uno en una zona; con `classification` (`public`, `internal`, `confidential`, `restricted`), `encryptedAtRest` (almacenes y secretos), `authentication` (identidades y canales), `rotation` (secretos), `encrypted` (canales), `owner` y `ref`. Los tipos `identity`, `secret` y `channel` y sus campos son opcionales: los documentos anteriores siguen siendo válidos |
| `flows` | datos que viajan de un activo a otro: `protocol`, `classification`, `encrypted` y `authentication` (`none`, `password`, `token`, `mtls`, `sso`); lo que no se indica, se considera desconocido |
| `threats` | amenaza clasificada con **STRIDE** (`spoofing`, `tampering`, `repudiation`, `information-disclosure`, `denial-of-service`, `elevation-of-privilege`) sobre un activo o un flujo, con `likelihood`, `impact` y `status` (`open`, `mitigated`, `accepted`); el riesgo es probabilidad (1-3) × impacto (1-4) |
| `controls` | lo que mitiga las amenazas (`authentication`, `authorization`, `encryption`, `logging`, `validation`, `network`, `rate-limit`, `backup`, `secrets`), `implemented` o `planned`; cada amenaza cita los suyos en `controlIds` |

No se guardan coordenadas. `dfd` es el **diagrama de flujo de datos** (cada zona es un recuadro del color de su nivel de confianza, anidado en su padre; la flecha es verde si el flujo va cifrado, roja discontinua si no y gris si no se sabe, y más gruesa si lleva datos sensibles; los activos con amenazas graves abiertas se marcan en rojo) y `threats` el **modelo de amenazas** (controles → amenazas → activos y flujos amenazados). Desde un activo se piden `blast:<id>` (hasta dónde llegan los datos si se compromete), `exposure:<id>` (quién puede llegar hasta él) y `focus:<id>` (ambos).

Otras tres vistas derivadas (en el lienzo, en `--view` y en SVG, Mermaid y draw.io):

- **`heatmap`, matriz de calor 3 × 4** (probabilidad × impacto): cada amenaza en su celda, con la celda coloreada por su riesgo. En el lienzo se **arrastra una amenaza a otra celda** (o sobre otra amenaza) y cambia su `likelihood` e `impact`. `heatmap:residual` (selector «Colorear por → Residual») la coloca donde queda tras los controles. **Regla del riesgo residual** (`residualOf`, no se guarda, se calcula): solo cuentan los controles `implemented` enlazados en `controlIds`; con **uno** la probabilidad baja un nivel (los controles evitan que ocurra), con **dos o más** baja además el impacto un nivel (detectan y acotan el daño); nunca por debajo de `low`. Las amenazas reducidas llevan la marca «residual ↓» (en la vista residual, borde discontinuo); una amenaza con residual alto o crítico pese a sus controles genera un aviso. La matriz residual no se arrastra.
- **`standards`, cobertura de estándares** (solo si algún control declara `standard`; `standards:<asvs|nist-800-53|iso-27001|cis>` para un catálogo): los controles agrupados por catálogo, unidos con «mitiga» a las amenazas; cada amenaza se marca como cubierta (control implementado de ese estándar), con cobertura prevista o **sin cobertura**. Las amenazas sin ningún control con estándar se avisan.
- **`surface`, superficie de ataque** (si algún flujo entra desde una zona no confiable): los activos expuestos (borde rojo, «expuesto: entrada directa»), el **radio de alcance** (saltos por los flujos de datos desde la entrada), los flujos de entrada en rojo grueso y ★ en lo que interesa proteger; se avisa de lo que se alcanza a uno o dos saltos de fuera.

`validate` comprueba la estructura (ids únicos entre tipos, zonas sin ciclos, flujos entre activos, amenazas sobre activos o flujos, controles existentes) y aplica reglas de **gobierno**: flujos que cruzan una frontera sin cifrar (aviso si tocan una zona no confiable o llevan datos sensibles), entradas a una zona más confiable sin autenticación o que saltan una zona intermedia, datos sensibles en almacenes sin cifrar en reposo o en zonas poco confiables, datos sensibles que salen a un tercero o de un almacén a un actor, clasificaciones incoherentes con los flujos, amenazas abiertas de riesgo alto o crítico, «mitigadas» sin un control implementado, riesgos críticos aceptados, categorías STRIDE que no aplican al elemento, controles sin uso y lo que cruza fronteras sin amenazas analizadas.

```bash
iark validate  seguridad.json --module security
iark convert   seguridad.json --module security --out flujos.svg                      # diagrama de flujo de datos; también .mmd y .drawio (una página por vista)
iark convert   seguridad.json --module security --out amenazas.svg --view threats
iark convert   seguridad.json --module security --out alcance.svg --view blast:pedidos
iark import    flujos.mmd --module security --out seguridad.json                       # flowchart → documento
iark generate  "Tienda con WAF, API, base de datos y pasarela de pagos" --module security --json seguridad.json
iark security risks    seguridad.json [--status open]                                  # registro de riesgos ordenado por riesgo inherente, con estado, controles y el riesgo residual que queda tras los implementados (↓ si baja)
iark security heatmap  seguridad.json [--residual]                                     # matriz de calor probabilidad × impacto: amenazas por celda y qué amenazas hay en cada una; --residual, donde quedan tras los controles
iark security stride   seguridad.json [--gaps]                                         # cobertura STRIDE: qué categorías aplican a cada activo y flujo y cuáles siguen sin analizar
iark security standards seguridad.json [--catalogo asvs]                               # cobertura de estándares: por catálogo (asvs, nist-800-53, iso-27001, cis), sus controles y las amenazas cubiertas, con cobertura prevista o sin cobertura
iark security exposure seguridad.json                                                  # superficie de ataque: entradas desde zonas no confiables y caminos hasta lo que interesa proteger
iark security from-integration mapa.json                                               # mapa de integración → activos y flujos con URN (zonas por heurística)
iark security from-platform plataforma.json [--env prod]                               # entorno de una plataforma → zonas por red, activos y flujos con URN
```

Al importar un `flowchart`, cada `subgraph` es una zona (con el prefijo `Zona no confiable|DMZ|interna|restringida: …` que pone el exportador se conoce su nivel; sin él se importa como interna y se avisa) y cada nodo, un activo cuyo tipo sale de su clase (`:::actor`, `:::external`, `:::process`, `:::datastore`; también en español) o, si no, de su forma (`[( )]` = almacén, `([ ])` = actor). Al final del texto del nodo se leen `datos confidenciales` y `cifrado en reposo` / `sin cifrar en reposo`. Las flechas son flujos: gruesa `==>` = cifrado, punteada `-.->` = sin cifrar, continua = no se sabe; la etiqueta es `protocolo · descripción · datos … · autenticación …`. Las amenazas y los controles se describen en el JSON, no en Mermaid. El banco de trabajo (`modulos.html?module=security`) lo edita en un lienzo propio, con paleta de figuras, panel de propiedades, deshacer/rehacer y autolayout (ver [Suite web](../suite-web.md)).

## Importar OWASP Threat Dragon

`--format threat-dragon|auto` (también en la pestaña «Importar» y con «Abrir archivo…»). [OWASP Threat Dragon](https://owasp.org/www-project-threat-dragon/) guarda un modelo de amenazas como un diagrama de flujo de datos con sus amenazas, que es justo el modelo de este módulo. Se lee el JSON de la versión 2 (el que guardan la aplicación de escritorio y la web); `auto` lo reconoce por su estructura (`summary` y `detail.diagrams`), así que el archivo puede llamarse como sea.

| Threat Dragon | Documento de seguridad |
|---|---|
| `summary` (título, descripción, responsable) | nombre y descripción del espacio de trabajo |
| `actor`, `process`, `store` | activo `actor`, `process`, `datastore`; `isEncrypted` de un almacén = cifrado en reposo |
| `flow` | flujo con su protocolo y `isEncrypted` → cifrado; uno bidireccional son dos flujos |
| `trust-boundary-box` | zona; el anidamiento sale de la geometría (cada elemento va a la caja más pequeña que contiene su centro) |
| `threats` de un elemento | amenaza sobre ese activo o flujo, con su categoría, estado y severidad |
| `mitigation` de una amenaza | control (uno por texto distinto) enlazado a las amenazas que lo citan |
| varios diagramas | un solo documento, con las zonas prefijadas por el título del diagrama |

Lo que Threat Dragon **no dice** y el importador decide (siempre con un aviso, para que se revise y se corrija en el documento):

- **Qué lado de una frontera es más confiable.** Lo que queda fuera de toda frontera va a una zona «Exterior» no confiable; la primera frontera es interna y las anidadas, restringidas, salvo que su nombre diga DMZ, Internet o restringida.
- **La categoría STRIDE de una amenaza de otro modelo** (LINDDUN, CIA, CIADIE…): se lleva a la más cercana y la categoría original queda en la descripción; la que no tiene equivalente se infiere por palabras y, si no, es manipulación.
- **La probabilidad.** Threat Dragon solo da la severidad: es el impacto y la probabilidad queda en la media. `Open` es abierta, `Mitigated` mitigada y `NotApplicable` aceptada (su texto es el motivo y va a la descripción, no a un control). Un control es *implementado* si su amenaza está mitigada y *previsto* si no.

Lo que **no** se importa y se avisa: el formato v1 antiguo (`diagramJson`), las fronteras de curva (una curva no delimita un área, y los flujos que la cruzan no se marcan como cruce), las notas de texto, los flujos sin los dos extremos conectados y los textos de relleno que Threat Dragon pone en una amenaza nueva.

```console
$ iark import tienda-modelo.json --module security --format threat-dragon --out seguridad.json
aviso: El modelo tiene 2 diagramas: se unen en un solo documento y sus zonas llevan el título del diagrama («Flujo de compra», «Privacidad del perfil»).
aviso: Threat Dragon no dice qué lado de una frontera es más confiable: lo que queda fuera de toda frontera va a una zona «Exterior» no confiable, la primera frontera es interna y las anidadas, restringidas (salvo que su nombre diga DMZ, Internet o restringida). Revisa la confianza de cada zona.
aviso: 3 elemento(s) quedan fuera de toda frontera: se colocan en la zona «Exterior».
aviso: 1 frontera(s) de curva (Borde de la nube) no se importan como zona: una curva no delimita un área. Los flujos que cruzan una curva no se marcan como cruce de frontera.
aviso: 1 nota(s) de texto no se importan.
aviso: 1 flujo(s) no se importan: 1 sin origen o destino conectado.
aviso: Amenazas de otros modelos (LINDDUN: 3, CIA: 1, CIADIE: 1) se llevaron a la categoría STRIDE más cercana; la categoría original queda en la descripción.
aviso: 1 amenaza(s) con categoría sin equivalente STRIDE (Distributed) se importan como manipulación.
aviso: Threat Dragon solo da la severidad de cada amenaza: se importa como impacto y la probabilidad queda en la media. Cada texto de mitigación distinto es un control (implementado si la amenaza está mitigada, previsto si no); si no hay texto, la amenaza no tiene control.
Importado "Tienda en línea" en el módulo security: 39 elementos, 9 aviso(s).
Documento del módulo security escrito en seguridad.json
$ iark validate seguridad.json --module security
…
Documento válido (módulo security). 0 error(es), 13 aviso(s), 13 nota(s).
```

Los avisos de `validate` son el análisis de gobierno del módulo sobre lo importado (flujos que cruzan una frontera sin cifrar, datos sensibles sin cifrar en reposo…): el modelo de Threat Dragon no los trae, y el módulo sí los comprueba. El archivo del ejemplo, [`tienda-modelo.json`](../../tests/fixtures/importar/threat-dragon/tienda-modelo.json), está escrito para las pruebas.
