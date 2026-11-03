var e=`{
  "version": "1.0",
  "workspace": {
    "name": "Pedidos en línea",
    "description": "Integración del flujo de pedido de una tienda"
  },
  "nodes": [
    {
      "id": "tienda-web",
      "kind": "system",
      "name": "Tienda web",
      "technology": "React",
      "owner": "Equipo Web"
    },
    {
      "id": "gateway",
      "kind": "gateway",
      "name": "API Gateway",
      "technology": "Kong",
      "owner": "Plataforma",
      "domain": "Plataforma"
    },
    {
      "id": "pedidos",
      "kind": "system",
      "name": "Servicio de pedidos",
      "technology": "Java, Spring Boot",
      "owner": "Equipo Pedidos",
      "domain": "Pedidos"
    },
    {
      "id": "pedidos-api",
      "kind": "api",
      "name": "API de pedidos",
      "parentId": "pedidos",
      "contractId": "pedidos-openapi",
      "owner": "Equipo Pedidos"
    },
    {
      "id": "kafka",
      "kind": "broker",
      "name": "Kafka",
      "owner": "Plataforma",
      "domain": "Plataforma"
    },
    {
      "id": "pedido-creado",
      "kind": "topic",
      "name": "pedido-creado",
      "parentId": "kafka",
      "contractId": "pedido-creado-ce"
    },
    {
      "id": "pedidos-db",
      "kind": "store",
      "name": "Base de pedidos",
      "technology": "PostgreSQL",
      "domain": "Pedidos"
    },
    {
      "id": "facturacion",
      "kind": "system",
      "name": "Facturación",
      "technology": ".NET",
      "owner": "Equipo Finanzas",
      "domain": "Finanzas"
    },
    {
      "id": "pasarela-pagos",
      "kind": "system",
      "name": "Pasarela de pagos",
      "external": true
    },
    {
      "id": "cliente",
      "kind": "user",
      "name": "Cliente",
      "description": "Persona que compra en la tienda"
    },
    {
      "id": "asistente",
      "kind": "system",
      "name": "Asistente de compras",
      "technology": "Agente de IA",
      "external": true
    },
    {
      "id": "pedidos-mcp",
      "kind": "mcp",
      "name": "MCP de pedidos",
      "technology": "MCP sobre HTTP",
      "parentId": "pedidos",
      "contractId": "pedidos-mcp-manifest"
    },
    {
      "id": "facturacion-api",
      "kind": "api",
      "name": "API de facturación",
      "technology": "gRPC",
      "parentId": "facturacion",
      "contractId": "facturacion-proto",
      "owner": "Equipo Finanzas"
    },
    {
      "id": "traducir-erp",
      "kind": "pattern",
      "name": "Traductor a formato ERP",
      "pattern": "message-translator",
      "domain": "Plataforma"
    },
    {
      "id": "exportador-erp",
      "kind": "connector",
      "name": "Exportador al ERP",
      "technology": "Apache Camel",
      "owner": "Equipo Finanzas",
      "domain": "Finanzas"
    },
    {
      "id": "erp",
      "kind": "system",
      "name": "ERP corporativo",
      "external": true
    },
    {
      "id": "reintento-pagos",
      "kind": "scheduler",
      "name": "Reintento de cobros",
      "technology": "cron cada 15 min",
      "owner": "Equipo Finanzas",
      "domain": "Finanzas"
    }
  ],
  "contracts": [
    {
      "id": "pedidos-openapi",
      "name": "API de pedidos",
      "format": "openapi",
      "version": "2.1.0",
      "content": "{\\n  \\"openapi\\": \\"3.0.3\\",\\n  \\"info\\": {\\n    \\"title\\": \\"API de pedidos\\",\\n    \\"version\\": \\"2.1.0\\",\\n    \\"description\\": \\"Alta y consulta de pedidos de la tienda.\\"\\n  },\\n  \\"servers\\": [\\n    {\\n      \\"url\\": \\"https://api.tienda.example/pedidos/v2\\"\\n    }\\n  ],\\n  \\"paths\\": {\\n    \\"/pedidos\\": {\\n      \\"post\\": {\\n        \\"operationId\\": \\"crearPedido\\",\\n        \\"summary\\": \\"Crea un pedido\\",\\n        \\"requestBody\\": {\\n          \\"required\\": true,\\n          \\"content\\": {\\n            \\"application/json\\": {\\n              \\"schema\\": {\\n                \\"$ref\\": \\"#/components/schemas/NuevoPedido\\"\\n              }\\n            }\\n          }\\n        },\\n        \\"responses\\": {\\n          \\"201\\": {\\n            \\"description\\": \\"Pedido creado\\",\\n            \\"content\\": {\\n              \\"application/json\\": {\\n                \\"schema\\": {\\n                  \\"$ref\\": \\"#/components/schemas/Pedido\\"\\n                }\\n              }\\n            }\\n          },\\n          \\"422\\": {\\n            \\"description\\": \\"Pedido inválido\\"\\n          }\\n        }\\n      }\\n    },\\n    \\"/pedidos/{id}\\": {\\n      \\"get\\": {\\n        \\"operationId\\": \\"consultarPedido\\",\\n        \\"summary\\": \\"Consulta un pedido\\",\\n        \\"parameters\\": [\\n          {\\n            \\"name\\": \\"id\\",\\n            \\"in\\": \\"path\\",\\n            \\"required\\": true,\\n            \\"schema\\": {\\n              \\"type\\": \\"string\\"\\n            }\\n          }\\n        ],\\n        \\"responses\\": {\\n          \\"200\\": {\\n            \\"description\\": \\"El pedido\\",\\n            \\"content\\": {\\n              \\"application/json\\": {\\n                \\"schema\\": {\\n                  \\"$ref\\": \\"#/components/schemas/Pedido\\"\\n                }\\n              }\\n            }\\n          },\\n          \\"404\\": {\\n            \\"description\\": \\"No existe\\"\\n          }\\n        }\\n      }\\n    }\\n  },\\n  \\"components\\": {\\n    \\"schemas\\": {\\n      \\"NuevoPedido\\": {\\n        \\"type\\": \\"object\\",\\n        \\"required\\": [\\n          \\"clienteId\\",\\n          \\"lineas\\"\\n        ],\\n        \\"properties\\": {\\n          \\"clienteId\\": {\\n            \\"type\\": \\"string\\"\\n          },\\n          \\"lineas\\": {\\n            \\"type\\": \\"array\\",\\n            \\"items\\": {\\n              \\"type\\": \\"object\\",\\n              \\"properties\\": {\\n                \\"sku\\": {\\n                  \\"type\\": \\"string\\"\\n                },\\n                \\"cantidad\\": {\\n                  \\"type\\": \\"integer\\",\\n                  \\"minimum\\": 1\\n                }\\n              }\\n            }\\n          }\\n        }\\n      },\\n      \\"Pedido\\": {\\n        \\"type\\": \\"object\\",\\n        \\"properties\\": {\\n          \\"id\\": {\\n            \\"type\\": \\"string\\"\\n          },\\n          \\"estado\\": {\\n            \\"type\\": \\"string\\",\\n            \\"enum\\": [\\n              \\"creado\\",\\n              \\"pagado\\",\\n              \\"enviado\\"\\n            ]\\n          },\\n          \\"total\\": {\\n            \\"type\\": \\"number\\"\\n          }\\n        }\\n      }\\n    }\\n  }\\n}"
    },
    {
      "id": "pedido-creado-avro",
      "name": "Evento PedidoCreado",
      "format": "avro",
      "version": "1.3",
      "content": "{\\n  \\"type\\": \\"record\\",\\n  \\"name\\": \\"PedidoCreado\\",\\n  \\"namespace\\": \\"com.tienda.pedidos\\",\\n  \\"fields\\": [\\n    {\\n      \\"name\\": \\"pedidoId\\",\\n      \\"type\\": \\"string\\"\\n    },\\n    {\\n      \\"name\\": \\"clienteId\\",\\n      \\"type\\": \\"string\\"\\n    },\\n    {\\n      \\"name\\": \\"total\\",\\n      \\"type\\": \\"double\\"\\n    },\\n    {\\n      \\"name\\": \\"creadoEn\\",\\n      \\"type\\": {\\n        \\"type\\": \\"long\\",\\n        \\"logicalType\\": \\"timestamp-millis\\"\\n      }\\n    }\\n  ]\\n}"
    },
    {
      "id": "pedido-creado-ce",
      "name": "Evento PedidoCreado (CloudEvents)",
      "format": "cloudevents",
      "version": "1.3",
      "description": "Estructura CloudEvents 1.0 del evento publicado en el tópico.",
      "content": "{\\n  \\"specversion\\": \\"1.0\\",\\n  \\"id\\": \\"A234-1234-1234\\",\\n  \\"source\\": \\"/pedidos\\",\\n  \\"type\\": \\"com.tienda.pedido.creado\\",\\n  \\"datacontenttype\\": \\"application/json\\",\\n  \\"dataschema\\": \\"https://schemas.tienda.example/pedido-creado/1.3\\",\\n  \\"subject\\": \\"pedido/1042\\",\\n  \\"time\\": \\"2026-03-01T10:15:30Z\\",\\n  \\"data\\": {\\n    \\"pedidoId\\": \\"1042\\",\\n    \\"clienteId\\": \\"c-77\\",\\n    \\"total\\": 129.9\\n  }\\n}"
    },
    {
      "id": "facturacion-proto",
      "name": "Servicio de facturación",
      "format": "protobuf",
      "version": "1.0.0",
      "description": "Contrato gRPC de consulta de facturas.",
      "content": "syntax = \\"proto3\\";\\n\\npackage tienda.facturacion.v1;\\n\\n// Consulta del estado de facturación de un pedido.\\nservice FacturacionService {\\n  rpc ConsultarFactura (ConsultarFacturaRequest) returns (Factura);\\n  rpc SuscribirEstados (SuscribirEstadosRequest) returns (stream EstadoFactura);\\n}\\n\\nmessage ConsultarFacturaRequest {\\n  string pedido_id = 1;\\n}\\n\\nmessage SuscribirEstadosRequest {\\n  string cliente_id = 1;\\n}\\n\\nmessage Factura {\\n  string id = 1;\\n  string pedido_id = 2;\\n  double total = 3;\\n  Estado estado = 4;\\n}\\n\\nmessage EstadoFactura {\\n  string factura_id = 1;\\n  Estado estado = 2;\\n}\\n\\nenum Estado {\\n  ESTADO_DESCONOCIDO = 0;\\n  EMITIDA = 1;\\n  COBRADA = 2;\\n  ANULADA = 3;\\n}\\n"
    },
    {
      "id": "pedidos-mcp-manifest",
      "name": "Herramientas MCP de pedidos",
      "format": "mcp",
      "version": "1.0.0",
      "description": "Lo que un agente de IA puede hacer con los pedidos.",
      "content": "{\\n  \\"name\\": \\"pedidos-mcp\\",\\n  \\"version\\": \\"1.0.0\\",\\n  \\"protocolVersion\\": \\"2025-06-18\\",\\n  \\"capabilities\\": {\\n    \\"tools\\": {},\\n    \\"resources\\": {}\\n  },\\n  \\"tools\\": [\\n    {\\n      \\"name\\": \\"consultar_pedido\\",\\n      \\"description\\": \\"Devuelve el estado de un pedido.\\",\\n      \\"inputSchema\\": {\\n        \\"type\\": \\"object\\",\\n        \\"properties\\": {\\n          \\"pedidoId\\": {\\n            \\"type\\": \\"string\\",\\n            \\"description\\": \\"Identificador del pedido\\"\\n          }\\n        },\\n        \\"required\\": [\\n          \\"pedidoId\\"\\n        ]\\n      },\\n      \\"annotations\\": {\\n        \\"readOnlyHint\\": true\\n      }\\n    },\\n    {\\n      \\"name\\": \\"crear_pedido\\",\\n      \\"description\\": \\"Crea un pedido a nombre de un cliente.\\",\\n      \\"inputSchema\\": {\\n        \\"type\\": \\"object\\",\\n        \\"properties\\": {\\n          \\"clienteId\\": {\\n            \\"type\\": \\"string\\"\\n          },\\n          \\"sku\\": {\\n            \\"type\\": \\"string\\"\\n          },\\n          \\"cantidad\\": {\\n            \\"type\\": \\"integer\\"\\n          }\\n        },\\n        \\"required\\": [\\n          \\"clienteId\\",\\n          \\"sku\\",\\n          \\"cantidad\\"\\n        ]\\n      }\\n    }\\n  ],\\n  \\"resources\\": [\\n    {\\n      \\"uri\\": \\"pedidos://catalogo\\",\\n      \\"name\\": \\"Catálogo de productos\\",\\n      \\"mimeType\\": \\"application/json\\"\\n    }\\n  ]\\n}"
    }
  ],
  "interactions": [
    {
      "id": "web-gw",
      "sourceId": "tienda-web",
      "targetId": "gateway",
      "style": "request-response",
      "protocol": "HTTPS/JSON",
      "description": "Crea el pedido",
      "order": 10
    },
    {
      "id": "gw-api",
      "sourceId": "gateway",
      "targetId": "pedidos-api",
      "style": "request-response",
      "protocol": "REST",
      "contractId": "pedidos-openapi",
      "description": "Enruta la petición",
      "order": 20
    },
    {
      "id": "pedidos-db-w",
      "sourceId": "pedidos",
      "targetId": "pedidos-db",
      "style": "request-response",
      "protocol": "JDBC",
      "description": "Guarda el pedido",
      "order": 30
    },
    {
      "id": "pedidos-topic",
      "sourceId": "pedidos",
      "targetId": "pedido-creado",
      "style": "event",
      "protocol": "Kafka",
      "contractId": "pedido-creado-avro",
      "description": "Publica PedidoCreado",
      "criticality": "high",
      "order": 40
    },
    {
      "id": "topic-fact",
      "sourceId": "pedido-creado",
      "targetId": "facturacion",
      "style": "event",
      "protocol": "Kafka",
      "contractId": "pedido-creado-avro",
      "description": "Consume PedidoCreado",
      "order": 50
    },
    {
      "id": "fact-pagos",
      "sourceId": "facturacion",
      "targetId": "pasarela-pagos",
      "style": "request-response",
      "protocol": "HTTPS",
      "description": "Cobra el pedido",
      "pattern": "circuit-breaker",
      "order": 60
    },
    {
      "id": "cliente-web",
      "sourceId": "cliente",
      "targetId": "tienda-web",
      "style": "request-response",
      "protocol": "HTTPS",
      "description": "Compra en la tienda"
    },
    {
      "id": "asistente-mcp",
      "sourceId": "asistente",
      "targetId": "pedidos-mcp",
      "style": "request-response",
      "protocol": "MCP",
      "contractId": "pedidos-mcp-manifest",
      "description": "Consulta y crea pedidos"
    },
    {
      "id": "pedidos-fact-grpc",
      "sourceId": "pedidos",
      "targetId": "facturacion-api",
      "style": "request-response",
      "protocol": "gRPC",
      "contractId": "facturacion-proto",
      "description": "Consulta la factura"
    },
    {
      "id": "topic-traductor",
      "sourceId": "pedido-creado",
      "targetId": "traducir-erp",
      "style": "event",
      "protocol": "Kafka",
      "contractId": "pedido-creado-ce",
      "description": "Consume PedidoCreado"
    },
    {
      "id": "traductor-exportador",
      "sourceId": "traducir-erp",
      "targetId": "exportador-erp",
      "style": "async-message",
      "description": "Entrega el pedido en formato ERP"
    },
    {
      "id": "exportador-erp-sftp",
      "sourceId": "exportador-erp",
      "targetId": "erp",
      "style": "batch",
      "protocol": "SFTP",
      "description": "Sube el lote de pedidos"
    },
    {
      "id": "reintento-fact",
      "sourceId": "reintento-pagos",
      "targetId": "facturacion",
      "style": "request-response",
      "protocol": "REST",
      "description": "Reintenta los cobros pendientes"
    }
  ],
  "flows": [
    {
      "id": "crear-pedido",
      "name": "Crear un pedido",
      "steps": [
        {
          "interactionId": "web-gw"
        },
        {
          "interactionId": "gw-api"
        },
        {
          "interactionId": "pedidos-db-w"
        },
        {
          "interactionId": "pedidos-topic"
        },
        {
          "interactionId": "topic-fact"
        },
        {
          "interactionId": "fact-pagos"
        }
      ]
    }
  ]
}
`;export{e as default};