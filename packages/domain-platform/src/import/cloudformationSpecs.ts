/**
 * Tabla de tipos de CloudFormation que se importan (`AWS::…`, también los de SAM) y su correspondencia con el modelo de plataforma.
 * Lo que no está aquí se avisa agrupado: los tipos de soporte (permisos, tablas de rutas, grupos de seguridad…) se consultan para
 * deducir redes y dependencias y no se dibujan; el resto, los tipos sin mapear, ni se dibuja ni se consulta.
 */
import type { ResourceKind } from '../types';
import type { Json } from './yamlText';

export type CfnKind = ResourceKind | 'network' | 'service';

/** Consulta de las propiedades de un recurso con lo que se pueda evaluar (literales, parámetros con valor por defecto). */
export interface CfnQuery {
  str(path: string): string | undefined;
  num(path: string): number | undefined;
  bool(path: string): boolean | undefined;
  /** Valor sin evaluar en una ruta (`Environment.Variables`). */
  at(path: string): unknown;
  props: Json;
}

export interface CfnSpec {
  kind: CfnKind;
  /** Red que contiene subredes (la VPC). */
  container?: boolean;
  technology?: string | ((q: CfnQuery) => string | undefined);
  version?: (q: CfnQuery) => string | undefined;
  /** Datos que se añaden a la descripción (`Multi-AZ`, `interno`…). */
  extra?: (q: CfnQuery) => string[];
}

const ENGINES: Record<string, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  aurora: 'Aurora MySQL',
  'aurora-mysql': 'Aurora MySQL',
  'aurora-postgresql': 'Aurora PostgreSQL',
  oracle: 'Oracle',
  sqlserver: 'SQL Server',
  redis: 'Redis',
  memcached: 'Memcached',
  valkey: 'Valkey',
  docdb: 'DocumentDB',
  neptune: 'Neptune',
};

/** Nombre comercial de un motor de base de datos (`postgres` → `PostgreSQL`, `oracle-ee` → `Oracle`); el motor tal cual si no se conoce. */
export function engineName(engine: string | undefined): string | undefined {
  if (!engine) return undefined;
  const key = engine.toLowerCase();
  const hit = Object.keys(ENGINES)
    .sort((a, b) => b.length - a.length)
    .find((k) => key === k || key.startsWith(`${k}-`));
  return hit ? ENGINES[hit] : engine;
}

const join = (...parts: Array<string | undefined>): string | undefined => {
  const text = parts.filter(Boolean).join(' ');
  return text || undefined;
};
const flag = (q: CfnQuery, path: string, text: string): string[] => (q.bool(path) === true ? [text] : []);

const rds = (q: CfnQuery): string => {
  const engine = engineName(q.str('Engine'));
  return engine?.startsWith('Aurora') ? `Amazon ${engine}` : join('Amazon RDS', engine)!;
};

