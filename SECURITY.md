# Política de seguridad

Gracias por ayudar a mantener seguro DIAgrams. Este documento explica qué versiones reciben arreglos de seguridad, cómo informar de una vulnerabilidad y qué puedes esperar a cambio.

## Versiones soportadas

DIAgrams aún no tiene una línea de versiones estable: el paquete está en la serie `0.x`. Los arreglos de seguridad se hacen sobre:

| Versión | Soporte |
|---|---|
| Rama `master` | Sí |
| Última versión publicada (el `package.json` está en `0.1.0`) | Sí |
| Cualquier versión anterior | No: actualiza a la última |

Si usas la imagen Docker o el sitio de GitHub Pages, estás usando `master` en el momento de construirla o publicarla: reconstruye o actualiza para recibir los arreglos (ver [`docs/despliegue-nube.md`](docs/despliegue-nube.md), «Actualizar la imagen»).

## Cómo informar de una vulnerabilidad

**No abras un issue público ni una pull request con los detalles de una vulnerabilidad.** Eso la expondría antes de que exista un arreglo.

Usa los avisos de seguridad privados de GitHub:

1. Entra en <https://github.com/juliancardonagaleano/DIAgrams>.
2. Abre la pestaña **Security**.
3. Pulsa **Report a vulnerability** y rellena el formulario.

Solo las personas que mantienen el repositorio ven el aviso. Si no ves el botón, es que el repositorio todavía no tiene activados los avisos privados; abre un issue público **sin detalles técnicos** (por ejemplo, «quiero informar de un problema de seguridad, ¿por qué canal?») y se te indicará otro canal.

### Qué incluir en el aviso

Cuanto más concreto sea, más rápido se puede reproducir y arreglar:

- Qué parte de DIAgrams afecta (CLI, `iark serve`, imagen Docker, widget embebible, app web) y la versión o el commit.
- Qué ocurre y qué impacto tiene (lectura o escritura de archivos fuera de la carpeta de trabajo, saltarse la autenticación, ejecución de código en el navegador de otra persona, denegación de servicio…).
- Pasos exactos para reproducirlo: comando, petición HTTP, documento o archivo que lo dispara. Un caso mínimo es lo ideal.
- Cómo lo desplegaste: opciones de `iark serve` (`--tokens`, `--accounts`, `--workspace`, `--cors`, `--trust-proxy`), variables `IARK_*`, si hay proxy con HTTPS delante.
- Si ya tienes una propuesta de arreglo, adjúntala. No hace falta.

No incluyas secretos reales (tokens, claves de API, Client secret de GitHub). Si encontraste uno publicado, dilo, pero sin copiarlo.

## Qué esperar

Los tiempos son orientativos: el proyecto lo mantiene una persona y no promete un acuerdo de nivel de servicio.

- **Acuse de recibo**: normalmente en unos pocos días.
- **Valoración inicial** (si es reproducible y su gravedad): normalmente en un par de semanas.
- **Arreglo**: depende de la gravedad y de la complejidad; lo grave se prioriza sobre cualquier otro trabajo.
- Te mantendremos al tanto de cómo avanza y, si lo deseas, se te reconocerá en las notas de la corrección.

### Divulgación coordinada

Pedimos que no hagas pública la vulnerabilidad hasta que haya un arreglo publicado o se haya acordado una fecha. Una vez corregida, se publicará un aviso de seguridad de GitHub (con CVE si procede) y una entrada en [`CHANGELOG.md`](CHANGELOG.md) que describa el problema y la versión que lo arregla. Si el aviso queda sin respuesta durante un tiempo razonable (varias semanas), puedes escribir de nuevo en el mismo aviso antes de publicar nada.

## Qué se considera dentro de alcance

- **El CLI `iark`** (`generate`, `import`, `convert`, `project`, `diff`, `trace`, `auth`…): por ejemplo, rutas que escapan de la carpeta de trabajo, lectura de archivos que no debería leer (el escáner de `--from-repo` no debe leer `.env*`, claves ni `*.tfstate`), secretos que acaban en los avisos o en lo que se envía al modelo.
- **`iark serve` y la imagen Docker**: la autenticación (`--tokens`, `--accounts`, roles `viewer`/`editor`/`admin`), el aislamiento entre proyectos y cuentas, el inicio de sesión con GitHub (OAuth, PKCE, sesiones), la API HTTP (`/api/…`), CORS y el freno de intentos fallidos.
- **El widget embebible** (iframe y `postMessage`, SDK de anfitrión y Web Component `<iark-module>`): por ejemplo, aceptar mensajes de un origen no esperado o permitir que un documento ejecute código en la página anfitriona.
- **La app web** (editor C4, banco de trabajo de módulos, trazabilidad, shell): XSS al abrir o importar un documento, `.drawio`, DSL, Mermaid, Terraform, Kubernetes, ArchiMate, DDL o dbt manipulados; fugas de datos entre proyectos.
- **El código y las cadenas de construcción de este repositorio**: dependencias declaradas de más o de menos, workflows, `Dockerfile` y `deploy/` si introducen un riesgo por sí mismos.

## Qué queda fuera de alcance

- **Despliegues mal configurados**: un `iark serve` publicado sin proxy HTTPS (no habla TLS, está documentado), `--trust-proxy` sin proxy, tokens que se comparten o se guardan sin cuidado, volúmenes con permisos abiertos, `--cors` demasiado permisivo, un Client secret de GitHub en el repositorio. El endurecimiento del despliegue está en [`docs/despliegue-nube.md`](docs/despliegue-nube.md) y en los apartados «Servidor para varias personas» y «Servicio gestionado» del README.
- **Fallos de dependencias sin explotación en DIAgrams**: un aviso de `npm audit` sobre una librería de terceros cuyo código vulnerable DIAgrams no ejecuta o no expone. Si puedes demostrar que sí se explota a través de DIAgrams, entonces sí es relevante: incluye la prueba.
- **Los límites que la documentación ya reconoce** (por ejemplo «Límites» en el README, «Límites honestos» en la guía de despliegue: registros de accesos y de auditoría apagados por omisión (y, encendidos, con usuario y dirección IP: ver [`docs/observabilidad.md`](docs/observabilidad.md)), un token guardado en el navegador expuesto a un XSS del sitio que lo use, una sola réplica…). No cuentan como vulnerabilidad por sí solos; si encuentras una forma de aprovecharlos más allá de lo descrito, infórmalo.
- Ataques que exigen acceso previo al equipo de la víctima, a su navegador o al disco del servidor, ingeniería social, y pruebas de denegación de servicio masivas contra instancias que no son tuyas.
- Vulnerabilidades del modelo de IA, del proveedor de IA o de GitHub: se informan a ellos.

## Pruebas de seguridad responsables

Prueba solo contra instancias tuyas o con permiso. No accedas a datos de otras personas, no los modifiques ni los borres, y detente en cuanto hayas demostrado el problema.
