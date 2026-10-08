import type { IconPack } from './types';

/**
 * Glifos propios de los servicios de AWS: dibujos sencillos hechos para este proyecto que evocan lo que hace cada servicio
 * (una cubeta, un cilindro, una cola…). NO son los logotipos oficiales de Amazon, que son propietarios: quien tenga licencia
 * para usarlos puede registrar un paquete con ellos del proveedor `aws` y sustituirá a estos (ver docs/modulos/plataforma.md, «Iconografía de nubes»).
 */
const CYLINDER = ['M3 4c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2z', 'M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4', 'M3 8c0 1.1 2.2 2 5 2s5-.9 5-2'];

export const awsIconPack: IconPack = {
  id: 'aws',
  name: 'Amazon Web Services',
  provider: 'aws',
  color: '#ec7211',
  aliases: ['amazon', 'amazon web services'],
  icons: {
    ec2: {
      label: 'Amazon EC2',
      paths: ['M4.5 4.5h7v7h-7z', 'M6.5 2v2.5 M9.5 2v2.5 M6.5 11.5V14 M9.5 11.5V14', 'M2 6.5h2.5 M2 9.5h2.5 M11.5 6.5H14 M11.5 9.5H14'],
      kinds: ['vm'],
      keywords: ['ec2'],
    },
    eks: {
      label: 'Amazon EKS',
      paths: ['M8 1.5l5.5 3.2v6.6L8 14.5l-5.5-3.2V4.7z', 'M8 5.6l2.3 4H5.7z'],
      kinds: ['cluster'],
      keywords: ['eks', 'kubernetes', 'k8s'],
    },
    ecs: {
      label: 'Amazon ECS',
      paths: ['M2.5 2.5h11v11h-11z', 'M5 5h2.2v2.2H5z M8.8 5H11v2.2H8.8z M5 8.8h2.2V11H5z M8.8 8.8H11V11H8.8z'],
      kinds: ['cluster'],
      keywords: ['ecs'],
    },
    fargate: {
      label: 'AWS Fargate',
      paths: ['M1.5 5V1.5H5 M11 1.5h3.5V5 M14.5 11v3.5H11 M5 14.5H1.5V11', 'M5 5h2.2v2.2H5z M8.8 5H11v2.2H8.8z M5 8.8h2.2V11H5z M8.8 8.8H11V11H8.8z'],
      kinds: ['cluster'],
      keywords: ['fargate'],
    },
    lambda: {
      label: 'AWS Lambda',
      paths: [
        'M6 2.5C4.4 2.5 4.2 3.6 4.2 4.8v1.2c0 1.2-.5 2-1.7 2 1.2 0 1.7.8 1.7 2v1.2c0 1.2.2 2.3 1.8 2.3',
        'M10 2.5c1.6 0 1.8 1.1 1.8 2.3v1.2c0 1.2.5 2 1.7 2-1.2 0-1.7.8-1.7 2v1.2c0 1.2-.2 2.3-1.8 2.3',
      ],
      kinds: ['other'],
      keywords: ['lambda'],
    },
    s3: {
      label: 'Amazon S3',
      paths: ['M3 4.5c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2z', 'M3 4.5l1.2 8c.2 1 1.9 1.7 3.8 1.7s3.6-.7 3.8-1.7l1.2-8'],
      kinds: ['storage'],
      keywords: ['s3'],
    },
    rds: {
      label: 'Amazon RDS',
      paths: CYLINDER,
      kinds: ['database'],
      keywords: ['rds', 'aurora', 'postgres', 'postgresql', 'mysql', 'mariadb', 'oracle', 'sql server', 'sqlserver'],
    },
    dynamodb: {
      label: 'Amazon DynamoDB',
      paths: ['M2 3h12v10H2z', 'M2 6.4h12 M2 9.6h12', 'M6 3v10'],
      kinds: ['database'],
      keywords: ['dynamodb', 'dynamo'],
    },
    elasticache: {
      label: 'Amazon ElastiCache',
      paths: ['M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M8.8 4.2L5.6 8.4h2.6l-.8 3.4 3.2-4.2H8z'],
      kinds: ['cache'],
      keywords: ['elasticache', 'redis', 'memcached', 'valkey'],
    },
    sqs: {
      label: 'Amazon SQS',
      paths: ['M2 3.5h3.4v5H2z M6.3 3.5h3.4v5H6.3z M10.6 3.5H14v5h-3.4z', 'M2 12h11 M11 10l2 2-2 2'],
      kinds: ['queue'],
      keywords: ['sqs'],
    },
    sns: {
      label: 'Amazon SNS',
      paths: ['M8 2.5C5.6 2.5 4.5 4.4 4.5 6.8v2.6L3 11.5h10l-1.5-2.1V6.8C11.5 4.4 10.4 2.5 8 2.5z', 'M6.4 13.2a1.7 1.7 0 0 0 3.2 0'],
      kinds: ['queue'],
      keywords: ['sns'],
    },
    elb: {
      label: 'Elastic Load Balancing',
      paths: ['M1.5 6.8h3v2.4h-3z', 'M4.5 8h3 M7.5 3.5v9', 'M7.5 3.5h2 M7.5 8h2 M7.5 12.5h2', 'M11.5 3.5h.02 M11.5 8h.02 M11.5 12.5h.02 M14 3.5h.02 M14 8h.02 M14 12.5h.02'],
      kinds: ['load-balancer'],
      keywords: ['elb', 'nlb', 'clb', 'gwlb', 'network load balancer', 'classic load balancer', 'gateway load balancer'],
    },
    alb: {
      label: 'Application Load Balancer',
      paths: ['M1.5 6.8h3v2.4h-3z', 'M4.5 8h3 M7.5 3.5v9', 'M7.5 3.5h2 M7.5 8h2 M7.5 12.5h2', 'M9.5 2.4h5v2.2h-5z M9.5 6.9h5v2.2h-5z M9.5 11.4h5v2.2h-5z'],
      kinds: ['load-balancer'],
      keywords: ['alb', 'application load balancer'],
    },
    'api-gateway': {
      label: 'Amazon API Gateway',
      paths: ['M5 4.5L1.5 8 5 11.5', 'M11 4.5L14.5 8 11 11.5', 'M9 3.5l-2 9'],
      kinds: ['gateway'],
      keywords: ['api gateway', 'apigw'],
    },
    route53: {
      label: 'Amazon Route 53',
      paths: ['M8 1.5v13', 'M3 3.5h7.5l2 2-2 2H3z', 'M13 9H5.5l-2 2 2 2H13z'],
      kinds: ['dns'],
      keywords: ['route 53', 'route53'],
    },
    cloudfront: {
      label: 'Amazon CloudFront',
      paths: ['M8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z', 'M8 6.2V3.5 M8 9.8v2.7 M6.2 8H3.5 M9.8 8h2.7', 'M8 2h.02 M8 14h.02 M2 8h.02 M14 8h.02'],
      kinds: ['other'],
      keywords: ['cloudfront', 'cdn'],
    },
    'secrets-manager': {
      label: 'AWS Secrets Manager',
      paths: ['M5.2 3a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4z', 'M7.2 7.2l6.3 6.3', 'M11 11l1.7-1.7 M12.7 12.7l1.3-1.3'],
      kinds: ['secret-store'],
      keywords: ['secrets manager', 'secretsmanager'],
    },
    ecr: {
      label: 'Amazon ECR',
      paths: ['M8 1.5l5.5 3v7l-5.5 3-5.5-3v-7z', 'M2.5 4.5L8 7.5l5.5-3', 'M8 7.5v7'],
      kinds: ['registry'],
      keywords: ['ecr'],
    },
    vpc: {
      label: 'Amazon VPC',
      paths: ['M1.5 5V1.5H5 M11 1.5h3.5V5 M14.5 11v3.5H11 M5 14.5H1.5V11', 'M8 5.5v2.4 M8 7.9L5.5 10 M8 7.9L10.5 10', 'M6.8 3.6h2.4v1.9H6.8z M4.3 10h2.4v1.9H4.3z M9.3 10h2.4v1.9H9.3z'],
      kinds: ['network'],
      keywords: ['vpc'],
    },
  },
};