export const SPECS: Record<string, CfnSpec> = {
  'AWS::EC2::VPC': { kind: 'network', container: true },
  'AWS::EC2::Subnet': { kind: 'network' },
  'AWS::EKS::Cluster': { kind: 'cluster', technology: 'Amazon EKS', version: (q) => q.str('Version') },
  'AWS::ECS::Cluster': { kind: 'cluster', technology: 'Amazon ECS' },
  'AWS::ECS::Service': { kind: 'service' },
  'AWS::EC2::Instance': { kind: 'vm', technology: (q) => join('Amazon EC2', q.str('InstanceType')), extra: (q) => flag(q, 'NetworkInterfaces.0.AssociatePublicIpAddress', 'IP pública') },
  'AWS::AutoScaling::AutoScalingGroup': { kind: 'vm', technology: 'Amazon EC2 Auto Scaling', extra: (q) => [q.str('MinSize') && q.str('MaxSize') ? `${q.str('MinSize')}–${q.str('MaxSize')} instancias` : ''].filter(Boolean) },
  'AWS::RDS::DBInstance': { kind: 'database', technology: rds, version: (q) => q.str('EngineVersion'), extra: (q) => [...flag(q, 'MultiAZ', 'Multi-AZ'), ...(q.str('DBInstanceClass') ? [q.str('DBInstanceClass')!] : [])] },
  'AWS::RDS::DBCluster': { kind: 'database', technology: rds, version: (q) => q.str('EngineVersion') },
  'AWS::DynamoDB::Table': { kind: 'database', technology: 'Amazon DynamoDB' },
  'AWS::DynamoDB::GlobalTable': { kind: 'database', technology: 'Amazon DynamoDB' },
  'AWS::Serverless::SimpleTable': { kind: 'database', technology: 'Amazon DynamoDB' },
  'AWS::DocDB::DBCluster': { kind: 'database', technology: 'Amazon DocumentDB', version: (q) => q.str('EngineVersion') },
  'AWS::Neptune::DBCluster': { kind: 'database', technology: 'Amazon Neptune', version: (q) => q.str('EngineVersion') },
  'AWS::Redshift::Cluster': { kind: 'database', technology: 'Amazon Redshift' },
  'AWS::OpenSearchService::Domain': { kind: 'database', technology: 'Amazon OpenSearch', version: (q) => q.str('EngineVersion') },
  'AWS::Elasticsearch::Domain': { kind: 'database', technology: 'Amazon OpenSearch', version: (q) => q.str('ElasticsearchVersion') },
  'AWS::ElastiCache::CacheCluster': { kind: 'cache', technology: (q) => join('Amazon ElastiCache', engineName(q.str('Engine'))), version: (q) => q.str('EngineVersion') },
  'AWS::ElastiCache::ReplicationGroup': { kind: 'cache', technology: (q) => join('Amazon ElastiCache', engineName(q.str('Engine')) ?? 'Redis'), version: (q) => q.str('EngineVersion') },
  'AWS::MemoryDB::Cluster': { kind: 'cache', technology: 'Amazon MemoryDB', version: (q) => q.str('EngineVersion') },
  'AWS::DAX::Cluster': { kind: 'cache', technology: 'Amazon DAX' },
  'AWS::SQS::Queue': { kind: 'queue', technology: (q) => (q.bool('FifoQueue') ? 'Amazon SQS FIFO' : 'Amazon SQS') },
  'AWS::SNS::Topic': { kind: 'queue', technology: 'Amazon SNS' },
  'AWS::AmazonMQ::Broker': { kind: 'queue', technology: (q) => join('Amazon MQ', q.str('EngineType')), version: (q) => q.str('EngineVersion') },
  'AWS::MSK::Cluster': { kind: 'queue', technology: 'Amazon MSK (Kafka)', version: (q) => q.str('KafkaVersion') },
  'AWS::Kinesis::Stream': { kind: 'queue', technology: 'Amazon Kinesis' },
  'AWS::S3::Bucket': { kind: 'storage', technology: 'Amazon S3' },
  'AWS::EFS::FileSystem': { kind: 'storage', technology: 'Amazon EFS' },
  'AWS::EC2::Volume': { kind: 'storage', technology: 'Amazon EBS' },
  'AWS::ElasticLoadBalancingV2::LoadBalancer': { kind: 'load-balancer', technology: (q) => ({ network: 'Amazon NLB', gateway: 'Amazon GWLB' })[q.str('Type') ?? ''] ?? 'Amazon ALB', extra: (q) => (q.str('Scheme') === 'internal' ? ['interno'] : []) },
  'AWS::ElasticLoadBalancing::LoadBalancer': { kind: 'load-balancer', technology: 'Amazon ELB clásico', extra: (q) => (q.str('Scheme') === 'internal' ? ['interno'] : []) },
  'AWS::ApiGateway::RestApi': { kind: 'gateway', technology: 'Amazon API Gateway' },
  'AWS::ApiGatewayV2::Api': { kind: 'gateway', technology: 'Amazon API Gateway' },
  'AWS::Serverless::Api': { kind: 'gateway', technology: 'Amazon API Gateway' },
  'AWS::Serverless::HttpApi': { kind: 'gateway', technology: 'Amazon API Gateway' },
  'AWS::CloudFront::Distribution': { kind: 'gateway', technology: 'Amazon CloudFront' },
  'AWS::AppSync::GraphQLApi': { kind: 'gateway', technology: 'AWS AppSync' },
  'AWS::Route53::HostedZone': { kind: 'dns', technology: 'Amazon Route 53', extra: (q) => (q.at('VPCs') !== undefined ? ['zona privada'] : []) },
  'AWS::SecretsManager::Secret': { kind: 'secret-store', technology: 'AWS Secrets Manager' },
  'AWS::KMS::Key': { kind: 'secret-store', technology: 'AWS KMS' },
  'AWS::ECR::Repository': { kind: 'registry', technology: 'Amazon ECR' },
  'AWS::CertificateManager::Certificate': { kind: 'certificate', technology: 'AWS Certificate Manager' },
  'AWS::APS::Workspace': { kind: 'monitoring', technology: 'Amazon Managed Prometheus' },
  'AWS::Grafana::Workspace': { kind: 'monitoring', technology: 'Amazon Managed Grafana' },
  'AWS::CloudWatch::Dashboard': { kind: 'monitoring', technology: 'Amazon CloudWatch' },
  'AWS::Lambda::Function': { kind: 'other', technology: (q) => join('AWS Lambda', q.str('Runtime') ? `(${q.str('Runtime')})` : undefined) },
  'AWS::Serverless::Function': { kind: 'other', technology: (q) => join('AWS Lambda', q.str('Runtime') ? `(${q.str('Runtime')})` : undefined) },
  'AWS::StepFunctions::StateMachine': { kind: 'other', technology: 'AWS Step Functions' },
  'AWS::Serverless::StateMachine': { kind: 'other', technology: 'AWS Step Functions' },
};

