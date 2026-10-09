import { readFileSync } from 'node:fs';
import { importText, ModuleRegistry } from '@iark/kernel';
import { describe, expect, it } from 'vitest';
import { platformModule } from '../module';
import { toMermaid } from '../export/mermaid';
import { toSvg } from '../export/render';
import { analyzePlatform } from '../issues';
import { validatePlatformDocument } from '../schema';
import type { PlatformDocument } from '../types';
import { fromCloudFormation, looksLikeCloudFormation } from './fromCloudFormation';
import { PlatformImportError } from './fromMermaid';
import { looksLikeKubernetes } from './fromKubernetes';
import { looksLikeTerraform } from './terraformModel';

const CFN = 'tests/fixtures/importar/cloudformation';
const fixture = (name: string): string => readFileSync(`${CFN}/${name}`, 'utf8');
const byId = <T extends { id: string }>(list: T[], id: string): T => {
  const found = list.find((x) => x.id === id);
  if (!found) throw new Error(`No hay «${id}» en ${list.map((x) => x.id).join(', ')}`);
  return found;
};
const deps = (doc: PlatformDocument): string[] => doc.dependencies.map((d) => `${d.kind} ${d.sourceId} ${d.targetId}`);
/** Una plantilla JSON mínima con los recursos que se den y las secciones extra. */
const template = (resources: Record<string, unknown>, extra: Record<string, unknown> = {}): string => JSON.stringify({ AWSTemplateFormatVersion: '2010-09-09', ...extra, Resources: resources });
const bucket = { Type: 'AWS::S3::Bucket' };

describe('importar CloudFormation: la tienda (VPC + EC2 + RDS + Lambda, YAML con etiquetas cortas)', () => {
  const { document: doc, warnings } = fromCloudFormation(fixture('tienda-aws.yaml'), { file: `${CFN}/tienda-aws.yaml` });

  it('pasa el esquema y el análisis de gobierno no encuentra errores', () => {
    expect(validatePlatformDocument(doc).ok).toBe(true);
    expect(analyzePlatform(doc).filter((i) => i.severity === 'error')).toEqual([]);
    expect(doc.workspace).toEqual({ name: 'tienda-aws', description: 'Tienda en línea - red, servidor web, base de datos y proceso de pedidos' });
    expect(doc.pipelines).toEqual([]);
  });

  it('un entorno: el del parámetro Environment, con su tipo, el proveedor y la región de las zonas de disponibilidad', () => {
    expect(doc.environments).toEqual([{ id: 'produccion', name: 'produccion', description: 'Entorno deducido del parámetro «Environment».', kind: 'prod', provider: 'aws', region: 'eu-west-1' }]);
  });

  it('redes: la VPC con su CIDR y sus subredes, públicas o privadas por MapPublicIpOnLaunch, la ruta al internet gateway o el nombre', () => {
    expect(doc.networks.map((n) => [n.id, n.name, n.parentId ?? null, n.exposure ?? null, n.cidr])).toEqual([
      ['vpc', 'produccion-red', null, null, '10.20.0.0/16'],
      ['public-subnet-a', 'publica-a', 'vpc', 'public', '10.20.1.0/24'],
      ['private-subnet-a', 'PrivateSubnetA', 'vpc', 'private', '10.20.10.0/24'],
      ['private-subnet-b', 'PrivateSubnetB', 'vpc', 'private', '10.20.11.0/24'],
    ]);
    expect(warnings.join('\n')).not.toContain('sin dato de exposición');
  });

  it('recursos: cada uno de su clase, con tecnología, versión, red y responsable, y todos como código', () => {
    expect(byId(doc.resources, 'web-server')).toMatchObject({ name: 'tienda-web', kind: 'vm', technology: 'Amazon EC2 t3.medium', networkId: 'public-subnet-a', owner: 'equipo-web', iac: true });
    expect(byId(doc.resources, 'database')).toMatchObject({ name: 'produccion-pedidos-db', kind: 'database', technology: 'Amazon RDS PostgreSQL', version: '15.4', networkId: 'private-subnet-a' });
    expect(byId(doc.resources, 'database').description).toBe('CloudFormation Database (AWS::RDS::DBInstance) · db.m6g.large');
    expect(byId(doc.resources, 'orders-queue')).toMatchObject({ name: 'produccion-pedidos', kind: 'queue', technology: 'Amazon SQS' });
    expect(byId(doc.resources, 'order-processor')).toMatchObject({ name: 'procesar-pedidos', kind: 'other', technology: 'AWS Lambda (python3.12)', networkId: 'private-subnet-a', owner: 'pedidos' });
    expect(byId(doc.resources, 'assets-bucket')).toMatchObject({ name: 'produccion-tienda-assets', kind: 'storage', technology: 'Amazon S3' });
    expect(byId(doc.resources, 'dns')).toMatchObject({ name: 'tienda.example.com', kind: 'dns' });
    expect(doc.resources).toHaveLength(6);
    expect(doc.resources.every((r) => r.iac === true)).toBe(true);
  });

  it('dependencias: reglas de grupos de seguridad (con el puerto), orígenes de eventos, registros DNS y referencias, con su origen', () => {
    expect(doc.dependencies.map((d) => [d.kind, d.sourceId, d.targetId, d.protocol ?? null, d.description])).toEqual([
      ['data', 'web-server', 'database', 'tcp/5432', 'Ingreso DbSecurityGroup'],
      ['data', 'order-processor', 'database', 'tcp/5432', 'Ingreso DbSecurityGroup'],
      ['messages', 'order-processor', 'orders-queue', null, 'Origen de eventos OrdersEventSource'],
      ['calls', 'dns', 'web-server', null, 'Registro DnsRecord'],
      ['data', 'web-server', 'assets-bucket', null, 'Fn::Sub ${AssetsBucket} en «UserData»'],
      ['data', 'order-processor', 'assets-bucket', null, 'Ref AssetsBucket en «Environment»'],
    ]);
  });

  it('avisa de todo lo que no entra, agrupado y con cuentas', () => {
    expect(warnings).toEqual([
      '14 recursos de soporte que no se dibujan (solo se consultan para deducir redes, exposición y dependencias): AWS::EC2::InternetGateway, AWS::EC2::VPCGatewayAttachment, AWS::EC2::RouteTable, AWS::EC2::Route, AWS::EC2::SubnetRouteTableAssociation, AWS::EC2::SecurityGroup ×3, AWS::RDS::DBSubnetGroup, AWS::IAM::Role, AWS::Lambda::EventSourceMapping, AWS::Route53::RecordSet, AWS::CloudWatch::Alarm, AWS::CloudTrail::Trail.',
      '1 pila anidada (AWS::CloudFormation::Stack): su plantilla (TemplateURL) no se descarga ni se lee, así que su contenido no se importa: Monitoring.',
      '1 recurso personalizado (Custom::…): su lógica no se ejecuta ni se importa: Semilla.',
      'Las condiciones (Conditions, Fn::If) no se evalúan: se ignoran.',
      'Secciones de la plantilla que no se interpretan: Mappings (1), Outputs (2).',
    ]);
  });

  it('nunca copia un valor secreto: ni la contraseña (NoEcho) ni el parámetro que la lleva', () => {
    expect(JSON.stringify(doc)).not.toContain('cambiar-esta-clave');
    expect(JSON.stringify(warnings)).not.toContain('cambiar-esta-clave');
  });

  it('se ve y se exporta: vistas, SVG sin NaN y Mermaid', async () => {
    for (const view of ['env:produccion', 'impact:database']) {
      const svg = await toSvg(doc, view);
      expect(svg, view).toContain('<svg');
      expect(svg, view).not.toContain('NaN');
    }
    expect(toMermaid(doc, { viewId: 'env:produccion' })).toContain('tienda-web');
  }, 60_000);

  it('importar dos veces da el mismo documento y los mismos avisos; BOM y saltos de línea no cambian nada', () => {
    const text = fixture('tienda-aws.yaml');
    const again = fromCloudFormation(text, { file: `${CFN}/tienda-aws.yaml` });
    expect(again.document).toEqual(doc);
    expect(again.warnings).toEqual(warnings);
    const crlf = fromCloudFormation(`﻿${text.replace(/\n/g, '\r\n')}`, { file: `${CFN}/tienda-aws.yaml` });
    expect(crlf.document).toEqual(doc);
  });
});

