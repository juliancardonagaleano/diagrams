# Módulo de plataforma

[← Índice de la documentación](../indice.md)

Quinta especialidad de la suite (`--module platform`): modela **dónde corre cada cosa y cómo llega hasta ahí**: entornos, redes, recursos aprovisionados, servicios, despliegues, dependencias y pipelines. Vive en `packages/domain-platform`, sin depender del código de los demás módulos; se enlaza con ellos por URN (`urn:iark:integration:<id>`).

Documento JSON (ejemplo completo en [`examples/plataforma-ejemplo.json`](../../examples/plataforma-ejemplo.json), esquema con `iark schema --module platform`):

| Parte | Contenido |
|---|---|
| `environments` | `dev`, `test`, `staging`, `prod` o `dr`, con `provider` y `region` |
| `networks` | redes de un entorno, anidables (`parentId`), con `exposure` (`public`, `private`, `isolated`) y `cidr` |
| `resources` | recursos de un entorno y, si procede, de una red: `cluster` y `vm` (los únicos **anfitriones**), `database`, `cache`, `queue`, `storage`, `load-balancer`, `gateway`, `dns`, `secret-store`, `registry`; con `status` (`planned`, `provisioned`, `decommissioned`), `iac` y `counterpartOf` (su equivalente en otro entorno, ver [Equivalencias entre entornos](#equivalencias-entre-entornos-counterpartof)) |
| `services` | `service`, `worker`, `job` o `frontend`, con `owner`, `criticality` y `external` (SaaS de terceros: no se despliega) |
| `deployments` | dónde corre un servicio en un entorno: `hostId` (un clúster o una máquina **de ese entorno**), `replicas` y `version` |
| `dependencies` | de quién depende un servicio o un recurso: `calls` (síncrona), `messages` (asíncrona) o `data`, con `protocol` |
| `pipelines` | `ci`, `cd`, `ci-cd` o `iac`: los servicios que construyen o despliegan, los recursos que aprovisionan y los entornos por los que promocionan (`stages`, con `approval` manual) |

No se guardan coordenadas: las vistas se derivan del modelo. `topology` es el grafo de servicios y recursos con sus dependencias, `env:<id>` el **despliegue de un entorno** (las redes y los clústeres son recuadros anidados que contienen los recursos y las instancias de cada servicio, con sus réplicas y versión) y `delivery` la **entrega continua** (pipelines con sus pasos por entorno). El impacto de un servicio o recurso se pide por su id: `impact:<id>` (lo que depende de él), `depends:<id>` (de qué depende) y `focus:<id>` (ambos); un recurso, o un servicio que corre en un solo entorno, se acota a ese entorno.

`validate` comprueba la estructura (ids únicos entre tipos, redes sin ciclos, despliegues en un clúster o máquina del mismo entorno, referencias, equivalencias entre entornos) y aplica reglas de **gobierno**: servicios sin despliegue o sin responsable (aviso si son altos o críticos), producción sin pasar por un entorno anterior, dependencias de recursos previstos o dados de baja, de servicios que no corren en el mismo entorno o de recursos de otro entorno, tipos de recurso (base de datos, cola…) que un servicio usa en un entorno y no en otro, datos o secretos en una red pública, producción sin infraestructura como código, puntos únicos de fallo (una réplica de un servicio crítico), clústeres vacíos y recursos que nadie usa, llamadas circulares y pipelines sin aprobación manual en producción, sin servicios o que despliegan donde el servicio no corre.

```bash
iark validate  plataforma.json --module platform
iark convert   plataforma.json --module platform --out topologia.svg                   # topología; también .mmd y .drawio (una página por vista)
iark convert   plataforma.json --module platform --out produccion.svg --view env:prod
iark convert   plataforma.json --module platform --out entrega.svg --view delivery
iark convert   plataforma.json --module platform --out impacto.svg --view impact:kafka-prod
iark import    produccion.mmd --module platform --out plataforma.json                  # flowchart → documento
iark import    main.tf        --module platform --out plataforma.json                  # Terraform (.tf, .tf.json, estado o plan) → documento
iark import    infra/         --module platform --format terraform --out plataforma.json   # todos los *.tf de una carpeta (o varios archivos .tf) como un solo stack
iark import    despliegue.yaml --module platform --format kubernetes --out plataforma.json   # manifiestos de Kubernetes → documento
iark generate  "Tienda con Kubernetes, PostgreSQL y Kafka en desarrollo y producción" --module platform --json plataforma.json
iark platform deployments plataforma.json                                              # dónde corre cada servicio en cada entorno y qué versiones difieren
iark platform compare     dev prod plataforma.json                                     # compara dos entornos: lo que solo está en uno y las versiones o réplicas que difieren; dice cómo emparejó cada recurso si no fue por nombre (o si lo declara el recurso: counterpartOf)
iark platform impact      kafka-prod plataforma.json [--direction dependencies|both] [--env prod]   # qué se cae si falla, con los responsables a avisar
iark platform from-integration mapa.json                                               # sistemas de un mapa de integración → servicios y recursos con URN
```

Al importar un `flowchart`, los `subgraph` con el prefijo que pone el exportador se reconocen como `Entorno: …`, `Red pública|privada|aislada: … (cidr)` y `Clúster: …` / `Máquina virtual: …`; un servicio dentro de un clúster queda desplegado en él (con `3 réplicas · v1.4.2` al final del texto) y los servicios con el mismo nombre en varios entornos son uno solo con varios despliegues. El tipo de cada nodo sale de su clase (`:::database`, `:::worker`, `:::external`; también en español) y, si no, de su forma (`[( )]` = base de datos, `([ ])` = cola); `class X planned|decommissioned` da el estado del recurso. Las flechas son dependencias: continua = llama, punteada = mensajes, gruesa = datos, con la etiqueta `protocolo · descripción`. Los pasos de la vista de entrega continua no se importan. El banco de trabajo (`modulos.html?module=platform`) lo edita en un lienzo propio, con paleta de figuras, panel de propiedades, deshacer/rehacer y autolayout (ver [Suite web](../suite-web.md)).

**Importar Terraform y Kubernetes** (`--format terraform|kubernetes|auto`; también en la pestaña «Importar» y con «Abrir archivo…», que reconoce por su contenido un `.tf.json` o un plan JSON). Terraform acepta `.tf` (HCL con un analizador propio y tolerante), `.tf.json`, el estado `.tfstate` v4 y `terraform show -json` (en un plan, los recursos salen como previstos o retirados), de las familias `aws`, `azurerm` y `google`. El entorno sale de `var.environment`, los locals, las etiquetas, el workspace o el nombre del archivo (con aviso cuando se deduce de este último); las VPC, VNet y subredes son redes anidadas con su CIDR, públicas si algo lo dice (IP pública al lanzar, ruta a un internet gateway, etiqueta de balanceador público, nombre «public» o «dmz») y privadas con aviso si nada lo dice; los clústeres, máquinas y demás recursos van a su clase (`iac: true`); las referencias, `depends_on`, grupos de seguridad (con puerto), listeners y DNS son dependencias. Kubernetes acepta YAML multidocumento, `kind: List` de `kubectl` y JSON: un namespace con nombre de entorno es un entorno (si no, hay uno solo, con aviso y con un clúster implícito); Deployment, StatefulSet, DaemonSet, CronJob y Job son servicios con su despliegue (réplicas, versión de la imagen, límites sumados; el HPA fija las réplicas mínimas), las cargas con imagen conocida (postgres, redis, rabbitmq, kafka, minio…) son recursos, Ingress, Gateway API y Service `LoadBalancer` son recursos en una red pública, y del Secret solo se guardan el tipo y los nombres de clave, **nunca los valores**; las variables de entorno (también desde ConfigMap), los `args`, los selectores y los volúmenes son dependencias. Los valores del estado o del plan de Terraform (contraseñas, claves) tampoco se leen. Lo que no se mapea (tipos desconocidos, recursos de soporte como IAM y rutas, `data`, módulos sin resolver, `count`/`for_each` sin evaluar, líneas de HCL que no se entienden con su número, kinds sin mapear, hosts externos…) va agrupado a los avisos. Un archivo roto termina con el código 2 y su línea. **Varios `.tf`**: `iark import <carpeta|a.tf b.tf…> --module platform --format terraform` los lee juntos como un solo stack (la carpeta no es recursiva; se ordenan por nombre, así que el resultado no depende del orden de los argumentos; los `.tf.json` y `.tfstate` no se juntan, avisa de ellos), y «Abrir archivo a importar…» del banco admite selección múltiple; los avisos y errores de HCL llevan el archivo (`red.tf, línea 12: …`). Limitaciones: los módulos locales no se resuelven y un archivo subido en el navegador solo trae el nombre base, así que un `main.tf` da un sistema llamado `main`.


## Equivalencias entre entornos (`counterpartOf`)

«Comparar entornos» (`compare:<A>:<B>`, la matriz `compare:all` e `iark platform compare`) empareja los recursos de dos entornos por deducción: nombre, nombre sin el sufijo del entorno («Kafka (dev)» y «Kafka (prod)»), tecnología si es inequívoca y clase si no suele repetirse. Cuando el nombre no delata la correspondencia («Almacén de pedidos» en preproducción y «Pedidos» en producción) la deducción no la ve y el par sale como «solo en A» y «solo en B»; para eso un recurso puede declarar cuál es su equivalente en otro entorno con el campo opcional `counterpartOf` (el id de ese recurso):

```json
{ "id": "pedidos-db-stg", "name": "Almacén de pedidos", "kind": "database", "environmentId": "stg", "technology": "PostgreSQL", "version": "14" },
{ "id": "pedidos-db-prod", "name": "Pedidos", "kind": "database", "environmentId": "prod", "technology": "Aurora", "version": "15", "counterpartOf": "pedidos-db-stg" }
```

- **Manda sobre la deducción**: lo declarado se empareja primero, sea cual sea el nombre, la tecnología o la clase (una máquina de desarrollo puede ser la equivalente de un clúster de producción), y el par se explica como «emparejado por equivalencia declarada» (en el lienzo, en la etiqueta de la línea; en el informe, una sección «Recursos emparejados por equivalencia declarada» con los de nombre distinto y la anotación en las diferencias de versión; en la matriz, en la celda). Un recurso cuyo equivalente declarado está dado de baja se queda sin pareja: no se le busca otro por deducción.
- **Basta que lo declare uno de los dos**, y la equivalencia es **simétrica y transitiva**: si staging declara que su base es la de desarrollo y producción declara que la suya es la de staging, las tres son el mismo recurso y desarrollo se compara con producción sin más. En la matriz de varios entornos cada equivalencia es una fila, aunque la referencia no la tenga.
- **Validación**: `validate` rechaza (código de salida 2) un equivalente que no existe, que no es un recurso, que es el propio recurso o que está en el mismo entorno, y una equivalencia **ambigua**: dos recursos vivos de un mismo entorno que resultan equivalentes al mismo de otro (los dados de baja no cuentan, así que el sucesor de un recurso retirado puede declarar lo mismo que él). Avisa de un equivalente de otra clase (salvo máquina ↔ clúster) y de uno dado de baja.
- **Lienzo**: el panel de propiedades de un recurso trae «Equivalente en otro entorno» (los recursos de los demás entornos, los de su clase primero; la pista del selector dice quién declara a este recurso como suyo) y no deja elegir uno que rompa o vuelva ambigua la equivalencia. **Duplicar entorno** declara cada copia equivalente de su original (comparar la copia con su origen los empareja uno a uno aunque luego se renombren); **quitar** un recurso o un entorno re-engancha la cadena (el que declaraba al quitado pasa a declarar el que este declaraba) en vez de dejarla colgando; **promover** un servicio re-apunta sus dependencias al equivalente declarado.
- **IA**: `generate` puede escribir `counterpartOf` cuando el nombre no delata la correspondencia y lo conserva al refinar con `--from`. Los importadores (Terraform, Kubernetes, Mermaid) no lo escriben: nada en esos formatos dice qué recurso es el equivalente de otro entorno y no se adivina (la comparación ya empareja por nombre lo que se puede deducir).

## Iconografía de nubes (AWS, Azure y paquetes propios)

Un recurso, un servicio o una red puede decir de qué proveedor es con dos campos opcionales: `provider` (`aws`, `azure`, `gcp`…) y `service` (la clave del servicio en el paquete de iconos de ese proveedor: `rds`, `sql-database`…). Se dibuja entonces con el icono de ese servicio, una **ficha blanca con el color de acento del proveedor** (AWS naranja, Azure azul) sobre la esquina del nodo, y en la esquina superior derecha de las zonas (un clúster que aloja servicios, una VPC). Se ve igual en el lienzo, en el SVG y en el `.drawio` (donde la ficha es una celda de imagen aparte junto a su nodo); Mermaid no tiene imágenes por nodo y no cambia. Si se indica el proveedor y no el servicio, se **sugiere** el que encaje con la clase y la tecnología del recurso, pero solo si es inequívoco (`database` + `PostgreSQL` en AWS → `rds`; una cola de AWS, que puede ser SQS o SNS, no se adivina). Los elementos sin proveedor se dibujan como siempre.

```json
{ "id": "pedidos-db", "name": "Pedidos DB", "kind": "database", "environmentId": "prod", "technology": "PostgreSQL", "provider": "aws", "service": "rds" }
```

| Proveedor | Servicios incluidos (clave) |
|---|---|
| `aws` | `ec2`, `eks`, `ecs`, `fargate`, `lambda`, `s3`, `rds`, `dynamodb`, `elasticache`, `sqs`, `sns`, `elb`, `alb`, `api-gateway`, `route53`, `cloudfront`, `secrets-manager`, `ecr`, `vpc` |
| `azure` | `vm`, `aks`, `app-service`, `functions`, `blob-storage`, `sql-database`, `cosmos-db`, `cache-redis`, `service-bus`, `load-balancer`, `application-gateway`, `api-management`, `dns`, `key-vault`, `container-registry`, `virtual-network` |

En el lienzo, el panel de propiedades de un recurso, un servicio o una red trae el selector **Proveedor de nube** y, debajo, **Servicio de nube** con la lista de servicios del paquete (marca el sugerido); elegir un proveedor propone el servicio y cambiarlo quita el que el nuevo no tiene. `iark platform icons plataforma.json` lista los paquetes disponibles y el icono que se dibuja para cada elemento con proveedor, y `validate` avisa de un proveedor sin paquete o de un servicio que su paquete no tiene.

**Los glifos incluidos son dibujos propios, sencillos, hechos para este proyecto: no son los logotipos oficiales de AWS ni de Azure**, que son marcas propietarias y no se redistribuyen aquí. Quien tenga licencia para usar los iconos oficiales (o quiera los de su empresa) puede **sustituirlos** con un paquete propio: los paquetes del mismo `provider` se superponen servicio a servicio y gana el último, de modo que un paquete `provider: "aws"` con solo los `rds` y `s3` oficiales reemplaza esos dos y deja el resto, sin tocar el documento. Lo que el paquete nuevo no diga de para qué clases (`kinds`) y tecnologías (`keywords`) sirve cada servicio lo hereda del que sustituye.

**Extender a otros proveedores (GCP, OCI, on-prem…)**: un paquete es un objeto `{ id, name, provider, color, icons }` donde cada servicio es `{ label, paths, kinds?, keywords? }` y `paths` son trazados SVG (`M`, `L`, `C`, `A`, `Z`…) en una caja de 16 × 16, solo trazos, que se pintan con el color del paquete. Se puede definir de tres formas:

- **En el documento**: el campo opcional `workspace.iconPacks` (lo ve el CLI, el lienzo y cualquier exportador). Ver [`examples/plataforma-nubes.json`](../../examples/plataforma-nubes.json), que dibuja AWS, Azure y un paquete propio de GCP.
- **Desde un archivo**: el mismo JSON en un `.json` suelto (su esquema es `schema/platform-icon-pack.schema.json`). `iark platform icons plataforma.json --pack gcp.json` lo valida y lo suma a la lista de esa ejecución; para exportar con él, cópialo a `workspace.iconPacks`. Con `parseIconPack(texto)` se lee desde código.
- **Desde código**: `registerIconPack(pack)` (de `@iark/domain-platform`) lo registra para todos los documentos de la aplicación; `unregisterIconPack(id)` lo quita.

Un paquete solo admite datos de trazado (comandos SVG y números), colores `#rgb`/`#rrggbb` y claves de letras, números, `.`, `_` y `-`: se rechaza cualquier otra cosa para que un paquete cargado de un archivo no pueda colar marcado en el SVG o el `.drawio`.
