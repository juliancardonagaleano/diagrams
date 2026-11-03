var e=`{
  "version": "1.0",
  "workspace": {
    "name": "DIAgrams to-be",
    "description": "Modelo C4 to-be acordado en la spec 001: procesos diagrams-app, diagrams-gateway, diagrams-identity, diagrams-sse, shell SPA diagrams-shell, remotos mfe-* y CLI hexagonal. Sin coordenadas; ELK las calcula."
  },
  "model": {
    "elements": [
      {
        "id": "arquitecto",
        "type": "person",
        "name": "Arquitecto",
        "description": "Persona que modela en el navegador: suite, estudio, banco de trabajo y trazabilidad."
      },
      {
        "id": "operador",
        "type": "person",
        "name": "Operador",
        "description": "Persona que usa el CLI en su máquina o en CI: generar, validar, importar, convertir y versionar en git."
      },
      {
        "id": "administrador",
        "type": "person",
        "name": "Administrador",
        "description": "Persona que administra una instancia de iark serve: cuentas, roles, invitaciones y cuotas."
      },
      {
        "id": "anfitrion",
        "type": "softwareSystem",
        "name": "Aplicación anfitriona",
        "description": "Otra aplicación que embebe la suite con el SDK, el Web Component o un iframe.",
        "external": true
      },
      {
        "id": "github",
        "type": "softwareSystem",
        "name": "GitHub",
        "description": "Aloja el sitio estático en Pages y es el proveedor OAuth de las cuentas de la instancia.",
        "external": true
      },
      {
        "id": "proveedor-ia",
        "type": "softwareSystem",
        "name": "Proveedor de modelo",
        "description": "Anthropic o Foundry. Solo lo llama el CLI. El sitio y iark serve no tienen generación.",
        "external": true
      },
      {
        "id": "repositorio",
        "type": "softwareSystem",
        "name": "Repositorio de origen",
        "description": "Árbol que --from-repo lee con lista blanca. Redacta secretos antes de enviar nada al modelo.",
        "external": true
      },
      {
        "id": "proxy",
        "type": "softwareSystem",
        "name": "Proxy HTTPS",
        "description": "Opcional. iark serve solo habla HTTP; en internet va detrás de un proxy (Caddy en deploy/).",
        "external": true
      },
      {
        "id": "prometheus",
        "type": "softwareSystem",
        "name": "Prometheus",
        "description": "Opcional. Raspa /metrics. Apagado por omisión; fuera de loopback exige token.",
        "external": true
      },
      {
        "id": "diagrams",
        "type": "softwareSystem",
        "name": "DIAgrams",
        "description": "Suite de diagramación de arquitectura. Seis especialidades sobre un núcleo común, documento JSON sin coordenadas, CLI iark, sitio y servicio. Identificadores internos @iark, urn:iark y IARK_*."
      },
      {
        "id": "sdk",
        "type": "container",
        "name": "SDK de embebido",
        "description": "Biblioteca que corre en la página anfitriona. Abre un iframe del sitio y habla por postMessage. No es un proceso del servidor.",
        "technology": "TypeScript, dist/embed",
        "parentId": "diagrams"
      },
      {
        "id": "cli",
        "type": "container",
        "name": "CLI iark",
        "description": "Proceso Node en la máquina de quien modela o en CI. generate, explain, review, layout, convert, import, validate, migrate, schema, prompt, project, trace, diff. Sin clave, iark prompt entrega el encargo a otro agente.",
        "technology": "Node.js >= 22.13, commander",
        "parentId": "diagrams"
      },
      {
        "id": "nucleo",
        "type": "container",
        "name": "Núcleo y módulos",
        "description": "No escucha puertos. El mismo código se enlaza dentro del sitio, del CLI y del servicio. Un módulo no importa a otro: solo se relacionan por URN.",
        "technology": "@iark/kernel y @iark/domain-*",
        "parentId": "diagrams"
      },
      {
        "id": "proyectos",
        "type": "component",
        "name": "Almacén de proyectos (Infrastructure)",
        "description": "Carpeta de trabajo (git) o Postgres. Lo usan el CLI (iark project) y el servicio (--workspace). El navegador tiene otro almacén, dentro del sitio.",
        "technology": "Carpeta o Postgres",
        "shape": "database",
        "parentId": "diagrams-app"
      },
      {
        "id": "cuentas",
        "type": "component",
        "name": "Almacén de cuentas (Core)",
        "description": "Solo con --accounts. Personas, sesiones hasheadas, miembros y cuotas. JSON de un proceso, SQLite en un disco o Postgres entre máquinas.",
        "technology": "JSON, SQLite o Postgres",
        "shape": "database",
        "parentId": "diagrams-identity"
      },
      {
        "id": "boot",
        "type": "component",
        "name": "Enrutador de superficies",
        "description": "src/boot.ts. / abre la suite. /?editor=1 abre el estudio, no el editor clásico. El clásico queda en ?classic=1 y en el embebido.",
        "technology": "src/boot.ts",
        "parentId": "diagrams-shell"
      },
      {
        "id": "home",
        "type": "component",
        "name": "Inicio",
        "description": "src/home. Proyectos, diagramas sueltos y acceso a las seis especialidades. suite.html solo redirige aquí.",
        "technology": "src/home",
        "parentId": "diagrams-shell"
      },
      {
        "id": "studio",
        "type": "component",
        "name": "Estudio",
        "description": "src/studio. Marco del editor sobre el controlador del banco. Es lo que abre /?editor=1 y ?studio=1.",
        "technology": "React, Semi UI",
        "parentId": "diagrams-shell"
      },
      {
        "id": "editor",
        "type": "component",
        "name": "Editor C4 clásico",
        "description": "src/app. Sigue vivo para /?embed=1 y ?classic=1: protocolo postMessage histórico, proyectos y notación de tarjetas. El banco ya no lo incrusta.",
        "technology": "React, React Flow, Zustand",
        "parentId": "diagrams-shell"
      },
      {
        "id": "banco",
        "type": "component",
        "name": "Banco de trabajo",
        "description": "src/modules-app, página modulos.html. Un controlador, un lienzo y un inspector para los seis módulos, C4 incluido. Cada módulo se importa al elegirlo.",
        "technology": "React Flow, ELK",
        "parentId": "diagrams-shell"
      },
      {
        "id": "shell",
        "type": "component",
        "name": "Shell de federación",
        "description": "src/shell. Con /?manifest= lee el manifiesto de otra instancia y monta el módulo que esa instancia declara.",
        "technology": "src/shell",
        "parentId": "diagrams-shell"
      },
      {
        "id": "traza-ui",
        "type": "component",
        "name": "Trazabilidad",
        "description": "src/trace-app, página trazabilidad.html. No pasa por boot.ts. Tablero de URN en el navegador: huérfanos, matriz y cobertura.",
        "technology": "src/trace-app",
        "parentId": "diagrams-shell"
      },
      {
        "id": "proyectos-web",
        "type": "component",
        "name": "Cliente de proyectos",
        "description": "src/projects. IndexedDB en el navegador, cliente del servicio y cola de lo escrito sin red. Abrir y listar en el servidor sigue necesitando conexión.",
        "technology": "IndexedDB",
        "shape": "database",
        "parentId": "diagrams-shell"
      },
      {
        "id": "i18n",
        "type": "component",
        "name": "Internacionalización",
        "description": "src/i18n. Español e inglés en la suite, el marco y los encabezados. El lienzo, los paneles, el CLI y el servicio siguen en español.",
        "technology": "src/i18n",
        "parentId": "diagrams-shell"
      },
      {
        "id": "puente",
        "type": "component",
        "name": "Puente postMessage",
        "description": "src/embed. Protocolo del editor clásico y protocolo de módulos. Sin &origin= las respuestas salen con destino *.",
        "technology": "postMessage",
        "parentId": "diagrams-shell"
      },
      {
        "id": "embed-c4",
        "type": "component",
        "name": "createIarkEmbed",
        "description": "SDK de anfitrión del editor C4. Fija el idioma y el origen, y abre el iframe.",
        "technology": "dist/embed/iark-embed",
        "parentId": "sdk"
      },
      {
        "id": "embed-modulo",
        "type": "component",
        "name": "createIarkModuleEmbed",
        "description": "SDK de anfitrión del banco de trabajo para cualquier módulo.",
        "technology": "dist/embed",
        "parentId": "sdk"
      },
      {
        "id": "web-component",
        "type": "component",
        "name": "iark-module",
        "description": "Web Component que registra <iark-module> y embebe un módulo.",
        "technology": "custom element",
        "parentId": "sdk"
      },
      {
        "id": "protocolo",
        "type": "component",
        "name": "Protocolo de embebido",
        "description": "Mensajes y capacidades (módulos, formatos, vistas de traza). El anfitrión no conoce el interior de un módulo.",
        "technology": "postMessage",
        "parentId": "sdk"
      },
      {
        "id": "comandos",
        "type": "component",
        "name": "Intérprete de comandos",
        "description": "src/cli/main.ts. Comandos de primer nivel y el grupo iark <módulo> que aporta cada DomainModule.",
        "technology": "commander",
        "parentId": "cli"
      },
      {
        "id": "registro-cli",
        "type": "component",
        "name": "Registro de módulos",
        "description": "src/cli/registry.ts. Los seis incorporados más los de iark.config.json. Un id de plugin no puede pisar un comando ni otro módulo.",
        "technology": "ModuleRegistry",
        "parentId": "cli"
      },
      {
        "id": "ia-cli",
        "type": "component",
        "name": "Cliente de modelos",
        "description": "src/cli/ai.ts y la IA del kernel. Verifica con validate() del módulo y reintenta. El servicio HTTP no usa este cliente.",
        "technology": "Anthropic, Foundry",
        "parentId": "cli"
      },
      {
        "id": "repo-cli",
        "type": "component",
        "name": "Lector de repositorio",
        "description": "src/cli/repo. --from-repo solo lee la lista blanca y redacta secretos. --dry-run muestra el envío. No carga iark.config.json del clon.",
        "technology": "src/cli/repo",
        "parentId": "cli"
      },
      {
        "id": "workspace-cli",
        "type": "component",
        "name": "Proyectos en carpeta",
        "description": "src/cli/workspace.ts. Carpeta de trabajo pensada para git, con historial de versiones local al almacén.",
        "technology": "sistema de archivos",
        "parentId": "cli"
      },
      {
        "id": "plugins-cli",
        "type": "component",
        "name": "Cargador de plugins",
        "description": "src/cli/plugins. Carga un DomainModule de terceros desde la configuración que señala quien ejecuta el comando. Ejecuta ese código con los permisos del proceso.",
        "technology": "iark.config.json",
        "parentId": "cli"
      },
      {
        "id": "api-modulos",
        "type": "component",
        "name": "API de módulos",
        "description": "validate, views, schema, export, import, diff, run y /api/trace. No llama a un modelo.",
        "technology": "HTTP JSON",
        "parentId": "diagrams-gateway"
      },
      {
        "id": "api-proyectos",
        "type": "component",
        "name": "API de proyectos",
        "description": "CRUD de proyectos y diagramas, bundle, importación, comprobación y guardado condicional por ifUpdatedAt.",
        "technology": "HTTP JSON",
        "parentId": "diagrams-app"
      },
      {
        "id": "tokens",
        "type": "component",
        "name": "Tokens de acceso",
        "description": "src/cli/tokens.ts y serveAuth.ts. El archivo guarda hashes. El rol vale para toda la carpeta. Sin caducidad.",
        "technology": "Bearer",
        "parentId": "diagrams-identity"
      },
      {
        "id": "cuentas-gh",
        "type": "component",
        "name": "Cuentas de GitHub",
        "description": "src/cli/accounts. Login, callback, sesión, miembros, administración y cuotas. El secreto OAuth solo entra por entorno o archivo.",
        "technology": "OAuth",
        "parentId": "diagrams-identity"
      },
      {
        "id": "sse",
        "type": "component",
        "name": "Avisos en tiempo real",
        "description": "src/cli/serveEvents.ts. GET /api/events avisa de que hay una versión más nueva. Un solo proceso. No mezcla ediciones simultáneas.",
        "technology": "SSE",
        "parentId": "diagrams-sse"
      },
      {
        "id": "obs",
        "type": "component",
        "name": "Observabilidad",
        "description": "X-Request-Id, registro de accesos, auditoría, /healthz, /readyz y /metrics. Registros y métricas apagados por omisión.",
        "technology": "src/cli/observability",
        "parentId": "diagrams-app"
      },
      {
        "id": "pool",
        "type": "component",
        "name": "Piscina de cálculo",
        "description": "src/cli/computePool.ts y computeWorker.ts. validate, export, import, diff, run y trace corren en worker_threads para no bloquear el servicio.",
        "technology": "worker_threads",
        "parentId": "diagrams-gateway"
      },
      {
        "id": "cabeceras",
        "type": "component",
        "name": "Cabeceras de seguridad",
        "description": "CSP sin unsafe-eval, Referrer-Policy, Permissions-Policy, frame-ancestors y HSTS detrás del proxy.",
        "technology": "HTTP",
        "parentId": "diagrams-gateway"
      },
      {
        "id": "contrato",
        "type": "component",
        "name": "Contrato DomainModule",
        "description": "packages/kernel. Esquema, validación, vistas, importadores, exportadores, IA, editor, migraciones y contractVersion. El registro rechaza un contrato más nuevo que el anfitrión.",
        "technology": "@iark/kernel",
        "parentId": "nucleo"
      },
      {
        "id": "urn",
        "type": "component",
        "name": "URN y trazabilidad",
        "description": "urn:iark:<módulo>:<id>. Resuelve enlaces sin que un módulo importe el código de otro.",
        "technology": "@iark/kernel",
        "parentId": "nucleo"
      },
      {
        "id": "diff",
        "type": "component",
        "name": "Comparación de documentos",
        "description": "diffDocuments. Estructural. Cada módulo declara qué rutas son maquetación (coordenadas) y cuáles listas conservan orden.",
        "technology": "@iark/kernel",
        "parentId": "nucleo"
      },
      {
        "id": "proyecto-modelo",
        "type": "component",
        "name": "Modelo de proyecto",
        "description": "packages/kernel/src/project. Un proyecto agrupa diagramas de varios módulos. Guarda el id de módulo y el texto, no el tipo interno.",
        "technology": "@iark/kernel",
        "parentId": "nucleo"
      },
      {
        "id": "ia-kernel",
        "type": "component",
        "name": "IA estructurada",
        "description": "Proveedor, reintentos y JSON Schema. El modelo devuelve el documento; no devuelve coordenadas.",
        "technology": "@iark/kernel",
        "parentId": "nucleo"
      },
      {
        "id": "grafo",
        "type": "component",
        "name": "Layout de grafos",
        "description": "ELK genérico, SVG y sintaxis Mermaid del kernel. Los cinco módulos que no son C4 colocan sus vistas aquí. C4 tiene autolayout propio y usa el kernel para pintar el SVG.",
        "technology": "elkjs",
        "parentId": "nucleo"
      },
      {
        "id": "mod-c4",
        "type": "component",
        "name": "Módulo C4",
        "description": "packages/domain-c4. También es la API pública diagrams/core. Contexto, contenedores y componentes; import draw.io, Structurizr y Mermaid; autolayout con calidad.",
        "technology": "@iark/domain-c4",
        "parentId": "nucleo"
      },
      {
        "id": "mod-integration",
        "type": "component",
        "name": "Módulo de integración",
        "description": "APIs, MCP, brokers, colas, contratos y flujos EIP. Importa OpenAPI y AsyncAPI.",
        "technology": "@iark/domain-integration",
        "parentId": "nucleo"
      },
      {
        "id": "mod-data",
        "type": "component",
        "name": "Módulo de datos",
        "description": "Linaje, ERD, gobierno, DDL, dbt y OpenLineage.",
        "technology": "@iark/domain-data",
        "parentId": "nucleo"
      },
      {
        "id": "mod-enterprise",
        "type": "component",
        "name": "Módulo empresarial",
        "description": "Capacidades, aplicaciones y tecnología. Subconjunto de ArchiMate y TOGAF. Importa ArchiMate y BPMN.",
        "technology": "@iark/domain-enterprise",
        "parentId": "nucleo"
      },
      {
        "id": "mod-platform",
        "type": "component",
        "name": "Módulo de plataforma",
        "description": "Entornos, redes, recursos, despliegues y pipelines. Importa Terraform, Kubernetes, CloudFormation y Helm.",
        "technology": "@iark/domain-platform",
        "parentId": "nucleo"
      },
      {
        "id": "mod-security",
        "type": "component",
        "name": "Módulo de seguridad",
        "description": "Zonas de confianza, flujos, amenazas STRIDE y controles. Importa Threat Dragon.",
        "technology": "@iark/domain-security",
        "parentId": "nucleo"
      },
      {
        "id": "diagrams-shell",
        "type": "container",
        "name": "Shell SPA",
        "description": "SPA única en el navegador. Estilo frontend-spa: router en boot, features suite, studio, projects y classic-editor; compone remotos mfe-* por manifiesto. Se publica en GitHub Pages o CDN, no en los procesos de dominio.",
        "technology": "Vite, React, React Flow, Semi UI",
        "parentId": "diagrams",
        "shape": "browser"
      },
      {
        "id": "diagrams-app",
        "type": "container",
        "name": "App de proyectos",
        "description": "Proceso iark serve de proyectos. Estilo backend-coredomain: módulo projects en Host, Application, Domain e Infrastructure. CRUD, bundle, importación, ifUpdatedAt e historial de versiones.",
        "technology": "Node.js, HTTP",
        "parentId": "diagrams"
      },
      {
        "id": "diagrams-gateway",
        "type": "container",
        "name": "Gateway de módulos",
        "description": "Gateway de módulos. Estilo gateway-feature-based: API /api/modules, operaciones por módulo, POST /api/trace y piscina worker_threads dentro del proceso.",
        "technology": "Node.js, HTTP",
        "parentId": "diagrams"
      },
      {
        "id": "diagrams-identity",
        "type": "container",
        "name": "Identity",
        "description": "Proceso de identidad. Estilo backend-nano: Host y Core con accounts (OAuth, sesión, miembros, admin, cuotas) y access-tokens (hashes Bearer).",
        "technology": "Node.js, HTTP",
        "parentId": "diagrams"
      },
      {
        "id": "diagrams-sse",
        "type": "container",
        "name": "Gateway SSE",
        "description": "Gateway SSE dedicado. Estilo gateway-feature-based: GET /api/events; la app publica avisos, este proceso mantiene las conexiones.",
        "technology": "Node.js, SSE",
        "parentId": "diagrams"
      },
      {
        "id": "mfe-c4",
        "type": "container",
        "name": "MFE c4",
        "description": "Remoto frontend-mfe-remote: UI de la especialidad C4 en el slot del shell.",
        "technology": "Vite, React",
        "parentId": "diagrams"
      },
      {
        "id": "mfe-integration",
        "type": "container",
        "name": "MFE integration",
        "description": "Remoto frontend-mfe-remote: especialidad integración.",
        "technology": "Vite, React",
        "parentId": "diagrams"
      },
      {
        "id": "mfe-data",
        "type": "container",
        "name": "MFE data",
        "description": "Remoto frontend-mfe-remote: especialidad datos.",
        "technology": "Vite, React",
        "parentId": "diagrams"
      },
      {
        "id": "mfe-enterprise",
        "type": "container",
        "name": "MFE enterprise",
        "description": "Remoto frontend-mfe-remote: especialidad empresarial.",
        "technology": "Vite, React",
        "parentId": "diagrams"
      },
      {
        "id": "mfe-platform",
        "type": "container",
        "name": "MFE platform",
        "description": "Remoto frontend-mfe-remote: especialidad plataforma.",
        "technology": "Vite, React",
        "parentId": "diagrams"
      },
      {
        "id": "mfe-security",
        "type": "container",
        "name": "MFE security",
        "description": "Remoto frontend-mfe-remote: especialidad seguridad.",
        "technology": "Vite, React",
        "parentId": "diagrams"
      },
      {
        "id": "mfe-trace",
        "type": "container",
        "name": "MFE trace",
        "description": "Remoto frontend-mfe-remote: trazabilidad URN (antes trazabilidad.html).",
        "technology": "Vite, React",
        "parentId": "diagrams"
      },
      {
        "id": "http-gateway",
        "type": "component",
        "name": "Enrutador HTTP",
        "description": "src/cli/serve.ts. Rutas /api/modules, /api/<módulo>/…, proyectos, auth, eventos, salud y estáticos.",
        "technology": "node:http",
        "parentId": "diagrams-gateway"
      },
      {
        "id": "http-app",
        "type": "component",
        "name": "Enrutador HTTP",
        "description": "src/cli/serve.ts. Rutas /api/modules, /api/<módulo>/…, proyectos, auth, eventos, salud y estáticos.",
        "technology": "node:http",
        "parentId": "diagrams-app"
      },
      {
        "id": "http-identity",
        "type": "component",
        "name": "Enrutador HTTP",
        "description": "src/cli/serve.ts. Rutas /api/modules, /api/<módulo>/…, proyectos, auth, eventos, salud y estáticos.",
        "technology": "node:http",
        "parentId": "diagrams-identity"
      },
      {
        "id": "http-sse",
        "type": "component",
        "name": "Enrutador HTTP",
        "description": "src/cli/serve.ts. Rutas /api/modules, /api/<módulo>/…, proyectos, auth, eventos, salud y estáticos.",
        "technology": "node:http",
        "parentId": "diagrams-sse"
      }
    ],
    "relationships": [
      {
        "id": "r-arq-sys",
        "sourceId": "arquitecto",
        "targetId": "diagrams",
        "description": "Modela y revisa diagramas",
        "technology": "navegador"
      },
      {
        "id": "r-op-sys",
        "sourceId": "operador",
        "targetId": "diagrams",
        "description": "Genera, valida y versiona",
        "technology": "CLI"
      },
      {
        "id": "r-adm-sys",
        "sourceId": "administrador",
        "targetId": "diagrams",
        "description": "Administra cuentas y cuotas",
        "technology": "HTTPS"
      },
      {
        "id": "r-host-sys",
        "sourceId": "anfitrion",
        "targetId": "diagrams",
        "description": "Embebe una superficie",
        "technology": "iframe, postMessage"
      },
      {
        "id": "r-sys-gh",
        "sourceId": "diagrams",
        "targetId": "github",
        "description": "Publica el sitio y autentica",
        "technology": "HTTPS"
      },
      {
        "id": "r-gh-sys",
        "sourceId": "github",
        "targetId": "diagrams",
        "description": "Sirve el sitio en Pages",
        "technology": "HTTPS"
      },
      {
        "id": "r-sys-ia",
        "sourceId": "diagrams",
        "targetId": "proveedor-ia",
        "description": "Pide documentos sin coordenadas",
        "technology": "HTTPS"
      },
      {
        "id": "r-sys-repo",
        "sourceId": "diagrams",
        "targetId": "repositorio",
        "description": "Lee una lista blanca",
        "technology": "git"
      },
      {
        "id": "r-proxy-sys",
        "sourceId": "proxy",
        "targetId": "diagrams",
        "description": "Publica el servicio en internet",
        "technology": "HTTP"
      },
      {
        "id": "r-prom-sys",
        "sourceId": "prometheus",
        "targetId": "diagrams",
        "description": "Raspa métricas si se activan",
        "technology": "HTTP"
      },
      {
        "id": "r-arq-sitio",
        "sourceId": "arquitecto",
        "targetId": "diagrams-shell",
        "description": "Abre la suite, el estudio o el banco",
        "technology": "navegador"
      },
      {
        "id": "r-op-cli",
        "sourceId": "operador",
        "targetId": "cli",
        "description": "Ejecuta iark",
        "technology": "proceso local"
      },
      {
        "id": "r-adm-srv",
        "sourceId": "administrador",
        "targetId": "diagrams-app",
        "description": "Administra la instancia",
        "technology": "HTTPS"
      },
      {
        "id": "r-host-sdk",
        "sourceId": "anfitrion",
        "targetId": "sdk",
        "description": "Carga el SDK o el Web Component",
        "technology": "JavaScript"
      },
      {
        "id": "r-sdk-sitio",
        "sourceId": "sdk",
        "targetId": "diagrams-shell",
        "description": "Abre un iframe",
        "technology": "postMessage"
      },
      {
        "id": "r-sitio-srv",
        "sourceId": "diagrams-shell",
        "targetId": "diagrams-app",
        "description": "Proyectos, API de módulo y sesión",
        "technology": "HTTPS"
      },
      {
        "id": "r-cli-ia",
        "sourceId": "cli",
        "targetId": "proveedor-ia",
        "description": "Genera, explica y revisa",
        "technology": "HTTPS"
      },
      {
        "id": "r-cli-repo",
        "sourceId": "cli",
        "targetId": "repositorio",
        "description": "Lee --from-repo",
        "technology": "sistema de archivos"
      },
      {
        "id": "r-cli-nuc",
        "sourceId": "cli",
        "targetId": "nucleo",
        "description": "Enlaza en el mismo proceso",
        "technology": "import"
      },
      {
        "id": "r-sitio-nuc",
        "sourceId": "diagrams-shell",
        "targetId": "nucleo",
        "description": "Empaqueta cada módulo al abrirlo",
        "technology": "Vite"
      },
      {
        "id": "r-srv-nuc",
        "sourceId": "diagrams-app",
        "targetId": "nucleo",
        "description": "Ejecuta el registro en el proceso y en el hilo",
        "technology": "import"
      },
      {
        "id": "r-cli-proy",
        "sourceId": "cli",
        "targetId": "proyectos",
        "description": "Lee y escribe la carpeta de trabajo",
        "technology": "sistema de archivos"
      },
      {
        "id": "r-srv-proy",
        "sourceId": "diagrams-app",
        "targetId": "proyectos",
        "description": "Persiste proyectos del servidor",
        "technology": "carpeta o Postgres"
      },
      {
        "id": "r-srv-cta",
        "sourceId": "diagrams-app",
        "targetId": "cuentas",
        "description": "Persiste personas, sesiones y cuotas",
        "technology": "SQLite, JSON o Postgres"
      },
      {
        "id": "r-srv-gh",
        "sourceId": "diagrams-app",
        "targetId": "github",
        "description": "Completa el OAuth",
        "technology": "HTTPS"
      },
      {
        "id": "r-sitio-gh",
        "sourceId": "diagrams-shell",
        "targetId": "github",
        "description": "Redirige a la persona a autorizar",
        "technology": "HTTPS"
      },
      {
        "id": "r-gh-sitio",
        "sourceId": "github",
        "targetId": "diagrams-shell",
        "description": "Sirve el build en Pages",
        "technology": "HTTPS"
      },
      {
        "id": "r-proxy-srv",
        "sourceId": "proxy",
        "targetId": "diagrams-app",
        "description": "Termina TLS y reenvía",
        "technology": "HTTP"
      },
      {
        "id": "r-prom-srv",
        "sourceId": "prometheus",
        "targetId": "diagrams-app",
        "description": "Raspa /metrics",
        "technology": "HTTP"
      },
      {
        "id": "r-boot-home",
        "sourceId": "boot",
        "targetId": "home",
        "description": "Monta la suite en /"
      },
      {
        "id": "r-boot-studio",
        "sourceId": "boot",
        "targetId": "studio",
        "description": "Monta /?editor=1 o ?studio=1"
      },
      {
        "id": "r-boot-editor",
        "sourceId": "boot",
        "targetId": "editor",
        "description": "Monta /?embed=1 o ?classic=1"
      },
      {
        "id": "r-boot-shell",
        "sourceId": "boot",
        "targetId": "shell",
        "description": "Monta /?manifest="
      },
      {
        "id": "r-studio-banco",
        "sourceId": "studio",
        "targetId": "banco",
        "description": "Reutiliza controlador, lienzo e inspector"
      },
      {
        "id": "r-studio-proy",
        "sourceId": "studio",
        "targetId": "proyectos-web",
        "description": "Abre y guarda proyectos"
      },
      {
        "id": "r-banco-proy",
        "sourceId": "banco",
        "targetId": "proyectos-web",
        "description": "Abre y guarda proyectos"
      },
      {
        "id": "r-editor-proy",
        "sourceId": "editor",
        "targetId": "proyectos-web",
        "description": "Abre y guarda proyectos"
      },
      {
        "id": "r-home-proy",
        "sourceId": "home",
        "targetId": "proyectos-web",
        "description": "Lista proyectos de la suite"
      },
      {
        "id": "r-editor-puente",
        "sourceId": "editor",
        "targetId": "puente",
        "description": "Habla con el anfitrión"
      },
      {
        "id": "r-banco-puente",
        "sourceId": "banco",
        "targetId": "puente",
        "description": "Habla con el anfitrión en embed"
      },
      {
        "id": "r-home-i18n",
        "sourceId": "home",
        "targetId": "i18n",
        "description": "Textos de la suite"
      },
      {
        "id": "r-studio-i18n",
        "sourceId": "studio",
        "targetId": "i18n",
        "description": "Textos del marco"
      },
      {
        "id": "r-banco-i18n",
        "sourceId": "banco",
        "targetId": "i18n",
        "description": "Textos del banco"
      },
      {
        "id": "r-editor-i18n",
        "sourceId": "editor",
        "targetId": "i18n",
        "description": "Textos del encabezado"
      },
      {
        "id": "r-banco-nuc",
        "sourceId": "banco",
        "targetId": "nucleo",
        "description": "Importa el módulo elegido",
        "technology": "import()"
      },
      {
        "id": "r-editor-nuc",
        "sourceId": "editor",
        "targetId": "nucleo",
        "description": "Incluye el módulo C4 en su trozo",
        "technology": "bundle"
      },
      {
        "id": "r-traza-nuc",
        "sourceId": "traza-ui",
        "targetId": "nucleo",
        "description": "Resuelve URN en el navegador"
      },
      {
        "id": "r-home-srv",
        "sourceId": "home",
        "targetId": "diagrams-app",
        "description": "Lista proyectos remotos si hay sesión",
        "technology": "HTTPS"
      },
      {
        "id": "r-proyweb-srv",
        "sourceId": "proyectos-web",
        "targetId": "diagrams-app",
        "description": "Guarda, sincroniza y escucha avisos",
        "technology": "HTTPS, SSE"
      },
      {
        "id": "r-puente-sdk",
        "sourceId": "puente",
        "targetId": "sdk",
        "description": "Responde al protocolo del anfitrión",
        "technology": "postMessage"
      },
      {
        "id": "r-host-c4",
        "sourceId": "anfitrion",
        "targetId": "embed-c4",
        "description": "Crea el embebido del editor"
      },
      {
        "id": "r-host-mod",
        "sourceId": "anfitrion",
        "targetId": "embed-modulo",
        "description": "Crea el embebido de un módulo"
      },
      {
        "id": "r-host-wc",
        "sourceId": "anfitrion",
        "targetId": "web-component",
        "description": "Usa <iark-module>"
      },
      {
        "id": "r-c4-proto",
        "sourceId": "embed-c4",
        "targetId": "protocolo",
        "description": "Habla el protocolo del editor"
      },
      {
        "id": "r-mod-proto",
        "sourceId": "embed-modulo",
        "targetId": "protocolo",
        "description": "Habla el protocolo de módulos"
      },
      {
        "id": "r-wc-proto",
        "sourceId": "web-component",
        "targetId": "protocolo",
        "description": "Habla el protocolo de módulos"
      },
      {
        "id": "r-proto-sitio",
        "sourceId": "protocolo",
        "targetId": "diagrams-shell",
        "description": "Abre el iframe y negocia capacidades",
        "technology": "postMessage"
      },
      {
        "id": "r-cmd-reg",
        "sourceId": "comandos",
        "targetId": "registro-cli",
        "description": "Resuelve --module"
      },
      {
        "id": "r-cmd-ia",
        "sourceId": "comandos",
        "targetId": "ia-cli",
        "description": "generate, explain y review"
      },
      {
        "id": "r-cmd-repo",
        "sourceId": "comandos",
        "targetId": "repo-cli",
        "description": "Pasa --from-repo"
      },
      {
        "id": "r-cmd-ws",
        "sourceId": "comandos",
        "targetId": "workspace-cli",
        "description": "iark project"
      },
      {
        "id": "r-cmd-plug",
        "sourceId": "comandos",
        "targetId": "plugins-cli",
        "description": "Elige la configuración"
      },
      {
        "id": "r-plug-reg",
        "sourceId": "plugins-cli",
        "targetId": "registro-cli",
        "description": "Registra si el contrato encaja"
      },
      {
        "id": "r-ia-prov",
        "sourceId": "ia-cli",
        "targetId": "proveedor-ia",
        "description": "Pide JSON estructurado",
        "technology": "HTTPS"
      },
      {
        "id": "r-repo-fs",
        "sourceId": "repo-cli",
        "targetId": "repositorio",
        "description": "Lee la lista blanca y redacta secretos"
      },
      {
        "id": "r-ws-proy",
        "sourceId": "workspace-cli",
        "targetId": "proyectos",
        "description": "Lee y escribe la carpeta"
      },
      {
        "id": "r-reg-nuc",
        "sourceId": "registro-cli",
        "targetId": "nucleo",
        "description": "Carga cada DomainModule"
      },
      {
        "id": "r-ia-nuc",
        "sourceId": "ia-cli",
        "targetId": "nucleo",
        "description": "Usa el AiSpec del módulo"
      },
      {
        "id": "r-http-api",
        "sourceId": "http-gateway",
        "targetId": "api-modulos",
        "description": "Enruta /api/<módulo>"
      },
      {
        "id": "r-http-proy",
        "sourceId": "http-app",
        "targetId": "api-proyectos",
        "description": "Enruta /api/projects"
      },
      {
        "id": "r-http-tok",
        "sourceId": "http-identity",
        "targetId": "tokens",
        "description": "Exige Bearer si hay --tokens"
      },
      {
        "id": "r-http-gh",
        "sourceId": "http-identity",
        "targetId": "cuentas-gh",
        "description": "Enruta /api/auth y /api/admin"
      },
      {
        "id": "r-http-sse",
        "sourceId": "http-sse",
        "targetId": "sse",
        "description": "Enruta /api/events"
      },
      {
        "id": "r-http-obs",
        "sourceId": "http-app",
        "targetId": "obs",
        "description": "Salud, registros y /metrics"
      },
      {
        "id": "r-http-cab",
        "sourceId": "http-gateway",
        "targetId": "cabeceras",
        "description": "Aplica las cabeceras a cada respuesta"
      },
      {
        "id": "r-api-pool",
        "sourceId": "api-modulos",
        "targetId": "pool",
        "description": "Saca el cálculo del hilo principal"
      },
      {
        "id": "r-pool-nuc",
        "sourceId": "pool",
        "targetId": "nucleo",
        "description": "Ejecuta validate, export, import y trace"
      },
      {
        "id": "r-proy-store",
        "sourceId": "api-proyectos",
        "targetId": "proyectos",
        "description": "Persiste diagramas e historial"
      },
      {
        "id": "r-gh-cta",
        "sourceId": "cuentas-gh",
        "targetId": "cuentas",
        "description": "Guarda el hash de la sesión"
      },
      {
        "id": "r-gh-oauth",
        "sourceId": "cuentas-gh",
        "targetId": "github",
        "description": "Login y callback",
        "technology": "OAuth"
      },
      {
        "id": "r-tok-proy",
        "sourceId": "tokens",
        "targetId": "api-proyectos",
        "description": "Autoriza por rol de la carpeta"
      },
      {
        "id": "r-sse-sitio",
        "sourceId": "sse",
        "targetId": "diagrams-shell",
        "description": "Avisa de una versión más nueva",
        "technology": "SSE"
      },
      {
        "id": "r-prom-obs",
        "sourceId": "prometheus",
        "targetId": "obs",
        "description": "Raspa /metrics",
        "technology": "HTTP"
      },
      {
        "id": "r-proxy-http",
        "sourceId": "proxy",
        "targetId": "http-gateway",
        "description": "Reenvía y marca el protocolo original",
        "technology": "HTTP"
      },
      {
        "id": "r-c4-ct",
        "sourceId": "mod-c4",
        "targetId": "contrato",
        "description": "Implementa DomainModule"
      },
      {
        "id": "r-int-ct",
        "sourceId": "mod-integration",
        "targetId": "contrato",
        "description": "Implementa DomainModule"
      },
      {
        "id": "r-data-ct",
        "sourceId": "mod-data",
        "targetId": "contrato",
        "description": "Implementa DomainModule"
      },
      {
        "id": "r-ent-ct",
        "sourceId": "mod-enterprise",
        "targetId": "contrato",
        "description": "Implementa DomainModule"
      },
      {
        "id": "r-plat-ct",
        "sourceId": "mod-platform",
        "targetId": "contrato",
        "description": "Implementa DomainModule"
      },
      {
        "id": "r-sec-ct",
        "sourceId": "mod-security",
        "targetId": "contrato",
        "description": "Implementa DomainModule"
      },
      {
        "id": "r-urn-c4",
        "sourceId": "urn",
        "targetId": "mod-c4",
        "description": "Lee entidades sin importar el módulo"
      },
      {
        "id": "r-urn-int",
        "sourceId": "urn",
        "targetId": "mod-integration",
        "description": "Lee entidades sin importar el módulo"
      },
      {
        "id": "r-urn-data",
        "sourceId": "urn",
        "targetId": "mod-data",
        "description": "Lee entidades sin importar el módulo"
      },
      {
        "id": "r-urn-ent",
        "sourceId": "urn",
        "targetId": "mod-enterprise",
        "description": "Lee entidades sin importar el módulo"
      },
      {
        "id": "r-urn-plat",
        "sourceId": "urn",
        "targetId": "mod-platform",
        "description": "Lee entidades sin importar el módulo"
      },
      {
        "id": "r-urn-sec",
        "sourceId": "urn",
        "targetId": "mod-security",
        "description": "Lee entidades sin importar el módulo"
      },
      {
        "id": "r-c4-ia",
        "sourceId": "mod-c4",
        "targetId": "ia-kernel",
        "description": "Entrega prompts y esquema"
      },
      {
        "id": "r-int-ia",
        "sourceId": "mod-integration",
        "targetId": "ia-kernel",
        "description": "Entrega prompts y esquema"
      },
      {
        "id": "r-data-ia",
        "sourceId": "mod-data",
        "targetId": "ia-kernel",
        "description": "Entrega prompts y esquema"
      },
      {
        "id": "r-ent-ia",
        "sourceId": "mod-enterprise",
        "targetId": "ia-kernel",
        "description": "Entrega prompts y esquema"
      },
      {
        "id": "r-plat-ia",
        "sourceId": "mod-platform",
        "targetId": "ia-kernel",
        "description": "Entrega prompts y esquema"
      },
      {
        "id": "r-sec-ia",
        "sourceId": "mod-security",
        "targetId": "ia-kernel",
        "description": "Entrega prompts y esquema"
      },
      {
        "id": "r-c4-grafo",
        "sourceId": "mod-c4",
        "targetId": "grafo",
        "description": "Pinta el SVG; el autolayout del modelo es propio"
      },
      {
        "id": "r-int-grafo",
        "sourceId": "mod-integration",
        "targetId": "grafo",
        "description": "Pide layoutGraph para sus vistas"
      },
      {
        "id": "r-data-grafo",
        "sourceId": "mod-data",
        "targetId": "grafo",
        "description": "Pide layoutGraph para sus vistas"
      },
      {
        "id": "r-ent-grafo",
        "sourceId": "mod-enterprise",
        "targetId": "grafo",
        "description": "Pide layoutGraph para sus vistas"
      },
      {
        "id": "r-plat-grafo",
        "sourceId": "mod-platform",
        "targetId": "grafo",
        "description": "Pide layoutGraph para sus vistas"
      },
      {
        "id": "r-sec-grafo",
        "sourceId": "mod-security",
        "targetId": "grafo",
        "description": "Pide layoutGraph para sus vistas"
      },
      {
        "id": "r-diff-ct",
        "sourceId": "diff",
        "targetId": "contrato",
        "description": "Usa el DiffSpec del módulo"
      },
      {
        "id": "r-pm-ct",
        "sourceId": "proyecto-modelo",
        "targetId": "contrato",
        "description": "Guarda id de módulo y texto"
      },
      {
        "id": "r-shell-gw",
        "sourceId": "diagrams-shell",
        "targetId": "diagrams-gateway",
        "description": "API de módulos y traza URN",
        "technology": "HTTPS"
      },
      {
        "id": "r-shell-id",
        "sourceId": "diagrams-shell",
        "targetId": "diagrams-identity",
        "description": "OAuth, sesión y whoami",
        "technology": "HTTPS"
      },
      {
        "id": "r-shell-sse",
        "sourceId": "diagrams-shell",
        "targetId": "diagrams-sse",
        "description": "Escucha avisos de proyectos",
        "technology": "HTTPS, SSE"
      },
      {
        "id": "r-app-sse-pub",
        "sourceId": "diagrams-app",
        "targetId": "diagrams-sse",
        "description": "Publica avisos tras escrituras confirmadas",
        "technology": "canal interno"
      },
      {
        "id": "r-gw-id",
        "sourceId": "diagrams-gateway",
        "targetId": "diagrams-identity",
        "description": "Valida Bearer o sesión",
        "technology": "HTTPS"
      },
      {
        "id": "r-app-id",
        "sourceId": "diagrams-app",
        "targetId": "diagrams-identity",
        "description": "Valida sesión, miembros y cuotas",
        "technology": "HTTPS"
      },
      {
        "id": "r-shell-mfe-c4",
        "sourceId": "diagrams-shell",
        "targetId": "mfe-c4",
        "description": "Monta el remoto en el slot",
        "technology": "manifiesto iark"
      },
      {
        "id": "r-shell-mfe-int",
        "sourceId": "diagrams-shell",
        "targetId": "mfe-integration",
        "description": "Monta el remoto en el slot",
        "technology": "manifiesto iark"
      },
      {
        "id": "r-shell-mfe-data",
        "sourceId": "diagrams-shell",
        "targetId": "mfe-data",
        "description": "Monta el remoto en el slot",
        "technology": "manifiesto iark"
      },
      {
        "id": "r-shell-mfe-ent",
        "sourceId": "diagrams-shell",
        "targetId": "mfe-enterprise",
        "description": "Monta el remoto en el slot",
        "technology": "manifiesto iark"
      },
      {
        "id": "r-shell-mfe-plat",
        "sourceId": "diagrams-shell",
        "targetId": "mfe-platform",
        "description": "Monta el remoto en el slot",
        "technology": "manifiesto iark"
      },
      {
        "id": "r-shell-mfe-sec",
        "sourceId": "diagrams-shell",
        "targetId": "mfe-security",
        "description": "Monta el remoto en el slot",
        "technology": "manifiesto iark"
      },
      {
        "id": "r-shell-mfe-trace",
        "sourceId": "diagrams-shell",
        "targetId": "mfe-trace",
        "description": "Monta trazabilidad en /trace",
        "technology": "manifiesto iark"
      },
      {
        "id": "r-proxy-gw",
        "sourceId": "proxy",
        "targetId": "diagrams-gateway",
        "description": "Termina TLS hacia el gateway de módulos",
        "technology": "HTTP"
      },
      {
        "id": "r-proxy-app",
        "sourceId": "proxy",
        "targetId": "diagrams-app",
        "description": "Termina TLS hacia la app de proyectos",
        "technology": "HTTP"
      },
      {
        "id": "r-proxy-id",
        "sourceId": "proxy",
        "targetId": "diagrams-identity",
        "description": "Termina TLS hacia identity",
        "technology": "HTTP"
      },
      {
        "id": "r-proxy-sse-proc",
        "sourceId": "proxy",
        "targetId": "diagrams-sse",
        "description": "Termina TLS hacia el gateway SSE",
        "technology": "HTTP"
      },
      {
        "id": "r-prom-gw",
        "sourceId": "prometheus",
        "targetId": "diagrams-gateway",
        "description": "Raspa /metrics del gateway",
        "technology": "HTTP"
      },
      {
        "id": "r-prom-app",
        "sourceId": "prometheus",
        "targetId": "diagrams-app",
        "description": "Raspa /metrics de la app",
        "technology": "HTTP"
      },
      {
        "id": "r-prom-id",
        "sourceId": "prometheus",
        "targetId": "diagrams-identity",
        "description": "Raspa /metrics de identity",
        "technology": "HTTP"
      },
      {
        "id": "r-prom-sse",
        "sourceId": "prometheus",
        "targetId": "diagrams-sse",
        "description": "Raspa /metrics del gateway SSE",
        "technology": "HTTP"
      },
      {
        "id": "r-adm-id",
        "sourceId": "administrador",
        "targetId": "diagrams-identity",
        "description": "Administra cuentas y cuotas",
        "technology": "HTTPS"
      },
      {
        "id": "r-mfe-nuc",
        "sourceId": "mfe-c4",
        "targetId": "nucleo",
        "description": "Empaqueta el módulo C4 al abrir",
        "technology": "import()"
      }
    ]
  },
  "views": [
    {
      "id": "c1",
      "type": "systemContext",
      "scopeId": "diagrams",
      "title": "C1 · Contexto to-be",
      "description": "Personas y sistemas externos. El proveedor de IA solo entra por el CLI.",
      "elements": [
        {
          "id": "arquitecto"
        },
        {
          "id": "operador"
        },
        {
          "id": "administrador"
        },
        {
          "id": "anfitrion"
        },
        {
          "id": "diagrams"
        },
        {
          "id": "github"
        },
        {
          "id": "proveedor-ia"
        },
        {
          "id": "repositorio"
        },
        {
          "id": "proxy"
        },
        {
          "id": "prometheus"
        }
      ],
      "layout": {
        "direction": "RIGHT",
        "density": "spacious"
      }
    },
    {
      "id": "c2",
      "type": "container",
      "scopeId": "diagrams",
      "title": "C2 · Contenedores to-be",
      "description": "Procesos partidos, shell SPA, remotos MFE y librerías compartidas.",
      "elements": [
        {
          "id": "arquitecto"
        },
        {
          "id": "operador"
        },
        {
          "id": "administrador"
        },
        {
          "id": "anfitrion"
        },
        {
          "id": "diagrams-shell"
        },
        {
          "id": "sdk"
        },
        {
          "id": "cli"
        },
        {
          "id": "diagrams-app"
        },
        {
          "id": "diagrams-gateway"
        },
        {
          "id": "diagrams-identity"
        },
        {
          "id": "diagrams-sse"
        },
        {
          "id": "mfe-c4"
        },
        {
          "id": "mfe-integration"
        },
        {
          "id": "mfe-data"
        },
        {
          "id": "mfe-enterprise"
        },
        {
          "id": "mfe-platform"
        },
        {
          "id": "mfe-security"
        },
        {
          "id": "mfe-trace"
        },
        {
          "id": "nucleo"
        },
        {
          "id": "github"
        },
        {
          "id": "proveedor-ia"
        },
        {
          "id": "repositorio"
        },
        {
          "id": "proxy"
        },
        {
          "id": "prometheus"
        }
      ],
      "layout": {
        "direction": "RIGHT",
        "density": "spacious"
      }
    },
    {
      "id": "c3-shell",
      "type": "component",
      "scopeId": "diagrams-shell",
      "title": "C3 · Shell SPA",
      "description": "Router, features y cliente de proyectos.",
      "elements": [
        {
          "id": "boot"
        },
        {
          "id": "home"
        },
        {
          "id": "studio"
        },
        {
          "id": "editor"
        },
        {
          "id": "banco"
        },
        {
          "id": "shell"
        },
        {
          "id": "traza-ui"
        },
        {
          "id": "proyectos-web"
        },
        {
          "id": "i18n"
        },
        {
          "id": "puente"
        },
        {
          "id": "nucleo"
        },
        {
          "id": "diagrams-app"
        },
        {
          "id": "diagrams-gateway"
        },
        {
          "id": "diagrams-identity"
        },
        {
          "id": "diagrams-sse"
        },
        {
          "id": "sdk"
        },
        {
          "id": "mfe-c4"
        },
        {
          "id": "mfe-integration"
        },
        {
          "id": "mfe-data"
        },
        {
          "id": "mfe-enterprise"
        },
        {
          "id": "mfe-platform"
        },
        {
          "id": "mfe-security"
        },
        {
          "id": "mfe-trace"
        }
      ],
      "layout": {
        "direction": "RIGHT",
        "density": "spacious"
      }
    },
    {
      "id": "c3-sdk",
      "type": "component",
      "scopeId": "sdk",
      "title": "C3 · SDK de embebido",
      "description": "Anfitrión e iframe del shell.",
      "elements": [
        {
          "id": "anfitrion"
        },
        {
          "id": "embed-c4"
        },
        {
          "id": "embed-modulo"
        },
        {
          "id": "web-component"
        },
        {
          "id": "protocolo"
        },
        {
          "id": "diagrams-shell"
        }
      ],
      "layout": {
        "direction": "RIGHT"
      }
    },
    {
      "id": "c3-cli",
      "type": "component",
      "scopeId": "cli",
      "title": "C3 · CLI iark",
      "description": "Host commander y puertos hexagonales.",
      "elements": [
        {
          "id": "comandos"
        },
        {
          "id": "registro-cli"
        },
        {
          "id": "ia-cli"
        },
        {
          "id": "repo-cli"
        },
        {
          "id": "workspace-cli"
        },
        {
          "id": "plugins-cli"
        },
        {
          "id": "nucleo"
        },
        {
          "id": "proveedor-ia"
        },
        {
          "id": "repositorio"
        },
        {
          "id": "proyectos"
        }
      ],
      "layout": {
        "direction": "RIGHT"
      }
    },
    {
      "id": "c3-gateway",
      "type": "component",
      "scopeId": "diagrams-gateway",
      "title": "C3 · Gateway de módulos",
      "description": "API de módulos, piscina y cabeceras de borde.",
      "elements": [
        {
          "id": "http-gateway"
        },
        {
          "id": "api-modulos"
        },
        {
          "id": "pool"
        },
        {
          "id": "cabeceras"
        },
        {
          "id": "nucleo"
        },
        {
          "id": "diagrams-identity"
        },
        {
          "id": "proxy"
        },
        {
          "id": "prometheus"
        }
      ],
      "layout": {
        "direction": "RIGHT",
        "density": "spacious"
      }
    },
    {
      "id": "c3-app",
      "type": "component",
      "scopeId": "diagrams-app",
      "title": "C3 · App de proyectos",
      "description": "Módulo projects y observabilidad local.",
      "elements": [
        {
          "id": "http-app"
        },
        {
          "id": "api-proyectos"
        },
        {
          "id": "obs"
        },
        {
          "id": "proyectos"
        },
        {
          "id": "diagrams-identity"
        },
        {
          "id": "diagrams-sse"
        },
        {
          "id": "proxy"
        },
        {
          "id": "prometheus"
        }
      ],
      "layout": {
        "direction": "RIGHT",
        "density": "spacious"
      }
    },
    {
      "id": "c3-identity",
      "type": "component",
      "scopeId": "diagrams-identity",
      "title": "C3 · Identity",
      "description": "Tokens, cuentas GitHub y almacén.",
      "elements": [
        {
          "id": "http-identity"
        },
        {
          "id": "tokens"
        },
        {
          "id": "cuentas-gh"
        },
        {
          "id": "cuentas"
        },
        {
          "id": "github"
        },
        {
          "id": "proxy"
        },
        {
          "id": "prometheus"
        }
      ],
      "layout": {
        "direction": "RIGHT",
        "density": "spacious"
      }
    },
    {
      "id": "c3-sse",
      "type": "component",
      "scopeId": "diagrams-sse",
      "title": "C3 · Gateway SSE",
      "description": "Canal de avisos en tiempo real.",
      "elements": [
        {
          "id": "http-sse"
        },
        {
          "id": "sse"
        },
        {
          "id": "cabeceras"
        },
        {
          "id": "proxy"
        },
        {
          "id": "prometheus"
        },
        {
          "id": "diagrams-shell"
        }
      ],
      "layout": {
        "direction": "RIGHT"
      }
    },
    {
      "id": "c3-nucleo",
      "type": "component",
      "scopeId": "nucleo",
      "title": "C3 · Núcleo y módulos",
      "description": "Librería @iark/* ejecutada desde el gateway.",
      "elements": [
        {
          "id": "contrato"
        },
        {
          "id": "urn"
        },
        {
          "id": "diff"
        },
        {
          "id": "proyecto-modelo"
        },
        {
          "id": "ia-kernel"
        },
        {
          "id": "grafo"
        },
        {
          "id": "mod-c4"
        },
        {
          "id": "mod-integration"
        },
        {
          "id": "mod-data"
        },
        {
          "id": "mod-enterprise"
        },
        {
          "id": "mod-platform"
        },
        {
          "id": "mod-security"
        }
      ],
      "layout": {
        "direction": "DOWN",
        "density": "spacious"
      }
    }
  ]
}
`;export{e as default};