/**
 * Tipos que no son infraestructura que dibujar pero que el importador consulta: permisos, tablas de rutas, grupos de seguridad,
 * listeners, asociaciones, políticas, grupos de subredes y de parámetros, versiones y alias. Se avisan aparte de los desconocidos.
 */
const SUPPORT_SERVICES = /^AWS::(?:IAM|Logs|SSM|Events|Scheduler|ApplicationAutoScaling|Budgets|Config|CloudTrail|GuardDuty|WAFv2|WAF|Backup|ResourceGroups|Cognito)::/;
const SUPPORT_TYPES = new Set([
  'AWS::EC2::SecurityGroup', 'AWS::EC2::SecurityGroupIngress', 'AWS::EC2::SecurityGroupEgress', 'AWS::EC2::RouteTable', 'AWS::EC2::Route', 'AWS::EC2::SubnetRouteTableAssociation',
  'AWS::EC2::InternetGateway', 'AWS::EC2::VPCGatewayAttachment', 'AWS::EC2::NatGateway', 'AWS::EC2::EIP', 'AWS::EC2::EIPAssociation', 'AWS::EC2::NetworkAcl', 'AWS::EC2::NetworkAclEntry',
  'AWS::EC2::SubnetNetworkAclAssociation', 'AWS::EC2::VPCEndpoint', 'AWS::EC2::NetworkInterface', 'AWS::EC2::LaunchTemplate', 'AWS::EC2::KeyPair', 'AWS::EC2::VolumeAttachment',
  'AWS::EC2::VPCPeeringConnection', 'AWS::EC2::TransitGatewayAttachment', 'AWS::EC2::DHCPOptions', 'AWS::EC2::VPCDHCPOptionsAssociation', 'AWS::EC2::VPNGateway', 'AWS::EC2::FlowLog',
  'AWS::ElasticLoadBalancingV2::Listener', 'AWS::ElasticLoadBalancingV2::ListenerRule', 'AWS::ElasticLoadBalancingV2::TargetGroup', 'AWS::ElasticLoadBalancingV2::ListenerCertificate',
  'AWS::Lambda::Permission', 'AWS::Lambda::EventSourceMapping', 'AWS::Lambda::Version', 'AWS::Lambda::Alias', 'AWS::Lambda::LayerVersion', 'AWS::Lambda::Url', 'AWS::Serverless::LayerVersion',
  'AWS::CloudWatch::Alarm', 'AWS::CloudWatch::CompositeAlarm', 'AWS::SNS::Subscription', 'AWS::SNS::TopicPolicy', 'AWS::SQS::QueuePolicy', 'AWS::S3::BucketPolicy',
  'AWS::RDS::DBSubnetGroup', 'AWS::RDS::DBParameterGroup', 'AWS::RDS::DBClusterParameterGroup', 'AWS::RDS::OptionGroup', 'AWS::ElastiCache::SubnetGroup',
  'AWS::ElastiCache::ParameterGroup', 'AWS::ApiGateway::Method', 'AWS::ApiGateway::Resource', 'AWS::ApiGateway::Deployment', 'AWS::ApiGateway::Stage', 'AWS::ApiGateway::Authorizer',
  'AWS::ApiGateway::Account', 'AWS::ApiGateway::ApiKey', 'AWS::ApiGateway::UsagePlan', 'AWS::ApiGateway::DomainName', 'AWS::ApiGateway::BasePathMapping', 'AWS::ApiGatewayV2::Integration',
  'AWS::ApiGatewayV2::Route', 'AWS::ApiGatewayV2::Stage', 'AWS::ApiGatewayV2::Authorizer', 'AWS::ApiGatewayV2::Deployment', 'AWS::ApiGatewayV2::DomainName', 'AWS::ECS::TaskDefinition',
  'AWS::ECS::CapacityProvider', 'AWS::ECS::ClusterCapacityProviderAssociations', 'AWS::EKS::Nodegroup', 'AWS::EKS::FargateProfile', 'AWS::EKS::Addon', 'AWS::AutoScaling::LaunchConfiguration',
  'AWS::AutoScaling::ScalingPolicy', 'AWS::AutoScaling::ScheduledAction', 'AWS::AutoScaling::LifecycleHook', 'AWS::Route53::RecordSet', 'AWS::Route53::RecordSetGroup', 'AWS::Route53::HealthCheck',
  'AWS::KMS::Alias', 'AWS::SecretsManager::SecretTargetAttachment', 'AWS::SecretsManager::RotationSchedule', 'AWS::SecretsManager::ResourcePolicy', 'AWS::CloudFront::OriginAccessIdentity',
  'AWS::CloudFront::OriginAccessControl', 'AWS::CloudFront::CachePolicy', 'AWS::DynamoDB::ScalableTarget', 'AWS::CloudFormation::WaitCondition', 'AWS::CloudFormation::WaitConditionHandle',
  'AWS::Kinesis::StreamConsumer', 'AWS::KinesisFirehose::DeliveryStream', 'AWS::MSK::Configuration', 'AWS::Serverless::Application', 'AWS::StepFunctions::Activity',
]);

