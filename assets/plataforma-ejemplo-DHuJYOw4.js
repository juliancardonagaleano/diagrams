var e=`{
  "version": "1.0",
  "workspace": { "name": "Plataforma de pedidos en línea", "description": "Entornos, redes y despliegues de la tienda: desarrollo y producción en Kubernetes" },
  "environments": [
    { "id": "dev", "name": "Desarrollo", "kind": "dev", "provider": "AWS", "region": "eu-west-1" },
    { "id": "prod", "name": "Producción", "kind": "prod", "provider": "AWS", "region": "eu-west-1" }
  ],
  "networks": [
    { "id": "vpc-prod", "name": "VPC producción", "environmentId": "prod", "exposure": "private", "cidr": "10.10.0.0/16" },
    { "id": "subred-publica", "name": "Subred pública", "environmentId": "prod", "parentId": "vpc-prod", "exposure": "public", "cidr": "10.10.0.0/24" },
    { "id": "subred-apps", "name": "Subred de aplicaciones", "environmentId": "prod", "parentId": "vpc-prod", "exposure": "private", "cidr": "10.10.1.0/24" },
    { "id": "subred-datos", "name": "Subred de datos", "environmentId": "prod", "parentId": "vpc-prod", "exposure": "isolated", "cidr": "10.10.2.0/24" },
    { "id": "vpc-dev", "name": "VPC desarrollo", "environmentId": "dev", "exposure": "private", "cidr": "10.20.0.0/16" }
  ],
  "resources": [
    { "id": "k8s-dev", "name": "k8s-dev", "kind": "cluster", "environmentId": "dev", "networkId": "vpc-dev", "technology": "Kubernetes", "version": "1.29", "iac": true, "owner": "Plataforma", "monthlyCost": 420, "cpuLimit": "16", "memoryLimit": "64 GiB" },
    { "id": "pedidos-db-dev", "name": "Base de pedidos (dev)", "kind": "database", "environmentId": "dev", "networkId": "vpc-dev", "technology": "PostgreSQL", "version": "15", "iac": true, "owner": "Plataforma", "monthlyCost": 90 },
    { "id": "kafka-dev", "name": "Kafka (dev)", "kind": "queue", "environmentId": "dev", "networkId": "vpc-dev", "technology": "Kafka", "iac": true, "owner": "Plataforma", "monthlyCost": 150 },
    { "id": "lb-prod", "name": "Balanceador público", "kind": "load-balancer", "environmentId": "prod", "networkId": "subred-publica", "technology": "AWS ALB", "iac": true, "owner": "Plataforma", "monthlyCost": 60 },
    { "id": "k8s-prod", "name": "k8s-prod", "kind": "cluster", "environmentId": "prod", "networkId": "subred-apps", "technology": "Kubernetes", "version": "1.29", "iac": true, "owner": "Plataforma", "monthlyCost": 1850, "region": "eu-west-1", "cpuLimit": "64", "memoryLimit": "256 GiB" },
    { "id": "kafka-prod", "name": "Kafka (prod)", "kind": "queue", "environmentId": "prod", "networkId": "subred-apps", "technology": "Kafka", "iac": true, "owner": "Plataforma", "ref": "urn:iark:integration:kafka", "refType": "deploys", "monthlyCost": 780 },
    { "id": "pedidos-db-prod", "name": "Base de pedidos", "kind": "database", "environmentId": "prod", "networkId": "subred-datos", "technology": "PostgreSQL", "version": "15", "iac": true, "owner": "Plataforma", "ref": "urn:iark:integration:pedidos-db", "refType": "deploys", "monthlyCost": 1240, "cpuLimit": "16", "memoryLimit": "128 GiB" }
  ],
  "services": [
    { "id": "tienda-web", "name": "Tienda web", "kind": "frontend", "technology": "React", "owner": "Equipo Web", "repo": "tienda/web", "criticality": "high", "ref": "urn:iark:integration:tienda-web", "refType": "implements", "slo": "99,9 %" },
    { "id": "pedidos", "name": "Servicio de pedidos", "technology": "Java, Spring Boot", "owner": "Equipo Pedidos", "repo": "tienda/pedidos", "criticality": "critical", "ref": "urn:iark:integration:pedidos", "refType": "implements", "slo": "99,95 %", "sla": "99,9 %" },
    { "id": "facturacion", "name": "Facturación", "technology": ".NET", "owner": "Equipo Finanzas", "repo": "tienda/facturacion", "criticality": "high", "ref": "urn:iark:integration:facturacion", "refType": "implements" },
    { "id": "notificaciones", "name": "Notificaciones", "kind": "worker", "technology": "Node.js", "owner": "Equipo Web", "repo": "tienda/notificaciones", "criticality": "medium" },
    { "id": "reportes", "name": "Reportes nocturnos", "kind": "job", "technology": "Python", "owner": "Equipo Pedidos", "repo": "tienda/reportes", "criticality": "low" },
    { "id": "pasarela-pagos", "name": "Pasarela de pagos", "external": true, "criticality": "high", "ref": "urn:iark:integration:pasarela-pagos", "refType": "implements" }
  ],
  "deployments": [
    { "id": "tienda-web-dev", "serviceId": "tienda-web", "environmentId": "dev", "hostId": "k8s-dev", "replicas": 1, "version": "2.4.0" },
    { "id": "pedidos-dev", "serviceId": "pedidos", "environmentId": "dev", "hostId": "k8s-dev", "replicas": 1, "version": "3.1.0" },
    { "id": "facturacion-dev", "serviceId": "facturacion", "environmentId": "dev", "hostId": "k8s-dev", "replicas": 1, "version": "1.8.0" },
    { "id": "notificaciones-dev", "serviceId": "notificaciones", "environmentId": "dev", "hostId": "k8s-dev", "replicas": 1, "version": "0.9.0" },
    { "id": "reportes-dev", "serviceId": "reportes", "environmentId": "dev", "hostId": "k8s-dev", "version": "0.4.0" },
    { "id": "tienda-web-prod", "serviceId": "tienda-web", "environmentId": "prod", "hostId": "k8s-prod", "replicas": 2, "version": "2.3.1", "monthlyCost": 180, "cpuLimit": "1", "memoryLimit": "2 GiB" },
    { "id": "pedidos-prod", "serviceId": "pedidos", "environmentId": "prod", "hostId": "k8s-prod", "replicas": 3, "version": "3.0.2", "monthlyCost": 310, "cpuLimit": "2", "memoryLimit": "4 GiB" },
    { "id": "facturacion-prod", "serviceId": "facturacion", "environmentId": "prod", "hostId": "k8s-prod", "replicas": 2, "version": "1.7.4" },
    { "id": "notificaciones-prod", "serviceId": "notificaciones", "environmentId": "prod", "hostId": "k8s-prod", "replicas": 1, "version": "0.9.0" },
    { "id": "reportes-prod", "serviceId": "reportes", "environmentId": "prod", "hostId": "k8s-prod", "version": "0.3.5" }
  ],
  "dependencies": [
    { "id": "lb-web", "sourceId": "lb-prod", "targetId": "tienda-web", "kind": "calls", "protocol": "HTTPS", "description": "Reparte el tráfico" },
    { "id": "web-pedidos", "sourceId": "tienda-web", "targetId": "pedidos", "kind": "calls", "protocol": "REST", "description": "Crea el pedido" },
    { "id": "pedidos-db-d", "sourceId": "pedidos", "targetId": "pedidos-db-dev", "kind": "data", "protocol": "JDBC" },
    { "id": "pedidos-db-p", "sourceId": "pedidos", "targetId": "pedidos-db-prod", "kind": "data", "protocol": "JDBC" },
    { "id": "pedidos-kafka-d", "sourceId": "pedidos", "targetId": "kafka-dev", "kind": "messages", "protocol": "Kafka", "description": "Publica PedidoCreado" },
    { "id": "pedidos-kafka-p", "sourceId": "pedidos", "targetId": "kafka-prod", "kind": "messages", "protocol": "Kafka", "description": "Publica PedidoCreado" },
    { "id": "fact-kafka-d", "sourceId": "facturacion", "targetId": "kafka-dev", "kind": "messages", "protocol": "Kafka", "description": "Consume PedidoCreado" },
    { "id": "fact-kafka-p", "sourceId": "facturacion", "targetId": "kafka-prod", "kind": "messages", "protocol": "Kafka", "description": "Consume PedidoCreado" },
    { "id": "fact-pagos", "sourceId": "facturacion", "targetId": "pasarela-pagos", "kind": "calls", "protocol": "HTTPS", "description": "Cobra el pedido" },
    { "id": "notif-kafka-d", "sourceId": "notificaciones", "targetId": "kafka-dev", "kind": "messages", "protocol": "Kafka" },
    { "id": "notif-kafka-p", "sourceId": "notificaciones", "targetId": "kafka-prod", "kind": "messages", "protocol": "Kafka" },
    { "id": "reportes-db-d", "sourceId": "reportes", "targetId": "pedidos-db-dev", "kind": "data", "protocol": "JDBC" },
    { "id": "reportes-db-p", "sourceId": "reportes", "targetId": "pedidos-db-prod", "kind": "data", "protocol": "JDBC" }
  ],
  "pipelines": [
    {
      "id": "entrega-servicios",
      "name": "Entrega de servicios",
      "kind": "ci-cd",
      "tool": "GitLab CI",
      "owner": "Plataforma",
      "serviceIds": ["tienda-web", "pedidos", "facturacion", "notificaciones", "reportes"],
      "stages": [{ "environmentId": "dev" }, { "environmentId": "prod", "approval": true }]
    },
    {
      "id": "infraestructura",
      "name": "Infraestructura",
      "kind": "iac",
      "tool": "Terraform",
      "owner": "Plataforma",
      "serviceIds": [],
      "provisions": ["k8s-dev", "pedidos-db-dev", "kafka-dev", "lb-prod", "k8s-prod", "kafka-prod", "pedidos-db-prod"],
      "stages": [{ "environmentId": "dev" }, { "environmentId": "prod", "approval": true }]
    }
  ]
}
`;export{e as default};