describe('importar CloudFormation: API en contenedores (JSON, ECS Fargate, balanceador)', () => {
  const { document: doc, warnings } = fromCloudFormation(fixture('api-contenedores.json'));

  it('el servicio de ECS se despliega en su clúster con las réplicas, la versión de la imagen y los límites de su tarea', () => {
    expect(validatePlatformDocument(doc).ok).toBe(true);
    expect(doc.environments[0]).toMatchObject({ name: 'staging', kind: 'staging', provider: 'aws', region: 'eu-west-1' });
    expect(doc.services).toHaveLength(1);
    expect(doc.services[0]).toMatchObject({ id: 'service', name: 'Service', technology: 'Amazon ECS (FARGATE)' });
    expect(doc.deployments).toEqual([{ id: 'service-staging', serviceId: 'service', environmentId: 'staging', hostId: 'cluster', replicas: 3, version: '1.4.2', cpuLimit: '0.5', memoryLimit: '1 GiB' }]);
    expect(byId(doc.resources, 'cluster')).toMatchObject({ name: 'staging-pedidos', kind: 'cluster', technology: 'Amazon ECS' });
    expect(byId(doc.resources, 'table')).toMatchObject({ name: 'staging-pedidos', kind: 'database', technology: 'Amazon DynamoDB' });
  });

  it('dependencias: el balanceador sirve al servicio (por su listener y su grupo de destino) y el servicio usa lo que su tarea referencia', () => {
    expect(doc.dependencies.map((d) => [d.kind, d.sourceId, d.targetId, d.protocol ?? null, d.description])).toEqual([
      ['calls', 'load-balancer', 'service', 'HTTPS', 'Listener Listener (grupo TargetGroup)'],
      ['data', 'service', 'table', null, 'Ref Table en «ContainerDefinitions» (vía TaskDefinition)'],
      ['messages', 'service', 'events', null, 'Ref Events en «ContainerDefinitions» (vía TaskDefinition)'],
    ]);
  });

  it('las exportaciones de otras pilas y las referencias a recursos que no existen se avisan', () => {
    expect(warnings).toEqual([
      '4 recursos de soporte que no se dibujan (solo se consultan para deducir redes, exposición y dependencias): AWS::ECS::TaskDefinition, AWS::ElasticLoadBalancingV2::TargetGroup, AWS::ElasticLoadBalancingV2::Listener, AWS::SNS::Subscription.',
      '1 referencia a exportaciones de otras pilas (Fn::ImportValue) no se resuelven: no se infieren esas dependencias.',
      '1 referencia a recursos que no existen en la plantilla (Ref, GetAtt, Sub o DependsOn): Fantasma.',
    ]);
  });
});