/** ¿Es un tipo de soporte (no se dibuja, pero se consulta)? */
export const isSupportType = (type: string): boolean => SUPPORT_TYPES.has(type) || SUPPORT_SERVICES.test(type);

/** Recursos personalizados: su lógica la ejecuta una función o un servicio que no se importa. */
export const isCustomType = (type: string): boolean => type === 'AWS::CloudFormation::CustomResource' || type.startsWith('Custom::');

/** Pilas anidadas: su plantilla (`TemplateURL`) no se descarga ni se lee. */
export const isNestedStack = (type: string): boolean => type === 'AWS::CloudFormation::Stack';

/** Nodos por los que una referencia sigue (su contenido cuenta como del que los referencia): definiciones de tarea, plantillas de lanzamiento, versiones y alias. */
export const CARRIER_TYPES = /^AWS::(?:ECS::TaskDefinition|EC2::LaunchTemplate|AutoScaling::LaunchConfiguration|Lambda::(?:Version|Alias))$/;

/** Tipos que enlazan una subred o una VPC con lo que la usa (grupos de subredes, interfaces de red). */
export const SUBNET_CARRIERS = /^AWS::(?:RDS::DBSubnetGroup|ElastiCache::SubnetGroup|EC2::NetworkInterface|EC2::LaunchTemplate)$/;
