var e=`{
  "version": "1.0",
  "workspace": {
    "name": "Tienda en la nube (AWS, Azure y GCP)",
    "description": "Cada recurso se dibuja con el icono del servicio de su proveedor: AWS y Azure vienen incluidos y GCP se define con un paquete propio en workspace.iconPacks",
    "currency": "EUR",
    "iconPacks": [
      {
        "id": "gcp-propio",
        "name": "Google Cloud",
        "provider": "gcp",
        "color": "#1a73e8",
        "aliases": [
          "google cloud",
          "google cloud platform"
        ],
        "icons": {
          "gke": {
            "label": "Google Kubernetes Engine",
            "paths": [
              "M8 1.5l5.5 3.2v6.6L8 14.5l-5.5-3.2V4.7z",
              "M5.5 6.2h5 M5.5 9.8h5 M8 4.7v6.6"
            ],
            "kinds": [
              "cluster"
            ],
            "keywords": [
              "gke",
              "kubernetes",
              "k8s"
            ]
          },
          "cloud-sql": {
            "label": "Cloud SQL",
            "paths": [
              "M3 4c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2z",
              "M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4",
              "M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"
            ],
            "kinds": [
              "database"
            ],
            "keywords": [
              "cloud sql",
              "postgres",
              "postgresql",
              "mysql"
            ]
          },
          "pubsub": {
            "label": "Pub/Sub",
            "paths": [
              "M8 6.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z",
              "M9.4 7.2L12.6 4.4 M9.6 8h3.8 M9.4 8.8l3.2 2.8",
              "M13.6 3.4h.02 M14.4 8h.02 M13.6 12.6h.02",
              "M2 8h4.4"
            ],
            "kinds": [
              "queue"
            ],
            "keywords": [
              "pubsub",
              "pub/sub"
            ]
          }
        }
      }
    ]
  },
  "environments": [
    {
      "id": "aws-prod",
      "name": "Producción (AWS)",
      "kind": "prod",
      "provider": "AWS",
      "region": "eu-west-1"
    },
    {
      "id": "azure-dr",
      "name": "Recuperación (Azure)",
      "kind": "dr",
      "provider": "Azure",
      "region": "westeurope"
    },
    {
      "id": "gcp-analitica",
      "name": "Analítica (GCP)",
      "provider": "GCP",
      "region": "europe-west1"
    }
  ],
  "networks": [
    {
      "id": "vpc-prod",
      "name": "VPC producción",
      "environmentId": "aws-prod",
      "exposure": "private",
      "cidr": "10.0.0.0/16",
      "provider": "aws"
    },
    {
      "id": "subred-publica",
      "name": "Subred pública",
      "environmentId": "aws-prod",
      "parentId": "vpc-prod",
      "exposure": "public",
      "cidr": "10.0.0.0/24"
    },
    {
      "id": "subred-apps",
      "name": "Subred de aplicaciones",
      "environmentId": "aws-prod",
      "parentId": "vpc-prod",
      "exposure": "private",
      "cidr": "10.0.10.0/24"
    },
    {
      "id": "subred-datos",
      "name": "Subred de datos",
      "environmentId": "aws-prod",
      "parentId": "vpc-prod",
      "exposure": "isolated",
      "cidr": "10.0.20.0/24"
    },
    {
      "id": "vnet-dr",
      "name": "Red virtual de recuperación",
      "environmentId": "azure-dr",
      "exposure": "private",
      "cidr": "10.1.0.0/16",
      "provider": "azure",
      "service": "virtual-network"
    }
  ],
  "resources": [
    {
      "id": "dns-prod",
      "name": "Route 53 · tienda.example.com",
      "kind": "dns",
      "environmentId": "aws-prod",
      "provider": "aws",
      "service": "route53"
    },
    {
      "id": "cdn-prod",
      "name": "CloudFront",
      "kind": "other",
      "environmentId": "aws-prod",
      "technology": "CloudFront",
      "provider": "aws"
    },
    {
      "id": "apigw-prod",
      "name": "API pública",
      "kind": "gateway",
      "environmentId": "aws-prod",
      "networkId": "subred-publica",
      "provider": "aws"
    },
    {
      "id": "alb-prod",
      "name": "Balanceador público",
      "kind": "load-balancer",
      "environmentId": "aws-prod",
      "networkId": "subred-publica",
      "technology": "AWS ALB",
      "provider": "aws"
    },
    {
      "id": "eks-prod",
      "name": "eks-prod",
      "kind": "cluster",
      "environmentId": "aws-prod",
      "networkId": "subred-apps",
      "technology": "Kubernetes",
      "version": "1.29",
      "provider": "aws"
    },
    {
      "id": "ecr-prod",
      "name": "Registro de imágenes",
      "kind": "registry",
      "environmentId": "aws-prod",
      "technology": "ECR",
      "provider": "aws"
    },
    {
      "id": "rds-pedidos",
      "name": "Pedidos DB",
      "kind": "database",
      "environmentId": "aws-prod",
      "networkId": "subred-datos",
      "technology": "PostgreSQL",
      "version": "15",
      "provider": "aws"
    },
    {
      "id": "cache-prod",
      "name": "Caché de sesiones",
      "kind": "cache",
      "environmentId": "aws-prod",
      "networkId": "subred-datos",
      "technology": "Redis",
      "version": "7",
      "provider": "aws"
    },
    {
      "id": "sqs-pedidos",
      "name": "Cola de pedidos",
      "kind": "queue",
      "environmentId": "aws-prod",
      "networkId": "subred-datos",
      "provider": "aws",
      "service": "sqs"
    },
    {
      "id": "s3-facturas",
      "name": "Facturas (S3)",
      "kind": "storage",
      "environmentId": "aws-prod",
      "provider": "aws"
    },
    {
      "id": "secretos-prod",
      "name": "Secretos",
      "kind": "secret-store",
      "environmentId": "aws-prod",
      "provider": "aws",
      "service": "secrets-manager"
    },
    {
      "id": "agw-dr",
      "name": "Application Gateway",
      "kind": "load-balancer",
      "environmentId": "azure-dr",
      "technology": "Application Gateway",
      "provider": "azure"
    },
    {
      "id": "apim-dr",
      "name": "API pública (DR)",
      "kind": "gateway",
      "environmentId": "azure-dr",
      "technology": "API Management",
      "provider": "azure"
    },
    {
      "id": "aks-dr",
      "name": "aks-dr",
      "kind": "cluster",
      "environmentId": "azure-dr",
      "technology": "Kubernetes",
      "version": "1.29",
      "provider": "azure"
    },
    {
      "id": "acr-dr",
      "name": "Registro de imágenes (DR)",
      "kind": "registry",
      "environmentId": "azure-dr",
      "provider": "azure"
    },
    {
      "id": "sql-dr",
      "name": "Pedidos DB (DR)",
      "kind": "database",
      "environmentId": "azure-dr",
      "technology": "Azure SQL",
      "provider": "azure"
    },
    {
      "id": "redis-dr",
      "name": "Caché de sesiones (DR)",
      "kind": "cache",
      "environmentId": "azure-dr",
      "technology": "Redis",
      "provider": "azure"
    },
    {
      "id": "bus-dr",
      "name": "Bus de pedidos",
      "kind": "queue",
      "environmentId": "azure-dr",
      "technology": "Service Bus",
      "provider": "azure"
    },
    {
      "id": "blob-dr",
      "name": "Facturas (Blob)",
      "kind": "storage",
      "environmentId": "azure-dr",
      "provider": "azure"
    },
    {
      "id": "kv-dr",
      "name": "Bóveda de claves",
      "kind": "secret-store",
      "environmentId": "azure-dr",
      "provider": "azure"
    },
    {
      "id": "dns-dr",
      "name": "Azure DNS",
      "kind": "dns",
      "environmentId": "azure-dr",
      "provider": "azure"
    },
    {
      "id": "func-dr",
      "name": "Notificaciones (Functions)",
      "kind": "other",
      "environmentId": "azure-dr",
      "technology": "Azure Functions",
      "provider": "azure"
    },
    {
      "id": "gke-analitica",
      "name": "gke-analitica",
      "kind": "cluster",
      "environmentId": "gcp-analitica",
      "technology": "Kubernetes",
      "version": "1.29",
      "provider": "gcp"
    },
    {
      "id": "sql-analitica",
      "name": "Almacén analítico",
      "kind": "database",
      "environmentId": "gcp-analitica",
      "technology": "PostgreSQL",
      "version": "15",
      "provider": "gcp"
    },
    {
      "id": "pubsub-analitica",
      "name": "Eventos de pedidos",
      "kind": "queue",
      "environmentId": "gcp-analitica",
      "provider": "gcp"
    }
  ],
  "services": [
    {
      "id": "tienda-web",
      "name": "Tienda web",
      "kind": "frontend",
      "technology": "React",
      "owner": "Equipo web",
      "criticality": "high"
    },
    {
      "id": "pedidos",
      "name": "Servicio de pedidos",
      "technology": "Java, Spring Boot",
      "owner": "Equipo pedidos",
      "criticality": "critical"
    },
    {
      "id": "facturacion",
      "name": "Facturación",
      "technology": ".NET",
      "owner": "Equipo finanzas",
      "criticality": "high"
    },
    {
      "id": "notificaciones",
      "name": "Notificaciones",
      "kind": "worker",
      "technology": "Node.js",
      "owner": "Equipo pedidos"
    },
    {
      "id": "reportes",
      "name": "Reportes nocturnos",
      "kind": "job",
      "technology": "Python",
      "owner": "Equipo datos"
    }
  ],
  "deployments": [
    {
      "id": "tienda-web-prod",
      "serviceId": "tienda-web",
      "environmentId": "aws-prod",
      "hostId": "eks-prod",
      "replicas": 3,
      "version": "2.4.0"
    },
    {
      "id": "pedidos-prod",
      "serviceId": "pedidos",
      "environmentId": "aws-prod",
      "hostId": "eks-prod",
      "replicas": 4,
      "version": "3.1.0"
    },
    {
      "id": "facturacion-prod",
      "serviceId": "facturacion",
      "environmentId": "aws-prod",
      "hostId": "eks-prod",
      "replicas": 2,
      "version": "1.8.0"
    },
    {
      "id": "notificaciones-prod",
      "serviceId": "notificaciones",
      "environmentId": "aws-prod",
      "hostId": "eks-prod",
      "replicas": 2,
      "version": "0.9.0"
    },
    {
      "id": "pedidos-dr",
      "serviceId": "pedidos",
      "environmentId": "azure-dr",
      "hostId": "aks-dr",
      "replicas": 2,
      "version": "3.1.0"
    },
    {
      "id": "facturacion-dr",
      "serviceId": "facturacion",
      "environmentId": "azure-dr",
      "hostId": "aks-dr",
      "replicas": 2,
      "version": "1.8.0"
    },
    {
      "id": "reportes-analitica",
      "serviceId": "reportes",
      "environmentId": "gcp-analitica",
      "hostId": "gke-analitica",
      "replicas": 1,
      "version": "0.4.0"
    }
  ],
  "dependencies": [
    {
      "id": "web-pedidos",
      "sourceId": "tienda-web",
      "targetId": "pedidos",
      "kind": "calls",
      "protocol": "HTTPS",
      "description": "crea pedidos"
    },
    {
      "id": "pedidos-db",
      "sourceId": "pedidos",
      "targetId": "rds-pedidos",
      "kind": "data",
      "protocol": "PostgreSQL"
    },
    {
      "id": "pedidos-cache",
      "sourceId": "pedidos",
      "targetId": "cache-prod",
      "kind": "data",
      "protocol": "Redis"
    },
    {
      "id": "pedidos-cola",
      "sourceId": "pedidos",
      "targetId": "sqs-pedidos",
      "kind": "messages",
      "description": "publica pedidos"
    },
    {
      "id": "notificaciones-cola",
      "sourceId": "notificaciones",
      "targetId": "sqs-pedidos",
      "kind": "messages",
      "description": "consume pedidos"
    },
    {
      "id": "facturacion-s3",
      "sourceId": "facturacion",
      "targetId": "s3-facturas",
      "kind": "data",
      "protocol": "S3"
    },
    {
      "id": "facturacion-secretos",
      "sourceId": "facturacion",
      "targetId": "secretos-prod",
      "kind": "data"
    },
    {
      "id": "pedidos-dr-db",
      "sourceId": "pedidos",
      "targetId": "sql-dr",
      "kind": "data",
      "protocol": "TDS"
    },
    {
      "id": "pedidos-dr-bus",
      "sourceId": "pedidos",
      "targetId": "bus-dr",
      "kind": "messages"
    },
    {
      "id": "facturacion-dr-blob",
      "sourceId": "facturacion",
      "targetId": "blob-dr",
      "kind": "data"
    },
    {
      "id": "pedidos-dr-cache",
      "sourceId": "pedidos",
      "targetId": "redis-dr",
      "kind": "data",
      "protocol": "Redis"
    },
    {
      "id": "facturacion-dr-kv",
      "sourceId": "facturacion",
      "targetId": "kv-dr",
      "kind": "data"
    },
    {
      "id": "reportes-analitica-pubsub",
      "sourceId": "reportes",
      "targetId": "pubsub-analitica",
      "kind": "messages"
    },
    {
      "id": "reportes-analitica-db",
      "sourceId": "reportes",
      "targetId": "sql-analitica",
      "kind": "data",
      "protocol": "PostgreSQL"
    }
  ],
  "pipelines": []
}
`;export{e as default};