describe('importar CloudFormation: SAM (Transform sin expandir)', () => {
  const { document: doc, warnings } = fromCloudFormation(fixture('sam-notificaciones.yaml'));

  it('importa los recursos tal como están escritos y dice lo que no expande', () => {
    expect(doc.resources.map((r) => [r.id, r.kind, r.technology])).toEqual([
      ['notificaciones', 'other', 'AWS Lambda'],
      ['historial', 'database', 'Amazon DynamoDB'],
      ['api-publica', 'gateway', 'Amazon API Gateway'],
      ['cola-envios', 'queue', 'Amazon SQS'],
    ]);
    expect(warnings.join('\n')).toContain('La plantilla usa Transform (AWS::Serverless-2016-10-31) y no se expande');
    expect(warnings.join('\n')).toContain('1 función de SAM con «Events», que no se interpretan: Notificaciones.');
    expect(warnings.join('\n')).toContain('Secciones de la plantilla que no se interpretan: Globals (1)');
  });

  it('los Events de una función no crean dependencias (los dispara el origen, no la función); las demás referencias sí', () => {
    expect(deps(doc)).toEqual(['data notificaciones historial']);
  });
});

describe('importar CloudFormation: la forma corta y la larga dan lo mismo', () => {
  it('!Ref, !GetAtt, !Sub, !Join y !If equivalen a Ref, Fn::GetAtt, Fn::Sub, Fn::Join y Fn::If', () => {
    const short = `AWSTemplateFormatVersion: '2010-09-09'
Parameters:
  Stage: { Type: String, Default: dev }
Resources:
  Bucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub '\${Stage}-datos'
  Queue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Join ['-', [!Ref Stage, cola]]
  Fn:
    Type: AWS::Lambda::Function
    Properties:
      Runtime: nodejs20.x
      Environment:
        Variables:
          B: !GetAtt Bucket.Arn
          Q: !Ref Queue
          X: !If [Cond, !Ref Bucket, !Ref 'AWS::NoValue']
`;
    const long = JSON.stringify({
      AWSTemplateFormatVersion: '2010-09-09',
      Parameters: { Stage: { Type: 'String', Default: 'dev' } },
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: { 'Fn::Sub': '${Stage}-datos' } } },
        Queue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: { 'Fn::Join': ['-', [{ Ref: 'Stage' }, 'cola']] } } },
        Fn: { Type: 'AWS::Lambda::Function', Properties: { Runtime: 'nodejs20.x', Environment: { Variables: { B: { 'Fn::GetAtt': ['Bucket', 'Arn'] }, Q: { Ref: 'Queue' }, X: { 'Fn::If': ['Cond', { Ref: 'Bucket' }, { Ref: 'AWS::NoValue' }] } } } } },
      },
    });
    const a = fromCloudFormation(short);
    const b = fromCloudFormation(long);
    expect(a.document).toEqual(b.document);
    expect(a.warnings).toEqual(b.warnings);
    expect(a.document.resources.map((r) => r.name)).toEqual(['dev-datos', 'dev-cola', 'Fn']);
    expect(deps(a.document)).toEqual(['data fn bucket', 'messages fn queue']);
  });

  it('una etiqueta corta desconocida no ejecuta nada: se lee como un dato', () => {
    const text = `Resources:\n  B:\n    Type: AWS::S3::Bucket\n    Properties:\n      BucketName: !Rarita {a: 1}\n      Tags: !!js/function 'function(){ throw 1 }'\n`;
    const { document: doc } = fromCloudFormation(text);
    expect(doc.resources[0].name).toBe('B');
  });
});

