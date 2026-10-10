var e=`{
  "version": "1.0",
  "workspace": {
    "name": "Catálogo de datos de ventas",
    "description": "La plataforma de ventas con su catálogo: productos de datos con puertos y SLA, una API de datos y el glosario de negocio enlazado a columnas"
  },
  "domains": [
    { "id": "ventas", "name": "Ventas", "owner": "Equipo Ventas" },
    { "id": "clientes", "name": "Clientes", "owner": "Equipo CRM" },
    { "id": "plataforma", "name": "Plataforma de datos", "owner": "Equipo Plataforma" }
  ],
  "assets": [
    { "id": "crm", "kind": "source", "name": "CRM", "technology": "Salesforce", "domainId": "clientes", "owner": "Equipo CRM", "external": true },
    {
      "id": "crm-clientes",
      "kind": "table",
      "name": "clientes",
      "parentId": "crm",
      "classification": "confidential",
      "retention": "5 años tras la baja",
      "columns": [
        { "name": "id", "type": "uuid", "keys": ["pk"] },
        { "name": "nombre", "type": "text", "pii": true },
        { "name": "email", "type": "text", "pii": true },
        { "name": "pais", "type": "text" }
      ]
    },
    {
      "id": "erp",
      "kind": "source",
      "name": "ERP de pedidos",
      "technology": "PostgreSQL",
      "domainId": "ventas",
      "owner": "Equipo Ventas",
      "ref": "urn:iark:integration:pedidos"
    },
    {
      "id": "erp-pedidos",
      "kind": "table",
      "name": "pedidos",
      "parentId": "erp",
      "classification": "internal",
      "columns": [
        { "name": "id", "type": "bigint", "keys": ["pk"] },
        { "name": "cliente_id", "type": "uuid", "keys": ["fk"] },
        { "name": "fecha", "type": "date" },
        { "name": "total", "type": "numeric" }
      ]
    },
    {
      "id": "erp-lineas",
      "kind": "table",
      "name": "líneas de pedido",
      "parentId": "erp",
      "classification": "internal",
      "columns": [
        { "name": "pedido_id", "type": "bigint", "keys": ["pk", "fk"] },
        { "name": "producto", "type": "text", "keys": ["pk"] },
        { "name": "cantidad", "type": "int" },
        { "name": "precio", "type": "numeric" }
      ]
    },
    {
      "id": "lake",
      "kind": "lake",
      "name": "Lakehouse de ventas",
      "technology": "S3 + Delta Lake",
      "domainId": "plataforma",
      "owner": "Equipo Plataforma"
    },
    {
      "id": "bronze-clientes",
      "kind": "table",
      "name": "bronce: clientes",
      "parentId": "lake",
      "classification": "confidential",
      "pii": true,
      "retention": "5 años tras la baja",
      "columns": [
        { "name": "id", "type": "uuid", "keys": ["pk"] },
        { "name": "nombre", "type": "text", "pii": true },
        { "name": "email", "type": "text", "pii": true },
        { "name": "pais", "type": "text" }
      ]
    },
    {
      "id": "bronze-pedidos",
      "kind": "table",
      "name": "bronce: pedidos",
      "parentId": "lake",
      "classification": "internal",
      "columns": [
        { "name": "pedido_id", "type": "bigint", "keys": ["pk"] },
        { "name": "cliente_id", "type": "uuid" },
        { "name": "fecha", "type": "date" },
        { "name": "total", "type": "numeric" }
      ]
    },
    {
      "id": "silver-ventas",
      "kind": "table",
      "name": "plata: ventas",
      "parentId": "lake",
      "classification": "confidential",
      "pii": true,
      "retention": "5 años tras la baja",
      "columns": [
        { "name": "venta_id", "type": "bigint", "keys": ["pk"] },
        { "name": "cliente_id", "type": "uuid" },
        { "name": "cliente_nombre", "type": "text", "pii": true },
        { "name": "pais", "type": "text" },
        { "name": "fecha", "type": "date" },
        { "name": "importe", "type": "numeric" }
      ]
    },
    { "id": "dwh", "kind": "warehouse", "name": "DWH corporativo", "technology": "Snowflake", "domainId": "plataforma", "owner": "Equipo Plataforma" },
    {
      "id": "dwh-dim-cliente",
      "kind": "table",
      "name": "dim_cliente",
      "parentId": "dwh",
      "classification": "confidential",
      "retention": "5 años tras la baja",
      "columns": [
        { "name": "cliente_key", "type": "int", "keys": ["pk"] },
        { "name": "nombre", "type": "text", "pii": true },
        { "name": "pais", "type": "text" }
      ]
    },
    {
      "id": "dwh-fact-ventas",
      "kind": "table",
      "name": "fact_ventas",
      "parentId": "dwh",
      "classification": "internal",
      "columns": [
        { "name": "venta_key", "type": "bigint", "keys": ["pk"] },
        { "name": "cliente_key", "type": "int", "keys": ["fk"] },
        { "name": "fecha", "type": "date" },
        { "name": "importe", "type": "numeric" }
      ]
    },
    {
      "id": "panel-ventas",
      "kind": "report",
      "name": "Panel de ventas",
      "technology": "Power BI",
      "domainId": "ventas",
      "owner": "Equipo BI",
      "classification": "internal"
    },
    {
      "id": "modelo-fuga",
      "kind": "model",
      "name": "Modelo de fuga de clientes",
      "technology": "scikit-learn",
      "domainId": "clientes",
      "owner": "Ciencia de datos",
      "classification": "confidential",
      "pii": true,
      "retention": "2 años"
    },
    {
      "id": "ventas-360",
      "kind": "data-product",
      "name": "Ventas 360",
      "description": "Ventas por cliente, país y mes, listas para análisis",
      "technology": "dbt + Snowflake",
      "owner": "Equipo Ventas",
      "domainId": "ventas",
      "classification": "confidential",
      "inputPorts": ["silver-ventas"],
      "outputPorts": ["dwh-fact-ventas", "dwh-dim-cliente", "api-ventas"],
      "freshness": "24 h",
      "sla": "99,5 % de disponibilidad · soporte L-V",
      "contractId": "contrato-ventas-360"
    },
    {
      "id": "analitica-fuga",
      "kind": "data-product",
      "name": "Analítica de fuga",
      "description": "Probabilidad de fuga de cada cliente, reentrenada cada semana",
      "technology": "MLflow",
      "owner": "Ciencia de datos",
      "domainId": "clientes",
      "classification": "confidential",
      "inputPorts": ["dwh-dim-cliente", "dwh-fact-ventas"],
      "outputPorts": ["modelo-fuga"],
      "freshness": "7 d",
      "sla": "Reentrenado cada semana",
      "contractId": "contrato-analitica-fuga"
    },
    {
      "id": "api-ventas",
      "kind": "data-api",
      "name": "API de ventas",
      "description": "Consulta de ventas por fecha para las aplicaciones de la empresa",
      "technology": "Kong + FastAPI",
      "owner": "Equipo Ventas",
      "domainId": "ventas",
      "classification": "internal",
      "protocol": "rest",
      "endpoint": "https://api.acme.com/ventas/v1",
      "exposes": ["dwh-fact-ventas"],
      "contractId": "contrato-api-ventas"
    },
    {
      "id": "glosario-ventas",
      "kind": "glossary",
      "name": "Ventas y clientes",
      "description": "Términos de negocio de ventas y clientes",
      "owner": "Gobierno del dato",
      "domainId": "ventas"
    }
  ],
  "pipelines": [
    {
      "id": "ingesta-crm",
      "name": "Ingesta del CRM",
      "kind": "cdc",
      "inputs": ["crm-clientes"],
      "outputs": ["bronze-clientes"],
      "tool": "Debezium",
      "mappings": [
        { "from": { "assetId": "crm-clientes", "column": "id" }, "to": { "assetId": "bronze-clientes", "column": "id" }, "transform": "copia" },
        {
          "from": { "assetId": "crm-clientes", "column": "nombre" },
          "to": { "assetId": "bronze-clientes", "column": "nombre" },
          "transform": "copia"
        },
        { "from": { "assetId": "crm-clientes", "column": "email" }, "to": { "assetId": "bronze-clientes", "column": "email" }, "transform": "copia" },
        { "from": { "assetId": "crm-clientes", "column": "pais" }, "to": { "assetId": "bronze-clientes", "column": "pais" }, "transform": "copia" }
      ]
    },
    {
      "id": "ingesta-erp",
      "name": "Ingesta del ERP",
      "kind": "batch",
      "inputs": ["erp-pedidos", "erp-lineas"],
      "outputs": ["bronze-pedidos"],
      "tool": "Airflow",
      "schedule": "diaria 02:00",
      "mappings": [
        { "from": { "assetId": "erp-pedidos", "column": "id" }, "to": { "assetId": "bronze-pedidos", "column": "pedido_id" }, "transform": "copia" },
        {
          "from": { "assetId": "erp-pedidos", "column": "cliente_id" },
          "to": { "assetId": "bronze-pedidos", "column": "cliente_id" },
          "transform": "copia"
        },
        { "from": { "assetId": "erp-pedidos", "column": "fecha" }, "to": { "assetId": "bronze-pedidos", "column": "fecha" }, "transform": "copia" },
        { "from": { "assetId": "erp-pedidos", "column": "total" }, "to": { "assetId": "bronze-pedidos", "column": "total" }, "transform": "copia" }
      ]
    },
    {
      "id": "limpieza",
      "name": "Limpieza y unión",
      "kind": "elt",
      "inputs": ["bronze-pedidos", "bronze-clientes"],
      "outputs": ["silver-ventas"],
      "tool": "dbt",
      "schedule": "diaria 03:00",
      "mappings": [
        { "from": { "assetId": "bronze-pedidos", "column": "cliente_id" }, "to": { "assetId": "silver-ventas", "column": "cliente_id" } },
        { "from": { "assetId": "bronze-pedidos", "column": "fecha" }, "to": { "assetId": "silver-ventas", "column": "fecha" } },
        {
          "from": { "assetId": "bronze-pedidos", "column": "total" },
          "to": { "assetId": "silver-ventas", "column": "importe" },
          "transform": "total sin impuestos"
        },
        {
          "from": { "assetId": "bronze-clientes", "column": "nombre" },
          "to": { "assetId": "silver-ventas", "column": "cliente_nombre" },
          "transform": "unión por cliente_id"
        },
        {
          "from": { "assetId": "bronze-clientes", "column": "pais" },
          "to": { "assetId": "silver-ventas", "column": "pais" },
          "transform": "unión por cliente_id"
        }
      ]
    },
    {
      "id": "carga-dimension",
      "name": "Carga de dimensión de clientes",
      "kind": "elt",
      "inputs": ["silver-ventas"],
      "outputs": ["dwh-dim-cliente"],
      "tool": "dbt",
      "schedule": "diaria 04:00",
      "mappings": [
        {
          "from": { "assetId": "silver-ventas", "column": "cliente_id" },
          "to": { "assetId": "dwh-dim-cliente", "column": "cliente_key" },
          "transform": "clave sustituta"
        },
        { "from": { "assetId": "silver-ventas", "column": "cliente_nombre" }, "to": { "assetId": "dwh-dim-cliente", "column": "nombre" } },
        { "from": { "assetId": "silver-ventas", "column": "pais" }, "to": { "assetId": "dwh-dim-cliente", "column": "pais" } }
      ]
    },
    {
      "id": "carga-hechos",
      "name": "Carga de hechos (seudonimiza)",
      "kind": "elt",
      "inputs": ["silver-ventas"],
      "outputs": ["dwh-fact-ventas"],
      "tool": "dbt",
      "schedule": "diaria 04:00",
      "anonymizes": true,
      "mappings": [
        {
          "from": { "assetId": "silver-ventas", "column": "cliente_id" },
          "to": { "assetId": "dwh-fact-ventas", "column": "cliente_key" },
          "transform": "clave sustituta"
        },
        { "from": { "assetId": "silver-ventas", "column": "fecha" }, "to": { "assetId": "dwh-fact-ventas", "column": "fecha" } },
        { "from": { "assetId": "silver-ventas", "column": "importe" }, "to": { "assetId": "dwh-fact-ventas", "column": "importe" } }
      ]
    },
    {
      "id": "publica-panel",
      "name": "Actualiza el panel",
      "kind": "batch",
      "inputs": ["dwh-fact-ventas"],
      "outputs": ["panel-ventas"],
      "tool": "Power BI",
      "schedule": "diaria 06:00",
      "mappings": [
        {
          "from": { "assetId": "dwh-fact-ventas", "column": "importe" },
          "to": { "assetId": "panel-ventas", "column": "Ventas totales" },
          "transform": "suma por mes"
        },
        { "from": { "assetId": "dwh-fact-ventas", "column": "fecha" }, "to": { "assetId": "panel-ventas", "column": "Mes" } }
      ]
    },
    {
      "id": "entrena-fuga",
      "name": "Entrenamiento del modelo",
      "kind": "batch",
      "inputs": ["dwh-dim-cliente", "dwh-fact-ventas"],
      "outputs": ["modelo-fuga"],
      "tool": "MLflow",
      "schedule": "semanal",
      "mappings": [
        { "from": { "assetId": "dwh-dim-cliente", "column": "pais" }, "to": { "assetId": "modelo-fuga", "column": "pais" } },
        {
          "from": { "assetId": "dwh-fact-ventas", "column": "importe" },
          "to": { "assetId": "modelo-fuga", "column": "gasto_total" },
          "transform": "suma por cliente"
        }
      ]
    }
  ],
  "relations": [
    { "id": "pedido-lineas", "sourceId": "erp-pedidos", "targetId": "erp-lineas", "cardinality": "1:N", "description": "contiene" },
    { "id": "cliente-ventas", "sourceId": "dwh-dim-cliente", "targetId": "dwh-fact-ventas", "cardinality": "1:N", "description": "compra" }
  ],
  "contracts": [
    {
      "id": "contrato-ventas-360",
      "name": "Contrato de Ventas 360",
      "format": "odcs",
      "version": "1.0.0",
      "content": "apiVersion: v3.0.2\\nkind: DataContract\\nid: ventas-360\\nname: Contrato de Ventas 360\\nversion: 1.0.0\\nstatus: active\\ndomain: Ventas\\ndescription:\\n  purpose: Ventas por cliente, país y mes, listas para análisis\\nteam:\\n  name: Equipo Ventas\\nschema:\\n  - name: fact_ventas\\n    physicalType: table\\n    properties:\\n      - name: venta_key\\n        logicalType: integer\\n        physicalType: bigint\\n        primaryKey: true\\n        required: true\\n      - name: cliente_key\\n        logicalType: integer\\n        physicalType: int\\n        required: true\\n      - name: fecha\\n        logicalType: date\\n        required: true\\n      - name: importe\\n        logicalType: number\\n        physicalType: numeric\\n        required: true\\n  - name: dim_cliente\\n    physicalType: table\\n    properties:\\n      - name: cliente_key\\n        logicalType: integer\\n        physicalType: int\\n        primaryKey: true\\n        required: true\\n      - name: nombre\\n        logicalType: string\\n        required: true\\n        classification: restricted\\n        tags:\\n          - pii\\n      - name: pais\\n        logicalType: string\\n        required: true\\nslaProperties:\\n  - property: freshness\\n    value: 24\\n    unit: h\\n  - property: availability\\n    value: 99.5\\n    unit: '%'\\n"
    },
    {
      "id": "contrato-analitica-fuga",
      "name": "Contrato de Analítica de fuga",
      "format": "odcs",
      "version": "1.0.0",
      "content": "apiVersion: v3.0.2\\nkind: DataContract\\nid: analitica-fuga\\nname: Contrato de Analítica de fuga\\nversion: 1.0.0\\nstatus: active\\ndomain: Clientes\\ndescription:\\n  purpose: Probabilidad de fuga por cliente, reentrenada cada semana\\nteam:\\n  name: Ciencia de datos\\nschema:\\n  - name: modelo_fuga\\n    physicalType: table\\n    properties:\\n      - name: cliente_id\\n        logicalType: string\\n        primaryKey: true\\n        required: true\\n      - name: probabilidad_fuga\\n        logicalType: number\\n        required: true\\nslaProperties:\\n  - property: freshness\\n    value: 7\\n    unit: d\\n"
    },
    {
      "id": "contrato-api-ventas",
      "name": "Contrato de la API de ventas",
      "format": "odcs",
      "version": "1.2.0",
      "content": "apiVersion: v3.0.2\\nkind: DataContract\\nid: api-ventas\\nname: Contrato de la API de ventas\\nversion: 1.2.0\\nstatus: active\\ndomain: Ventas\\ndescription:\\n  purpose: Consulta de ventas por fecha para las aplicaciones de la empresa\\nteam:\\n  name: Equipo Ventas\\nschema:\\n  - name: ventas\\n    physicalType: object\\n    properties:\\n      - name: venta_key\\n        logicalType: integer\\n        primaryKey: true\\n        required: true\\n      - name: fecha\\n        logicalType: date\\n        required: true\\n      - name: importe\\n        logicalType: number\\n        required: true\\nslaProperties:\\n  - property: availability\\n    value: 99.9\\n    unit: '%'\\n"
    }
  ],
  "terms": [
    {
      "id": "cliente",
      "name": "Cliente",
      "definition": "Persona o empresa que ha realizado al menos una compra",
      "owner": "Equipo CRM",
      "status": "approved",
      "glossaryId": "glosario-ventas",
      "synonyms": ["comprador"],
      "links": [{ "assetId": "crm-clientes", "column": "id" }, { "assetId": "dwh-dim-cliente", "column": "cliente_key" }]
    },
    {
      "id": "venta",
      "name": "Venta",
      "definition": "Pedido confirmado y facturado",
      "owner": "Equipo Ventas",
      "status": "approved",
      "glossaryId": "glosario-ventas",
      "links": [{ "assetId": "erp-pedidos", "column": "id" }, { "assetId": "dwh-fact-ventas", "column": "venta_key" }]
    },
    {
      "id": "ingresos",
      "name": "Ingresos",
      "definition": "Importe de las ventas sin impuestos en un periodo",
      "owner": "Finanzas",
      "status": "approved",
      "glossaryId": "glosario-ventas",
      "synonyms": ["facturación"],
      "links": [{ "assetId": "dwh-fact-ventas", "column": "importe" }, { "assetId": "panel-ventas" }]
    },
    {
      "id": "fuga",
      "name": "Fuga de clientes",
      "definition": "Cliente que deja de comprar durante doce meses seguidos",
      "owner": "Ciencia de datos",
      "status": "draft",
      "glossaryId": "glosario-ventas",
      "links": [{ "assetId": "modelo-fuga" }]
    }
  ]
}
`;export{e as default};