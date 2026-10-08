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