describe('importar CloudFormation: casos de estructura', () => {
  it('Fn::GetAtt en las dos formas, Sub con variables propias y DependsOn explícito (el último en prioridad)', () => {
    const { document: doc } = fromCloudFormation(
      template({
        Db: { Type: 'AWS::RDS::DBInstance', Properties: { Engine: 'mysql' } },
        A: { Type: 'AWS::Lambda::Function', Properties: { Environment: { Variables: { H: { 'Fn::GetAtt': ['Db', 'Endpoint.Address'] } } } } },
        B: { Type: 'AWS::Lambda::Function', Properties: { Environment: { Variables: { H: { 'Fn::GetAtt': 'Db.Endpoint.Address' } } } } },
        C: { Type: 'AWS::Lambda::Function', Properties: { Environment: { Variables: { H: { 'Fn::Sub': ['${Host}:${Port}', { Host: { Ref: 'Db' }, Port: '3306' }] } } } } },
        D: { Type: 'AWS::Lambda::Function', DependsOn: 'Db' },
        E: { Type: 'AWS::Lambda::Function', DependsOn: ['Db'], Properties: { Environment: { Variables: { H: { Ref: 'Db' } } } } },
      }),
    );
    expect(doc.dependencies.map((d) => [d.sourceId, d.targetId, d.description])).toEqual([
      ['a', 'db', 'Fn::GetAtt Db.Endpoint.Address en «Environment»'],
      ['b', 'db', 'Fn::GetAtt Db.Endpoint.Address en «Environment»'],
      ['c', 'db', 'Ref Db en «Environment»'],
      ['e', 'db', 'Ref Db en «Environment»'],
      ['d', 'db', 'DependsOn Db'],
    ]);
    expect(byIdOf(doc, 'db').technology).toBe('Amazon RDS MySQL');
  });

  it('un ciclo de referencias entre recursos y una referencia a sí mismo no cuelgan ni se importan como dependencia propia', () => {
    const { document: doc } = fromCloudFormation(
      template({
        Q1: { Type: 'AWS::SQS::Queue', Properties: { RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': ['Q2', 'Arn'] } } } },
        Q2: { Type: 'AWS::SQS::Queue', Properties: { RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': ['Q1', 'Arn'] } } } },
        Q3: { Type: 'AWS::SQS::Queue', Properties: { Tags: [{ Key: 'self', Value: { Ref: 'Q3' } }] } },
      }),
    );
    expect(deps(doc)).toEqual(['messages q1 q2', 'messages q2 q1']);
  });

  it('el entorno sale de la etiqueta Environment más frecuente (con aviso si discrepan) o, sin nada, del nombre del archivo (con aviso)', () => {
    const tagged = (value: string) => ({ Type: 'AWS::S3::Bucket', Properties: { Tags: [{ Key: 'Environment', Value: value }] } });
    const a = fromCloudFormation(template({ A: tagged('qa'), B: tagged('qa'), C: tagged('prod') }));
    expect(a.document.environments[0]).toMatchObject({ name: 'qa', kind: 'test' });
    expect(a.warnings[0]).toBe('Las etiquetas de entorno de los recursos tienen valores distintos (qa ×2, prod ×1): se usa «qa» para toda la plantilla.');
    const none = fromCloudFormation(template({ A: bucket }), { file: 'infra/pagos-prod.yaml' });
    expect(none.document.environments[0]).toMatchObject({ name: 'pagos-prod', kind: 'prod' });
    expect(none.warnings[0]).toBe('No se pudo deducir el entorno de parámetros ni de etiquetas: se crea el entorno «pagos-prod» a partir del nombre del archivo.');
    expect(fromCloudFormation(template({ A: bucket })).document.environments[0].name).toBe('Entorno principal');
    // un parámetro con NoEcho nunca da el nombre
    const secret = fromCloudFormation(template({ A: bucket }, { Parameters: { Environment: { Type: 'String', NoEcho: true, Default: 'clave-secreta' } } }));
    expect(JSON.stringify(secret.document)).not.toContain('clave-secreta');
  });

  it('subredes: la exposición sale de la ruta (internet gateway o NAT), de la etiqueta o del nombre; sin ninguna, privada y con aviso', () => {
    const subnet = (extra: Record<string, unknown> = {}, tags?: string) => ({ Type: 'AWS::EC2::Subnet', Properties: { VpcId: { Ref: 'V' }, CidrBlock: '10.0.0.0/24', ...extra, ...(tags ? { Tags: [{ Key: 'Name', Value: tags }] } : {}) } });
    const { document: doc, warnings } = fromCloudFormation(
      template({
        V: { Type: 'AWS::EC2::VPC', Properties: { CidrBlock: '10.0.0.0/16' } },
        Igw: { Type: 'AWS::EC2::InternetGateway' },
        Nat: { Type: 'AWS::EC2::NatGateway' },
        T1: { Type: 'AWS::EC2::RouteTable' },
        T2: { Type: 'AWS::EC2::RouteTable' },
        R1: { Type: 'AWS::EC2::Route', Properties: { RouteTableId: { Ref: 'T1' }, GatewayId: { Ref: 'Igw' } } },
        R2: { Type: 'AWS::EC2::Route', Properties: { RouteTableId: { Ref: 'T2' }, NatGatewayId: { Ref: 'Nat' } } },
        A1: { Type: 'AWS::EC2::SubnetRouteTableAssociation', Properties: { SubnetId: { Ref: 'ViaIgw' }, RouteTableId: { Ref: 'T1' } } },
        A2: { Type: 'AWS::EC2::SubnetRouteTableAssociation', Properties: { SubnetId: { Ref: 'ViaNat' }, RouteTableId: { Ref: 'T2' } } },
        ViaIgw: subnet(),
        ViaNat: subnet(),
        Dmz: subnet({}, 'zona-dmz'),
        Datos: subnet({}, 'datos'),
        ElbTag: { Type: 'AWS::EC2::Subnet', Properties: { VpcId: { Ref: 'V' }, CidrBlock: '10.0.4.0/24', Tags: [{ Key: 'kubernetes.io/role/elb', Value: '1' }] } },
        Misteriosa: subnet(),
        Explicita: subnet({ MapPublicIpOnLaunch: 'false' }),
      }),
    );
    const exposure = Object.fromEntries(doc.networks.filter((n) => n.parentId).map((n) => [n.id, n.exposure]));
    expect(exposure).toEqual({ 'via-igw': 'public', 'via-nat': 'private', dmz: 'public', datos: 'private', 'elb-tag': 'public', misteriosa: 'private', explicita: 'private' });
    expect(warnings.find((w) => w.includes('sin dato de exposición'))).toBe('1 red sin dato de exposición (ni MapPublicIpOnLaunch, ni ruta a un internet gateway, ni nombre o etiqueta que lo indique): se importan como privadas: Misteriosa.');
  });

  it('PubliclyAccessible en una red privada se avisa como discrepancia', () => {
    const { warnings } = fromCloudFormation(
      template({
        V: { Type: 'AWS::EC2::VPC', Properties: { CidrBlock: '10.0.0.0/16' } },
        S: { Type: 'AWS::EC2::Subnet', Properties: { VpcId: { Ref: 'V' }, CidrBlock: '10.0.1.0/24', MapPublicIpOnLaunch: false } },
        G: { Type: 'AWS::RDS::DBSubnetGroup', Properties: { SubnetIds: [{ Ref: 'S' }] } },
        Db: { Type: 'AWS::RDS::DBInstance', Properties: { Engine: 'postgres', PubliclyAccessible: true, DBSubnetGroupName: { Ref: 'G' } } },
      }),
    );
    expect(warnings.join('\n')).toContain('«Db» (Db) tiene PubliclyAccessible: true pero está en la red privada «S»: el modelo no refleja esa exposición.');
  });

  it('balanceador: sirve a lo que usa su grupo de destino (instancias incluidas), con el protocolo del listener', () => {
    const { document: doc } = fromCloudFormation(
      template({
        Alb: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: { Scheme: 'internal' } },
        Tg: { Type: 'AWS::ElasticLoadBalancingV2::TargetGroup', Properties: { Targets: [{ Id: { Ref: 'Web' } }] } },
        L: { Type: 'AWS::ElasticLoadBalancingV2::Listener', Properties: { LoadBalancerArn: { Ref: 'Alb' }, Protocol: 'http', DefaultActions: [{ TargetGroupArn: { Ref: 'Tg' } }] } },
        Web: { Type: 'AWS::EC2::Instance', Properties: { InstanceType: 't3.small' } },
      }),
    );
    expect(doc.dependencies.map((d) => [d.kind, d.sourceId, d.targetId, d.protocol])).toEqual([['calls', 'alb', 'web', 'HTTP']]);
    expect(byIdOf(doc, 'alb').description).toBe('CloudFormation Alb (AWS::ElasticLoadBalancingV2::LoadBalancer) · interno');
  });

  it('API Gateway, permisos de Lambda y suscripciones SNS unen a quien llama con quien recibe', () => {
    const { document: doc } = fromCloudFormation(
      template({
        Api: { Type: 'AWS::ApiGateway::RestApi', Properties: { Name: 'api' } },
        Fn: { Type: 'AWS::Lambda::Function', Properties: { Runtime: 'python3.12' } },
        Metodo: { Type: 'AWS::ApiGateway::Method', Properties: { RestApiId: { Ref: 'Api' }, Integration: { Uri: { 'Fn::Sub': 'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${Fn.Arn}/invocations' } } } },
        Topic: { Type: 'AWS::SNS::Topic' },
        Sub: { Type: 'AWS::SNS::Subscription', Properties: { TopicArn: { Ref: 'Topic' }, Protocol: 'lambda', Endpoint: { 'Fn::GetAtt': ['Fn2', 'Arn'] } } },
        Fn2: { Type: 'AWS::Lambda::Function', Properties: { Runtime: 'python3.12' } },
        Perm: { Type: 'AWS::Lambda::Permission', Properties: { FunctionName: { Ref: 'Fn2' }, Principal: 'events.amazonaws.com', SourceArn: { 'Fn::GetAtt': ['Bus', 'Arn'] } } },
        Bus: { Type: 'AWS::SQS::Queue' },
      }),
    );
    expect(doc.dependencies.map((d) => `${d.kind} ${d.sourceId} ${d.targetId} | ${d.description}`)).toEqual([
      'calls api fn | Método Metodo',
      'calls topic fn2 | Suscripción Sub',
      'calls bus fn2 | Permiso Perm',
    ]);
  });

  it('funciones de Lambda con plantilla de versión y alias: la referencia sigue hasta la función', () => {
    const { document: doc } = fromCloudFormation(
      template({
        Fn: { Type: 'AWS::Lambda::Function', Properties: { Runtime: 'java21' } },
        V: { Type: 'AWS::Lambda::Version', Properties: { FunctionName: { Ref: 'Fn' } } },
        Al: { Type: 'AWS::Lambda::Alias', Properties: { FunctionName: { Ref: 'Fn' }, FunctionVersion: { 'Fn::GetAtt': ['V', 'Version'] }, Name: 'vivo' } },
        Api: { Type: 'AWS::ApiGatewayV2::Api', Properties: { Name: 'x' } },
        Integracion: { Type: 'AWS::ApiGatewayV2::Integration', Properties: { ApiId: { Ref: 'Api' }, IntegrationUri: { Ref: 'Al' } } },
      }),
    );
    expect(deps(doc)).toEqual(['calls api fn']);
  });

  it('clasifica lo que no entra: pilas anidadas, recursos personalizados, tipos de soporte y tipos desconocidos, cada uno con su aviso', () => {
    const { warnings } = fromCloudFormation(
      template({
        B: bucket,
        N: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'https://example.com/n.yaml' } },
        C: { Type: 'Custom::Algo' },
        C2: { Type: 'AWS::CloudFormation::CustomResource' },
        R: { Type: 'AWS::IAM::Role' },
        X: { Type: 'AWS::Inventado::Cosa' },
        X2: { Type: 'AWS::Inventado::Cosa' },
        Roto: 'no soy un recurso',
        Sin: { Properties: {} },
        'Fn::ForEach::Cada': ['Item', ['a'], {}],
      }),
    );
    expect(warnings).toEqual([
      '2 recurso(s) sin «Type» o que no son un mapa, que no se importan: Roto, Sin.',
      '1 bucle(s) «Fn::ForEach», que no se expanden y no se importan: Fn::ForEach::Cada.',
      'No se pudo deducir el entorno de parámetros ni de etiquetas: se crea el entorno «Entorno principal» a partir del valor por defecto.',
      '2 recursos de tipos sin mapear, que no se importan: AWS::Inventado::Cosa ×2.',
      '1 recurso de soporte que no se dibuja (solo se consultan para deducir redes, exposición y dependencias): AWS::IAM::Role.',
      '1 pila anidada (AWS::CloudFormation::Stack): su plantilla (TemplateURL) no se descarga ni se lee, así que su contenido no se importa: N.',
      '2 recursos personalizados (Custom::…): su lógica no se ejecuta ni se importa: C, C2.',
    ]);
  });

  it('las condiciones no se evalúan: el recurso condicional se importa y se marca; Fn::Transform e ImportValue se avisan sin seguirlos', () => {
    const { document: doc, warnings } = fromCloudFormation(
      template(
        {
          B: { Type: 'AWS::S3::Bucket', Condition: 'EsProd', Properties: { BucketName: { 'Fn::ImportValue': 'otro' }, Tags: [{ Key: 'x', Value: { 'Fn::Transform': { Name: 'AWS::Include', Parameters: { Location: 's3://b/k' } } } }] } },
        },
        { Conditions: { EsProd: { 'Fn::Equals': ['a', 'a'] } } },
      ),
    );
    expect(doc.resources[0].description).toBe('CloudFormation B (AWS::S3::Bucket) · condicional (EsProd)');
    expect(warnings).toContain('Las condiciones (Conditions, Fn::If) no se evalúan: 1 recurso con Condition se importa como si se crearan siempre (B).');
    expect(warnings).toContain('1 referencia a exportaciones de otras pilas (Fn::ImportValue) no se resuelven: no se infieren esas dependencias.');
    expect(warnings).toContain('1 uso de Fn::Transform (macros e Include): no se siguen, nunca se descarga nada.');
  });

  it('un servicio de ECS sin clúster en la plantilla se importa sin despliegue, con aviso', () => {
    const { document: doc, warnings } = fromCloudFormation(template({ Svc: { Type: 'AWS::ECS::Service', Properties: { DesiredCount: 2 } }, B: bucket }));
    expect(doc.services).toHaveLength(1);
    expect(doc.deployments).toEqual([]);
    expect(warnings).toContain('El servicio Svc no referencia ningún clúster ECS de la plantilla: se importa sin despliegue.');
  });

  it('nombres como __proto__, constructor o toString no confunden al importador', () => {
    const { document: doc, warnings } = fromCloudFormation(
      JSON.stringify({
        Resources: {
          constructor: { Type: 'AWS::S3::Bucket' },
          toString: { Type: 'AWS::SQS::Queue', Properties: { Tags: [{ Key: 'a', Value: { Ref: 'constructor' } }, { Key: 'b', Value: { Ref: '__proto__' } }, { Key: 'c', Value: { 'Fn::GetAtt': ['hasOwnProperty', 'Arn'] } }] } },
        },
        Parameters: { __proto__x: { Type: 'String' } },
      }).replace('"Resources"', '"__proto__": {"Type": "x"}, "Resources"'),
    );
    expect(doc.resources.map((r) => r.id)).toEqual(['constructor', 'to-string']);
    expect(deps(doc)).toEqual(['data to-string constructor']);
    expect(warnings.join('\n')).toContain('2 referencias a recursos que no existen en la plantilla (Ref, GetAtt, Sub o DependsOn): __proto__, hasOwnProperty.');
  });

  it('la región sale de las zonas de disponibilidad, los ARN y las imágenes de ECR; la más frecuente gana', () => {
    const { document: doc } = fromCloudFormation(
      template({
        S: { Type: 'AWS::EC2::Subnet', Properties: { AvailabilityZone: 'us-east-2a', CidrBlock: '10.0.0.0/24' } },
        F: { Type: 'AWS::Lambda::Function', Properties: { Role: 'arn:aws:iam::123456789012:role/x', Code: { ImageUri: '123456789012.dkr.ecr.us-east-2.amazonaws.com/x:1' }, Environment: { Variables: { A: 'arn:aws:sqs:eu-west-1:123456789012:q' } } } },
      }),
    );
    expect(doc.environments[0].region).toBe('us-east-2');
  });
});

/** El elemento del documento (recurso) con ese id. */
function byIdOf(doc: PlatformDocument, id: string) {
  return byId(doc.resources, id);
}

describe('importar CloudFormation: entradas que no son una plantilla utilizable', () => {
  const fail = (text: string): string => {
    try {
      fromCloudFormation(text);
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformImportError);
      return (error as Error).message;
    }
    throw new Error('no falló');
  };

  it('vacío, sin contenido útil, de otro tipo, truncado o con la sintaxis rota: un mensaje claro de una línea', () => {
    expect(fail('')).toBe('El archivo de CloudFormation está vacío.');
    expect(fail('  \n\t ')).toMatch(/está vacío/);
    expect(fail('[]')).toBe('La plantilla de CloudFormation es una lista: se esperaba un mapa con la sección «Resources».');
    expect(fail('"hola"')).toMatch(/es un valor de tipo string/);
    expect(fail('42')).toMatch(/es un valor de tipo number/);
    expect(fail('null')).toMatch(/es vacía/);
    expect(fail('{"AWSTemplateFormatVersion": "2010-09-09", "Resources": {"A": {"Type": "AWS::S3::Bucket"')).toMatch(/no es JSON válido/);
    expect(fail('{"Resources": {')).toMatch(/^El archivo de CloudFormation no es JSON válido \(línea 1, columna \d+\)/);
    expect(fail('Resources:\n  A:\n    Type: AWS::S3::Bucket\n   Properties: x\n')).toMatch(/^El archivo de CloudFormation no es YAML válido \(línea \d+, columna \d+\)/);
    expect(fail('a: 1\na: 2\n')).toMatch(/no es YAML válido/);
    expect(fail('a: 1\n---\nb: 2\n')).toMatch(/varios documentos YAML/);
  });

  it('sin Resources, con Resources que no es un mapa, vacío o con solo tipos sin mapear', () => {
    expect(fail('AWSTemplateFormatVersion: "2010-09-09"\nDescription: nada\n')).toBe('La plantilla de CloudFormation no tiene sección «Resources»: no hay nada que importar.');
    expect(fail('{"Resources": []}')).toBe('La sección «Resources» de la plantilla no es un mapa de recursos.');
    expect(fail('{"Resources": {}}')).toMatch(/no define ningún recurso que se pueda importar/);
    expect(fail(template({ R: { Type: 'AWS::IAM::Role' }, X: { Type: 'AWS::Inventado::Cosa' } }))).toBe(
      'La plantilla de CloudFormation no define ningún recurso que se pueda importar (redes, clústeres, bases de datos, colas, almacenamiento…). Tipos sin mapear: AWS::Inventado::Cosa.',
    );
  });

  it('un texto de más de 32 MiB se rechaza antes de analizarlo', () => {
    expect(fail(`Resources: ${'a'.repeat(33 * 1024 * 1024)}`)).toMatch(/demasiado grande/);
  });

  it('un anidamiento de miles de niveles (YAML o JSON) y una bomba de alias se rechazan con un error, sin agotar la pila', () => {
    expect(fail(`Resources: ${'['.repeat(20_000)}${']'.repeat(20_000)}`)).toMatch(/anidado/);
    expect(fail(`{"Resources": ${'['.repeat(20_000)}${']'.repeat(20_000)}}`)).toMatch(/anidado/);
    expect(fail(`Resources:\n  A: ${'{b: '.repeat(3000)}1${'}'.repeat(3000)}\n`)).toMatch(/anidado|no es YAML válido/);
    const bomb = ['a: &a [x, x, x, x, x, x, x, x, x]', ...'bcdefghij'.split('').map((k, i) => `${k}: &${k} [${Array.from({ length: 9 }, () => `*${'abcdefghi'[i]}`).join(', ')}]`), 'Resources: *j'].join('\n');
    expect(fail(bomb)).toMatch(/demasiados alias YAML/);
  });

  it('diez mil recursos se importan deprisa y dan un documento válido', () => {
    const resources: Record<string, unknown> = {};
    for (let i = 0; i < 10_000; i += 1) resources[`Cola${i}`] = { Type: 'AWS::SQS::Queue', Properties: { QueueName: `cola-${i}`, RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': [`Cola${(i + 1) % 10_000}`, 'Arn'] } } } };
    const started = Date.now();
    const { document: doc } = fromCloudFormation(template(resources));
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(doc.resources).toHaveLength(10_000);
    expect(doc.dependencies).toHaveLength(10_000);
    expect(validatePlatformDocument(doc).ok).toBe(true);
  }, 60_000);

  it('más de 50.000 recursos se rechaza con un error claro', () => {
    const resources: Record<string, unknown> = {};
    for (let i = 0; i < 50_001; i += 1) resources[`B${i}`] = bucket;
    expect(fail(template(resources))).toBe('La plantilla tiene 50001 recursos: el máximo que se importa es 50000.');
  }, 60_000);

  it('muchos grupos de seguridad con reglas entre sí no se vuelven cuadráticos', () => {
    const resources: Record<string, unknown> = { Vpc: { Type: 'AWS::EC2::VPC', Properties: { CidrBlock: '10.0.0.0/16' } } };
    const n = 600;
    for (let i = 0; i < n; i += 1) {
      resources[`Sg${i}`] = { Type: 'AWS::EC2::SecurityGroup', Properties: { VpcId: { Ref: 'Vpc' }, SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 80, ToPort: 80, SourceSecurityGroupId: { Ref: `Sg${(i + 1) % n}` } }] } };
      resources[`Vm${i}`] = { Type: 'AWS::EC2::Instance', Properties: { SecurityGroupIds: [{ Ref: `Sg${i}` }] } };
    }
    const started = Date.now();
    const { document: doc } = fromCloudFormation(template(resources));
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(doc.dependencies).toHaveLength(n);
  }, 60_000);
});

describe('importar CloudFormation: detección del formato', () => {
  it('reconoce las plantillas de YAML y de JSON, con y sin AWSTemplateFormatVersion, con prólogo, BOM y comentarios', () => {
    for (const file of ['tienda-aws.yaml', 'api-contenedores.json', 'sam-notificaciones.yaml']) expect(looksLikeCloudFormation(fixture(file)), file).toBe(true);
    expect(looksLikeCloudFormation('Resources:\n  B:\n    Type: AWS::S3::Bucket\n')).toBe(true);
    expect(looksLikeCloudFormation('# plantilla\nResources:   # recursos\n  B:\n    Type: "AWS::S3::Bucket"\n')).toBe(true);
    expect(looksLikeCloudFormation('{"Resources": {"B": {"Type": "AWS::S3::Bucket"}}}')).toBe(true);
    expect(looksLikeCloudFormation('Resources:\n  C:\n    Type: Custom::Cosa\n')).toBe(true);
    expect(looksLikeCloudFormation(`﻿AWSTemplateFormatVersion: '2010-09-09'\n`)).toBe(true);
    expect(looksLikeCloudFormation('{"AWSTemplateFormatVersion": "2010-09-09"}')).toBe(true);
  });

  it('no confunde con Kubernetes, Terraform, Helm, Mermaid, OpenAPI, otro JSON o YAML cualquiera', () => {
    for (const text of [
      readFileSync('tests/fixtures/importar/kubernetes/tienda/manifests.yaml', 'utf8'),
      readFileSync('tests/fixtures/importar/terraform/aws-tienda/main.tf', 'utf8'),
      readFileSync('tests/fixtures/importar/terraform/aws-tienda-dev/plan.json', 'utf8'),
      readFileSync('tests/fixtures/importar/terraform/aws-tienda-staging/terraform.tfstate', 'utf8'),
      readFileSync('tests/fixtures/importar/helm/tienda/Chart.yaml', 'utf8'),
      readFileSync('tests/fixtures/importar/helm/tienda/values.yaml', 'utf8'),
      readFileSync('tests/fixtures/importar/openapi/petstore.yaml', 'utf8'),
      readFileSync('examples/plataforma-ejemplo.json', 'utf8'),
      'flowchart LR\n  a --> b',
      'Resources:\n  - uno\n  - dos\n',
      'Resources:\n  B:\n    Type: Otra::Cosa\n',
      '{"Resources": {"B": {"Type": "Otra::Cosa"}}}',
      '{"resources": []}',
      'texto cualquiera',
      '',
    ]) {
      expect(looksLikeCloudFormation(text), text.slice(0, 60)).toBe(false);
    }
    for (const file of ['tienda-aws.yaml', 'api-contenedores.json']) {
      expect(looksLikeKubernetes(fixture(file)), file).toBe(false);
      expect(looksLikeTerraform(fixture(file)), file).toBe(false);
    }
  });

  it('el módulo lo elige por el contenido (también en .json) y por .yaml, .yml, .template y .cfn', async () => {
    const registry = new ModuleRegistry().register(platformModule);
    const pick = (file: string | undefined, text: string): string | undefined => registry.detectImporter<PlatformDocument>('platform', file, text)?.id;
    expect(pick('plantilla.yaml', fixture('tienda-aws.yaml'))).toBe('cloudformation');
    expect(pick('plantilla.yml', fixture('tienda-aws.yaml'))).toBe('cloudformation');
    expect(pick('web.template', fixture('tienda-aws.yaml'))).toBe('cloudformation');
    expect(pick('web.cfn', fixture('api-contenedores.json'))).toBe('cloudformation');
    expect(pick('api.json', fixture('api-contenedores.json'))).toBe('cloudformation');
    expect(pick('plan.json', readFileSync('tests/fixtures/importar/terraform/aws-tienda-dev/plan.json', 'utf8'))).toBe('terraform');
    expect(pick(undefined, fixture('sam-notificaciones.yaml'))).toBe('cloudformation');
    // la misma ruta que usan el CLI y el banco de trabajo
    const imported = await importText(platformModule, fixture('tienda-aws.yaml'), undefined, { fallbackName: 'tienda-aws.yaml' });
    expect(imported.importer).toBe('cloudformation');
    expect((imported.document as PlatformDocument).workspace.name).toBe('tienda-aws');
    const named = await importText(platformModule, fixture('tienda-aws.yaml'), 'cloudformation', { name: 'Mi tienda' });
    expect((named.document as PlatformDocument).workspace.name).toBe('Mi tienda');
    await expect(importText(platformModule, '{"Resources": {', 'cloudformation')).rejects.toThrow(/no es JSON válido/);
  });
});
