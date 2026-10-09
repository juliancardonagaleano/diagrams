/**
 * Importador de AWS CloudFormation para el módulo de plataforma. Acepta una plantilla en YAML (con las etiquetas cortas `!Ref`,
 * `!GetAtt`, `!Sub`, `!Join`…, que se leen como datos) o en JSON. Reconoce el formato por `AWSTemplateFormatVersion` o por una
 * sección `Resources` con tipos `AWS::…`. Es el equivalente del importador de Terraform, con la misma correspondencia y las
 * mismas decisiones conservadoras (el detalle por tipo está en `cloudformationSpecs.ts`):
 *
 *   plantilla                                            → elemento del módulo
 *   ---------------------------------------------------------------------------------------------------------------
 *   la plantilla entera                                  → UN entorno. Su nombre sale, por este orden, de un parámetro
 *                                                          `Environment`/`Env`/`Stage` con valor por defecto, la etiqueta
 *                                                          `Environment` más frecuente o el nombre del archivo (aviso).
 *   AWS::EC2::VPC                                        → red (contenedora)
 *   AWS::EC2::Subnet                                     → red hija de su VPC, con su CIDR. `public` si
 *                                                          `MapPublicIpOnLaunch: true`, una ruta a un internet gateway
 *                                                          (tablas de rutas y asociaciones) o un nombre «public»/«dmz»;
 *                                                          `private` en los casos contrarios. Si nada lo dice, privada y se avisa.
 *   EKS, ECS (clúster), EC2, Auto Scaling                → recurso `cluster` o `vm`
 *   RDS, DynamoDB, ElastiCache, SQS, SNS, MSK, S3,
 *   balanceadores, API Gateway, CloudFront, Route 53,
 *   Secrets Manager, KMS, ECR, ACM, CloudWatch           → recurso de su clase; las funciones Lambda y Step Functions son
 *                                                          `other`. Todos con `iac: true`.
 *   AWS::ECS::Service                                    → servicio + despliegue en su clúster (réplicas = `DesiredCount`;
 *                                                          imagen y CPU/memoria de su definición de tarea)
 *   `Ref`, `Fn::GetAtt`, `Fn::Sub` (`${Recurso.Atributo}`)
 *   y `DependsOn` (también a través de definiciones de
 *   tarea, plantillas de lanzamiento, versiones y alias de Lambda)
 *                                                        → dependencia (`data` hacia bases de datos, cachés y almacenes;
 *                                                          `messages` hacia colas; `calls` hacia lo demás)
 *   reglas de ingreso de grupos de seguridad             → dependencia de los miembros del grupo origen hacia los del destino
 *   listeners y grupos de destino de un balanceador      → dependencia balanceador → lo que sirve
 *   registros de Route 53, orígenes de eventos y permisos de Lambda, suscripciones SNS, métodos e integraciones de API Gateway
 *                                                        → dependencia entre los elementos que unen
 *
 * Lo que NO se importa y cómo se avisa (todo va a los avisos, agrupado): tipos desconocidos, recursos de soporte (IAM, grupos de
 * seguridad, rutas, listeners, permisos…) que solo se consultan, pilas anidadas (`TemplateURL` no se descarga: nunca hay red ni
 * disco), recursos personalizados, `Transform` (SAM, `Fn::ForEach`: no se expanden), condiciones (`Condition` y `Fn::If` no se
 * evalúan: el recurso se importa como si se creara siempre), `Fn::FindInMap` y `Mappings`, `Fn::ImportValue` (exportaciones de
 * otras pilas), referencias a recursos que no existen y las secciones que no se interpretan (`Outputs`, `Metadata`, `Rules`…).
 * Los valores de los parámetros con `NoEcho`, las contraseñas y las claves nunca se copian: solo se leen las propiedades que se
 * mapean. Sin red ni disco: ninguna ruta `file://`, URL o `Fn::Transform` se sigue.
 */
import { pickId, Warnings, withoutBom } from '@iark/kernel';
import { formatPlatformIssues, validatePlatformDocument } from '../schema';
import {
  PLATFORM_DOCUMENT_VERSION,
  type Dependency,
  type DependencyKind,
  type Deployment,
  type Environment,
  type Exposure,
  type Network,
  type PlatformDocument,
  type Resource,
  type ResourceKind,
  type Service,
} from '../types';
import { CARRIER_TYPES, SPECS, SUBNET_CARRIERS, isCustomType, isNestedStack, isSupportType, type CfnQuery } from './cloudformationSpecs';
import { countedList, environmentKindOf, shortList, sourceName, uniqueId, type InfraImportOptions } from './common';
import { PlatformImportError, slug, type PlatformImportResult } from './fromMermaid';
import { arr, readStructured, rec, scalarText, type Json } from './yamlText';

const MAX_RESOURCES = 50_000;
const MAX_DEPENDENCIES = 200_000;
const CFN_TYPE = /^[ \t]+Type:[ \t]*["']?(?:AWS|Custom|Alexa)::/m;

/** ¿Parece una plantilla de CloudFormation? `AWSTemplateFormatVersion`, o una sección `Resources` con tipos `AWS::…` (YAML o JSON). */
export function looksLikeCloudFormation(source: string): boolean {
  const t = withoutBom(source);
  if (/^\s*\{/.test(t)) return /"AWSTemplateFormatVersion"\s*:/.test(t) || (/"Resources"\s*:\s*\{/.test(t) && /"Type"\s*:\s*"(?:AWS|Custom|Alexa)::/.test(t));
  return /^AWSTemplateFormatVersion[ \t]*:/m.test(t) || (/^Resources[ \t]*:/m.test(t) && CFN_TYPE.test(t));
}

// ───────────── modelo leído ─────────────

interface Ref {
  /** Id lógico al que apunta. */
  target: string;
  /** Cómo: `Ref Db`, `Fn::GetAtt Db.Endpoint.Address`, `Fn::Sub ${Db}`. */
  how: string;
  /** Propiedad de primer nivel donde está. */
  where: string;
}

interface CfnNode {
  id: string;
  type: string;
  props: Json;
  dependsOn: string[];
  condition?: string;
  refs: Ref[];
  tags: Map<string, string>;
}

type Elem =
  | { kind: 'network'; id: string; node: CfnNode; net: Network }
  | { kind: 'resource'; id: string; node: CfnNode; res: Resource }
  | { kind: 'service'; id: string; node: CfnNode; svc: Service };

interface Candidate {
  source: Elem & { kind: 'resource' | 'service' };
  target: Elem & { kind: 'resource' | 'service' };
  protocol?: string;
  description: string;
  rank: number;
}

const ENV_PARAMETER = /^(?:environment|env|stage|environmentname|envname|deploymentenvironment|appenvironment|environmenttype|envtype)$/i;
const ENV_TAG = /^(?:environment|env|stage|environment_name)$/i;
const OWNER_TAG = /^(?:owner|team|team_owner|squad)$/i;
const NAME_PROPERTIES = ['FunctionName', 'DBInstanceIdentifier', 'DBClusterIdentifier', 'ClusterName', 'BucketName', 'QueueName', 'TopicName', 'TableName', 'RepositoryName', 'DomainName', 'LoadBalancerName', 'StreamName', 'ReplicationGroupId', 'CacheClusterId', 'StateMachineName', 'Name'];
const AVAILABILITY_ZONE = /^[a-z]{2}-[a-z]+-\d[a-z]$/;
const REGION_IN_TEXT = /(?:arn:aws[a-z-]*:[a-z0-9-]+:|\.ecr\.|\.execute-api\.|\.s3[.-]|\.sqs\.|\.rds\.|\.elasticache\.)([a-z]{2}-[a-z]+-\d)\b/;
const WORDS = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const unique = <T>(items: T[]): T[] => [...new Set(items)];

/** Id legible a partir del id lógico (`OrdersDatabase` → `orders-database`). */
const kebab = (logicalId: string): string => slug(logicalId.replace(/([a-z0-9])([A-Z])/g, '$1-$2'));

const shortType = (type: string): string => kebab(type.replace(/^AWS::/, '').replace(/::/g, '-'));

function formatCpu(units: number): string {
  return String(Math.round((units / 1024) * 100) / 100);
}

function formatMemory(mib: number): string {
  return mib >= 1024 && mib % 1024 === 0 ? `${mib / 1024} GiB` : `${mib} MiB`;
}

class CloudFormationBuilder {
  private readonly warnings = new Warnings();
  private readonly taken = new Set<string>();
  private readonly nodes = new Map<string, CfnNode>();
  private readonly params = new Map<string, string>();
  private readonly elems = new Map<string, Elem>();
  private readonly networks: Network[] = [];
  private readonly resources: Resource[] = [];
  private readonly services: Service[] = [];
  private readonly deployments: Deployment[] = [];
  private readonly dependencies: Dependency[] = [];
  private readonly regionVotes = new Map<string, number>();
  private readonly publicIpSubnets = new Set<string>();
  private routeExposure = new Map<string, Exposure>();
  private readonly unknownExposure: string[] = [];
  private readonly mismatches: string[] = [];
  private readonly ignoredEvents = new Set<string>();
  private readonly targetsCache = new Map<CfnNode, CfnNode[]>();
  private referrerIndex: Map<string, CfnNode[]> | undefined;
  private candidateOverflow = false;
  private environmentId = '';
  private imports = 0;
  private transforms = 0;
  private readonly root: Json;
  private readonly resourceEntries: Array<[string, unknown]>;

  constructor(
    root: Json,
    private readonly options: InfraImportOptions,
  ) {
    this.root = root;
    const resources = rec(root.Resources);
    if (!resources) {
      throw new PlatformImportError(
        root.Resources === undefined ? 'La plantilla de CloudFormation no tiene sección «Resources»: no hay nada que importar.' : 'La sección «Resources» de la plantilla no es un mapa de recursos.',
      );
    }
    this.resourceEntries = Object.entries(resources);
    if (this.resourceEntries.length > MAX_RESOURCES) throw new PlatformImportError(`La plantilla tiene ${this.resourceEntries.length} recursos: el máximo que se importa es ${MAX_RESOURCES}.`);
    this.readParameters();
    this.readNodes();
  }

  // ───────────── lectura ─────────────

  private readParameters(): void {
    for (const [name, raw] of Object.entries(rec(this.root.Parameters) ?? {})) {
      const p = rec(raw);
      if (!p || p.NoEcho === true || p.NoEcho === 'true') continue;
      const allowed = arr(p.AllowedValues);
      const value = scalarText(p.Default) ?? (allowed.length === 1 ? scalarText(allowed[0]) : undefined);
      if (value !== undefined) this.params.set(name, value);
    }
  }

  private readNodes(): void {
    const odd: string[] = [];
    const loops: string[] = [];
    for (const [id, raw] of this.resourceEntries) {
      if (id.startsWith('Fn::ForEach::')) {
        loops.push(id);
        continue;
      }
      const r = rec(raw);
      const type = r && typeof r.Type === 'string' ? r.Type.trim() : undefined;
      if (!r || !type) {
        odd.push(id);
        continue;
      }
      const props = rec(r.Properties) ?? {};
      const dependsOn = (Array.isArray(r.DependsOn) ? r.DependsOn : r.DependsOn === undefined ? [] : [r.DependsOn]).filter((d): d is string => typeof d === 'string');
      const node: CfnNode = { id, type, props, dependsOn, refs: [], tags: new Map(), ...(typeof r.Condition === 'string' ? { condition: r.Condition } : {}) };
      this.nodes.set(id, node);
    }
    for (const node of this.nodes.values()) {
      this.collectRefs(node);
      node.tags = this.tagsOf(node.props);
    }
    if (odd.length > 0) this.warnings.add(`${odd.length} recurso(s) sin «Type» o que no son un mapa, que no se importan: ${shortList(odd)}.`);
    if (loops.length > 0) this.warnings.add(`${loops.length} bucle(s) «Fn::ForEach», que no se expanden y no se importan: ${shortList(loops)}.`);
  }

  /** Recorrido iterativo de las propiedades: los `Ref`, `Fn::GetAtt` y `Fn::Sub` que apuntan a otros recursos, y las cadenas que delatan la región. */
  private collectRefs(node: CfnNode): void {
    const stack: Array<{ v: unknown; where: string }> = [];
    for (const [key, v] of Object.entries(node.props).reverse()) stack.push({ v, where: key });
    while (stack.length > 0) {
      const { v, where } = stack.pop()!;
      if (typeof v === 'string') {
        this.voteRegion(v);
        continue;
      }
      if (Array.isArray(v)) {
        for (let i = v.length - 1; i >= 0; i -= 1) stack.push({ v: v[i], where });
        continue;
      }
      const r = rec(v);
      if (!r) continue;
      const keys = Object.keys(r);
      if (keys.length === 1) {
        const key = keys[0];
        const arg = r[key];
        if (key === 'Ref' && typeof arg === 'string') {
          node.refs.push({ target: arg, how: `Ref ${arg}`, where });
          continue;
        }
        if (key === 'Fn::GetAtt') {
          const [resource, attribute] = Array.isArray(arg) ? [arg[0], arg.slice(1).filter((x) => typeof x === 'string').join('.')] : typeof arg === 'string' ? [arg.split('.')[0], arg.split('.').slice(1).join('.')] : [undefined, ''];
          if (typeof resource === 'string' && resource !== '') node.refs.push({ target: resource, how: `Fn::GetAtt ${resource}${attribute ? `.${attribute}` : ''}`, where });
          continue;
        }
        if (key === 'Fn::Sub') {
          const [template, variables] = Array.isArray(arg) ? [arg[0], rec(arg[1])] : [arg, undefined];
          if (typeof template === 'string') {
            this.voteRegion(template);
            for (const m of template.matchAll(/\$\{([^}]+)\}/g)) {
              const name = m[1].trim();
              if (name.startsWith('!') || name.startsWith('AWS::') || (variables && Object.hasOwn(variables, name))) continue;
              node.refs.push({ target: name.split('.')[0], how: `Fn::Sub \${${name}}`, where });
            }
          }
          if (variables) for (const value of Object.values(variables).reverse()) stack.push({ v: value, where });
          continue;
        }
        if (key === 'Fn::ImportValue') {
          this.imports += 1;
          continue;
        }
        if (key === 'Fn::Transform') {
          this.transforms += 1;
          continue;
        }
      }
      for (let i = keys.length - 1; i >= 0; i -= 1) stack.push({ v: r[keys[i]], where });
    }
  }

  private voteRegion(text: string): void {
    if (text.length > 600) return;
    const region = AVAILABILITY_ZONE.test(text) ? text.slice(0, -1) : REGION_IN_TEXT.exec(text)?.[1];
    if (region) this.regionVotes.set(region, (this.regionVotes.get(region) ?? 0) + 1);
  }

  // ───────────── evaluación de valores sencillos ─────────────

  /** Texto de un valor que se puede evaluar sin ejecutar la plantilla: literales, parámetros con valor por defecto, `Fn::Sub` y `Fn::Join` de ellos. */
  private evalStr(value: unknown, depth = 0): string | undefined {
    if (depth > 8) return undefined;
    const text = scalarText(value);
    if (text !== undefined) return text;
    const r = rec(value);
    if (!r) return undefined;
    if (typeof r.Ref === 'string') return this.params.get(r.Ref);
    const sub = r['Fn::Sub'];
    if (sub !== undefined) {
      const [template, variables] = Array.isArray(sub) ? [sub[0], rec(sub[1])] : [sub, undefined];
      if (typeof template !== 'string') return undefined;
      let missing = false;
      const out = template.replace(/\$\{([^}]+)\}/g, (_all, raw: string) => {
        const name = raw.trim();
        if (name.startsWith('!')) return `\${${name.slice(1)}}`;
        const own = variables && Object.hasOwn(variables, name) ? this.evalStr(variables[name], depth + 1) : this.params.get(name);
        if (own === undefined) missing = true;
        return own ?? '';
      });
      return missing ? undefined : out;
    }
    const joined = r['Fn::Join'];
    if (Array.isArray(joined) && typeof joined[0] === 'string' && Array.isArray(joined[1])) {
      const parts = joined[1].map((p) => this.evalStr(p, depth + 1));
      return parts.every((p) => p !== undefined) ? parts.join(joined[0]) : undefined;
    }
    return undefined;
  }

  private tagsOf(props: Json): Map<string, string> {
    const tags = new Map<string, string>();
    const raw = props.Tags;
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const t = rec(item);
        const key = t ? scalarText(t.Key) : undefined;
        const value = t ? this.evalStr(t.Value) : undefined;
        if (key !== undefined && value !== undefined) tags.set(key, value);
      }
    } else {
      for (const [key, value] of Object.entries(rec(raw) ?? {})) {
        const text = this.evalStr(value);
        if (text !== undefined) tags.set(key, text);
      }
    }
    return tags;
  }

  private query(node: CfnNode): CfnQuery {
    const at = (path: string): unknown => {
      let current: unknown = node.props;
      for (const key of path.split('.')) {
        current = Array.isArray(current) ? current[Number(key)] : rec(current) && Object.hasOwn(current as Json, key) ? (current as Json)[key] : undefined;
        if (current === undefined) return undefined;
      }
      return current;
    };
    return {
      props: node.props,
      at,
      str: (p) => this.evalStr(at(p)),
      num: (p) => {
        const n = Number(this.evalStr(at(p)));
        return Number.isFinite(n) ? n : undefined;
      },
      bool: (p) => {
        const v = at(p);
        return v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined;
      },
    };
  }

  // ───────────── referencias ─────────────

  /** Nodos de la plantilla a los que apunta el nodo (por `Ref`, `GetAtt`, `Sub`), sin repetir. */
  private refTargets(node: CfnNode): CfnNode[] {
    const cached = this.targetsCache.get(node);
    if (cached) return cached;
    const seen = new Set<string>();
    const out: CfnNode[] = [];
    for (const r of node.refs) {
      if (r.target === node.id || seen.has(r.target)) continue;
      const target = this.nodes.get(r.target);
      if (target) {
        seen.add(r.target);
        out.push(target);
      }
    }
    this.targetsCache.set(node, out);
    return out;
  }

  /** Quién apunta a un nodo (índice inverso de `refTargets`, construido una vez). */
  private referrers(target: CfnNode): CfnNode[] {
    if (!this.referrerIndex) {
      const index = new Map<string, CfnNode[]>();
      for (const node of this.nodes.values()) for (const t of this.refTargets(node)) (index.get(t.id) ?? index.set(t.id, []).get(t.id)!).push(node);
      this.referrerIndex = index;
    }
    return this.referrerIndex.get(target.id) ?? [];
  }

  /** Nodos a los que apunta un valor suelto (una propiedad de una regla, de un grupo de seguridad). */
  private nodesIn(value: unknown): CfnNode[] {
    const probe: CfnNode = { id: '', type: '', props: { value }, dependsOn: [], refs: [], tags: new Map() };
    this.collectRefs(probe);
    return unique(probe.refs.map((r) => r.target))
      .map((id) => this.nodes.get(id))
      .filter((n): n is CfnNode => !!n);
  }

  // ───────────── construcción ─────────────

  build(): PlatformImportResult {
    const groups = { network: [] as CfnNode[], resource: [] as CfnNode[], service: [] as CfnNode[] };
    const support: string[] = [];
    const unknown: string[] = [];
    const nested: string[] = [];
    const custom: string[] = [];
    for (const node of this.nodes.values()) {
      const spec = SPECS[node.type];
      if (spec) groups[spec.kind === 'network' || spec.kind === 'service' ? spec.kind : 'resource'].push(node);
      else if (isNestedStack(node.type)) nested.push(node.id);
      else if (isCustomType(node.type)) custom.push(node.id);
      else if (isSupportType(node.type)) support.push(node.type);
      else unknown.push(node.type);
    }
    const mapped = [...groups.network, ...groups.resource, ...groups.service];
    if (mapped.length === 0) {
      throw new PlatformImportError(
        `La plantilla de CloudFormation no define ningún recurso que se pueda importar (redes, clústeres, bases de datos, colas, almacenamiento…).${unknown.length > 0 ? ` Tipos sin mapear: ${countedList(unknown)}.` : ''}`,
      );
    }

    const environment = this.createEnvironment();
    this.createNetworks(groups.network);
    this.routeExposure = this.routeEvidence();
    this.collectPublicIps();
    this.linkNetworks();
    this.createResources(groups.resource);
    this.createServices(groups.service);
    this.createDependencies();
    this.reportWarnings({ unknown, support, nested, custom });
    if (this.candidateOverflow) this.warnings.add(`Se alcanzó el máximo de ${MAX_DEPENDENCIES} dependencias candidatas: se omiten las demás.`);

    const description = scalarText(this.root.Description);
    const result = validatePlatformDocument({
      version: PLATFORM_DOCUMENT_VERSION,
      workspace: { name: this.options.name?.trim() || sourceName(this.options) || 'Arquitectura de plataforma', ...(description ? { description: description.replace(/\s+/g, ' ').trim() } : {}) },
      environments: [environment],
      networks: this.networks,
      resources: this.resources,
      services: this.services,
      deployments: this.deployments,
      dependencies: this.dependencies,
      pipelines: [],
    });
    if (!result.ok) throw new PlatformImportError(`No se pudo construir un documento válido a partir de CloudFormation:\n${formatPlatformIssues(result.issues)}`);
    return { document: result.document as PlatformDocument, warnings: this.warnings.result() };
  }

  // ───────────── entorno ─────────────

  private createEnvironment(): Environment {
    let name: string | undefined;
    let reason = '';
    for (const [parameter, value] of this.params) {
      if (ENV_PARAMETER.test(parameter)) {
        name = value;
        reason = `del parámetro «${parameter}»`;
        break;
      }
    }
    if (!name) {
      const counts = new Map<string, number>();
      for (const node of this.nodes.values()) {
        for (const [key, value] of node.tags) if (ENV_TAG.test(key) && value.trim() !== '') counts.set(value.trim(), (counts.get(value.trim()) ?? 0) + 1);
      }
      const ranked = [...counts].sort((a, b) => b[1] - a[1]);
      if (ranked.length > 1) this.warnings.add(`Las etiquetas de entorno de los recursos tienen valores distintos (${ranked.map(([v, n]) => `${v} ×${n}`).join(', ')}): se usa «${ranked[0][0]}» para toda la plantilla.`);
      if (ranked.length > 0) [name, reason] = [ranked[0][0], 'de la etiqueta de entorno de los recursos'];
    }
    if (!name) {
      const fromFile = sourceName(this.options);
      name = fromFile ?? 'Entorno principal';
      reason = fromFile ? 'del nombre del archivo' : 'del valor por defecto';
      this.warnings.add(`No se pudo deducir el entorno de parámetros ni de etiquetas: se crea el entorno «${name}» a partir ${reason}.`);
    }
    this.environmentId = uniqueId(name, 'entorno', this.taken);
    const regions = [...this.regionVotes].sort((a, b) => b[1] - a[1]);
    const region = regions[0]?.[0];
    const kind = environmentKindOf(name);
    return { id: this.environmentId, name, description: `Entorno deducido ${reason}.`, ...(kind ? { kind } : {}), provider: 'aws', ...(region ? { region } : {}) };
  }

  // ───────────── nombres e ids ─────────────

  private explicitName(node: CfnNode): string | undefined {
    const q = this.query(node);
    for (const key of NAME_PROPERTIES) {
      const value = q.str(key);
      if (value && value.trim() !== '') return value.trim();
    }
    return node.tags.get('Name') ?? node.tags.get('name');
  }

  private owner(node: CfnNode): string | undefined {
    const key = [...node.tags.keys()].find((k) => OWNER_TAG.test(k));
    return key ? node.tags.get(key) : undefined;
  }

  private add(el: Elem): void {
    this.elems.set(el.node.id, el);
  }

  // ───────────── redes ─────────────

  private createNetworks(nodes: CfnNode[]): void {
    for (const node of nodes) {
      const q = this.query(node);
      const cidr = q.str('CidrBlock') ?? q.str('Ipv6CidrBlock');
      const net: Network = {
        id: uniqueId(kebab(node.id), shortType(node.type), this.taken),
        name: this.explicitName(node) ?? node.id,
        environmentId: this.environmentId,
        ...(cidr ? { cidr } : {}),
        description: `CloudFormation ${node.id} (${node.type})`,
      };
      this.networks.push(net);
      this.add({ kind: 'network', id: net.id, node, net });
    }
  }

  /** Exposición de las subredes que deduce el código de rutas: tablas con salida a un internet gateway (pública) o solo a un NAT (privada). */
  private routeEvidence(): Map<string, Exposure> {
    const result = new Map<string, Exposure>();
    const tables = new Map<string, { igw: boolean; nat: boolean }>();
    for (const node of this.nodes.values()) {
      if (node.type !== 'AWS::EC2::Route') continue;
      const igw = this.nodesIn(node.props.GatewayId).some((n) => n.type === 'AWS::EC2::InternetGateway');
      const nat = this.nodesIn(node.props.NatGatewayId).some((n) => n.type === 'AWS::EC2::NatGateway');
      for (const table of this.nodesIn(node.props.RouteTableId)) {
        const current = tables.get(table.id) ?? { igw: false, nat: false };
        tables.set(table.id, { igw: current.igw || igw, nat: current.nat || nat });
      }
    }
    for (const node of this.nodes.values()) {
      if (node.type !== 'AWS::EC2::SubnetRouteTableAssociation') continue;
      const flags = this.nodesIn(node.props.RouteTableId).map((t) => tables.get(t.id)).filter((f): f is { igw: boolean; nat: boolean } => !!f);
      const exposure: Exposure | undefined = flags.some((f) => f.igw) ? 'public' : flags.some((f) => f.nat) ? 'private' : undefined;
      if (!exposure) continue;
      for (const subnet of this.nodesIn(node.props.SubnetId)) if (result.get(subnet.id) !== 'public') result.set(subnet.id, exposure);
    }
    return result;
  }

  /** Subredes donde hay una instancia con IP pública. */
  private collectPublicIps(): void {
    for (const node of this.nodes.values()) {
      if (node.type !== 'AWS::EC2::Instance') continue;
      const q = this.query(node);
      const interfaces = arr(q.at('NetworkInterfaces')).map(rec);
      if (!interfaces.some((n) => n && (n.AssociatePublicIpAddress === true || n.AssociatePublicIpAddress === 'true'))) continue;
      for (const el of this.networkCandidates(node)) this.publicIpSubnets.add(el.node.id);
    }
  }

  private subnetExposure(el: Elem & { kind: 'network' }): { exposure: Exposure; known: boolean } {
    const q = this.query(el.node);
    const mapPublic = q.bool('MapPublicIpOnLaunch');
    const route = this.routeExposure.get(el.node.id);
    const hint = WORDS(`${el.node.id} ${el.node.tags.get('Name') ?? ''}`);
    if (mapPublic === true) return { exposure: 'public', known: true };
    if (route === 'public') return { exposure: 'public', known: true };
    if (el.node.tags.has('kubernetes.io/role/elb')) return { exposure: 'public', known: true };
    if (el.node.tags.has('kubernetes.io/role/internal-elb')) return { exposure: 'private', known: true };
    if (route === 'private') return { exposure: 'private', known: true };
    if (mapPublic === false) return { exposure: 'private', known: true };
    if (hint.some((w) => w === 'public' || w === 'publica' || w === 'dmz')) return { exposure: 'public', known: true };
    if (hint.some((w) => ['private', 'privada', 'privado', 'internal', 'interna', 'interno', 'data', 'datos', 'database', 'db', 'intra', 'backend'].includes(w))) return { exposure: 'private', known: true };
    if (this.publicIpSubnets.has(el.node.id)) return { exposure: 'public', known: true };
    return { exposure: 'private', known: false };
  }

  /** Enlaza cada subred con su VPC y fija su exposición. */
  private linkNetworks(): void {
    for (const el of this.elems.values()) {
      if (el.kind !== 'network' || SPECS[el.node.type]?.container) continue;
      const parent = this.refTargets(el.node)
        .filter((n) => SPECS[n.type]?.container)
        .map((n) => this.elems.get(n.id))
        .find((e): e is Elem & { kind: 'network' } => e?.kind === 'network');
      if (parent) el.net.parentId = parent.id;
      const { exposure, known } = this.subnetExposure(el);
      el.net.exposure = exposure;
      if (!known) this.unknownExposure.push(el.net.name);
    }
  }

  /** Redes donde puede estar un recurso: las que nombra, a través de grupos de subredes o interfaces y, en último caso, la VPC de sus grupos de seguridad. */
  private networkCandidates(node: CfnNode): Array<Elem & { kind: 'network' }> {
    const found: Array<Elem & { kind: 'network' }> = [];
    const take = (n: CfnNode): void => {
      const el = this.elems.get(n.id);
      if (el?.kind === 'network' && !found.includes(el)) found.push(el);
    };
    const direct = this.refTargets(node);
    direct.forEach(take);
    for (const carrier of direct.filter((n) => SUBNET_CARRIERS.test(n.type))) this.refTargets(carrier).forEach(take);
    if (found.length === 0) for (const sg of direct.filter((n) => n.type === 'AWS::EC2::SecurityGroup')) this.refTargets(sg).forEach(take);
    return found;
  }

  private placement(node: CfnNode, sensitive: boolean): string | undefined {
    const candidates = this.networkCandidates(node);
    const subnets = candidates.filter((c) => c.net.parentId !== undefined);
    const pool = subnets.length > 0 ? subnets : candidates;
    if (pool.length === 0) return undefined;
    const isPublic = (c: Elem & { kind: 'network' }): boolean => c.net.exposure === 'public';
    return (sensitive ? (pool.find(isPublic) ?? pool[0]) : (pool.find((c) => !isPublic(c)) ?? pool[0])).id;
  }

  // ───────────── recursos ─────────────

  private createResources(nodes: CfnNode[]): void {
    for (const node of nodes) {
      const spec = SPECS[node.type];
      const kind = spec.kind as ResourceKind;
      const q = this.query(node);
      const technology = typeof spec.technology === 'function' ? spec.technology(q) : spec.technology;
      const version = spec.version?.(q);
      const extras = [...(spec.extra?.(q) ?? [])];
      if (node.condition) extras.push(`condicional (${node.condition})`);
      const networkId = this.placement(node, ['database', 'cache', 'queue', 'secret-store'].includes(kind));
      const owner = this.owner(node);
      const res: Resource = {
        id: uniqueId(kebab(node.id), shortType(node.type), this.taken),
        name: this.explicitName(node) ?? node.id,
        kind,
        environmentId: this.environmentId,
        ...(networkId ? { networkId } : {}),
        ...(technology ? { technology } : {}),
        ...(version ? { version } : {}),
        iac: true,
        ...(owner ? { owner } : {}),
        description: [`CloudFormation ${node.id} (${node.type})`, ...extras].filter(Boolean).join(' · '),
      };
      this.resources.push(res);
      this.add({ kind: 'resource', id: res.id, node, res });
      if (q.bool('PubliclyAccessible') === true) {
        const net = networkId ? this.networks.find((n) => n.id === networkId) : undefined;
        if (!net || net.exposure !== 'public') this.mismatches.push(`«${res.name}» (${node.id}) tiene PubliclyAccessible: true pero ${net ? `está en la red ${net.exposure === 'private' ? 'privada' : 'no pública'} «${net.name}»` : 'no se sabe en qué red está'}: el modelo no refleja esa exposición.`);
      }
    }
  }

  // ───────────── servicios (ECS) ─────────────

  /** Imagen (si es un literal) y etiqueta de la primera definición de contenedor de una definición de tarea. */
  private firstContainer(task: CfnNode): { image?: string; version?: string } {
    const first = rec(arr(task.props.ContainerDefinitions)[0]);
    const raw = first?.Image;
    const image = this.evalStr(raw);
    // La etiqueta se lee de la plantilla aunque el registro dependa de parámetros (`${AWS::AccountId}.dkr.ecr.….com/api:1.4.2`).
    const template = typeof raw === 'string' ? raw : rec(raw) && typeof rec(raw)!['Fn::Sub'] === 'string' ? (rec(raw)!['Fn::Sub'] as string) : undefined;
    const tag = /:([^:/@}\s]+)$/.exec(image ?? template ?? '')?.[1];
    return { ...(image ? { image } : {}), ...(tag && !tag.startsWith('$') ? { version: tag } : {}) };
  }

  private createServices(nodes: CfnNode[]): void {
    for (const node of nodes) {
      const q = this.query(node);
      const related = this.refTargets(node);
      const hostNode = related.find((n) => n.type === 'AWS::ECS::Cluster');
      const host = hostNode ? this.elems.get(hostNode.id) : undefined;
      const task = related.find((n) => n.type === 'AWS::ECS::TaskDefinition');
      const container = task ? this.firstContainer(task) : {};
      const launch = q.str('LaunchType') ?? (q.at('CapacityProviderStrategy') !== undefined ? 'capacity provider' : undefined);
      const owner = this.owner(node);
      const svc: Service = {
        id: uniqueId(kebab(node.id), shortType(node.type), this.taken),
        name: this.explicitName(node) ?? q.str('ServiceName') ?? node.id,
        technology: launch ? `Amazon ECS (${launch})` : 'Amazon ECS',
        ...(owner ? { owner } : {}),
        description: [container.image ? `Imagen ${container.image}` : undefined, `CloudFormation ${node.id} (${node.type})`].filter(Boolean).join(' · '),
      };
      this.services.push(svc);
      this.add({ kind: 'service', id: svc.id, node, svc });
      if (!host || host.kind !== 'resource') {
        this.warnings.add(`El servicio ${node.id} no referencia ningún clúster ECS de la plantilla: se importa sin despliegue.`);
        continue;
      }
      const desired = q.num('DesiredCount');
      if (desired === 0) this.warnings.add(`El servicio ${node.id} tiene DesiredCount: 0: se importa sin réplicas indicadas.`);
      const cpu = task ? Number(this.query(task).str('Cpu')) : NaN;
      const memory = task ? Number(this.query(task).str('Memory')) : NaN;
      this.deployments.push({
        id: pickId(`${svc.id}-${this.environmentId}`, new Set(this.deployments.map((d) => d.id))),
        serviceId: svc.id,
        environmentId: this.environmentId,
        hostId: host.id,
        ...(desired !== undefined && Number.isInteger(desired) && desired >= 1 ? { replicas: desired } : {}),
        ...(container.version ? { version: container.version } : {}),
        ...(Number.isFinite(cpu) && cpu > 0 ? { cpuLimit: formatCpu(cpu) } : {}),
        ...(Number.isFinite(memory) && memory > 0 ? { memoryLimit: formatMemory(memory) } : {}),
      });
    }
  }

  // ───────────── dependencias ─────────────

  private endpoint(node: CfnNode | undefined): (Elem & { kind: 'resource' | 'service' }) | undefined {
    const el = node ? this.elems.get(node.id) : undefined;
    return el && el.kind !== 'network' ? el : undefined;
  }

  private dependencyKind(target: Elem & { kind: 'resource' | 'service' }): DependencyKind {
    if (target.kind === 'service') return 'calls';
    if (target.res.kind === 'queue') return 'messages';
    if (['database', 'cache', 'storage'].includes(target.res.kind)) return 'data';
    return 'calls';
  }

  /** Referencias y `DependsOn` de un nodo; en una función de SAM no se cuentan los `Events`, que se interpretan al revés (los dispara el origen). */
  private entriesOf(node: CfnNode): Array<{ target: CfnNode; how: string; explicit: boolean }> {
    const out: Array<{ target: CfnNode; how: string; explicit: boolean }> = [];
    const seen = new Set<string>();
    let events = 0;
    for (const r of node.refs) {
      if (node.type === 'AWS::Serverless::Function' && r.where === 'Events') {
        events += 1;
        continue;
      }
      const target = this.nodes.get(r.target);
      if (!target || target === node || seen.has(r.target)) continue;
      seen.add(r.target);
      out.push({ target, how: `${r.how} en «${r.where}»`, explicit: false });
    }
    if (events > 0) this.ignoredEvents.add(node.id);
    for (const id of node.dependsOn) {
      const target = this.nodes.get(id);
      if (!target || target === node || seen.has(id)) continue;
      seen.add(id);
      out.push({ target, how: `DependsOn ${id}`, explicit: true });
    }
    return out;
  }

  /** Elementos que usan un nodo (lo referencian, directamente o a través de una plantilla de lanzamiento o una definición de tarea). */
  private members(target: CfnNode): CfnNode[] {
    const out: CfnNode[] = [];
    const seen = new Set<string>([target.id]);
    const queue = [...this.referrers(target)];
    for (let head = 0; head < queue.length; head += 1) {
      const node = queue[head];
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      if (this.endpoint(node)) out.push(node);
      else if (CARRIER_TYPES.test(node.type)) queue.push(...this.referrers(node));
    }
    return out;
  }

  private portText(block: Json): string | undefined {
    const proto = scalarText(block.IpProtocol);
    if (proto === '-1') return 'todo el tráfico';
    const from = Number(this.evalStr(block.FromPort));
    const to = Number(this.evalStr(block.ToPort));
    const name = (proto ?? 'tcp').toLowerCase();
    if (!Number.isFinite(from)) return proto ? name : undefined;
    return from === to || !Number.isFinite(to) ? `${name}/${from}` : `${name}/${from}-${to}`;
  }

  private createDependencies(): void {
    const candidates: Candidate[] = [];
    const push = (source: Elem | undefined, target: Elem | undefined, rank: number, description: string, protocol?: string): void => {
      if (!source || !target || source.kind === 'network' || target.kind === 'network' || source.id === target.id) return;
      if (candidates.length >= MAX_DEPENDENCIES) {
        this.candidateOverflow = true;
        return;
      }
      candidates.push({ source, target, rank, description, ...(protocol ? { protocol } : {}) });
    };
    const link = (sources: CfnNode[], targets: CfnNode[], rank: number, description: string, protocol?: string): void => {
      for (const s of sources) for (const t of targets) if (s !== t) push(this.endpoint(s), this.endpoint(t), rank, description, protocol);
    };

    this.securityGroupDependencies(link);
    this.balancerDependencies(link);
    this.glueDependencies(link);

    // Referencias entre recursos, también a través de definiciones de tarea, plantillas de lanzamiento, versiones y alias.
    for (const node of this.nodes.values()) {
      const source = this.endpoint(node);
      if (!source) continue;
      const host = node.type === 'AWS::ECS::Service' ? this.refTargets(node).find((n) => n.type === 'AWS::ECS::Cluster') : undefined;
      const seen = new Set<string>([node.id]);
      const queue = this.entriesOf(node).map((e) => ({ ...e, via: undefined as string | undefined }));
      for (let head = 0; head < queue.length; head += 1) {
        const { target, how, explicit, via } = queue[head];
        if (seen.has(target.id)) continue;
        seen.add(target.id);
        if (this.elems.has(target.id)) {
          if (target === host) continue;
          push(source, this.endpoint(target), explicit && !via ? 3 : 2, `${how}${via ? ` (vía ${via})` : ''}`);
        } else if (CARRIER_TYPES.test(target.type)) {
          for (const next of this.entriesOf(target)) queue.push({ ...next, via: via ?? target.id });
        }
      }
    }

    const ids = new Set<string>();
    const signatures = new Set<string>();
    for (const c of [...candidates].sort((a, b) => a.rank - b.rank)) {
      const kind = this.dependencyKind(c.target);
      const signature = `${kind}|${c.source.id}|${c.target.id}`;
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      this.dependencies.push({ id: pickId(`${c.source.id}--${c.target.id}`, ids), sourceId: c.source.id, targetId: c.target.id, kind, ...(c.protocol ? { protocol: c.protocol } : {}), description: c.description });
    }
  }

  /** Reglas de ingreso entre grupos de seguridad: quien pertenece al grupo origen puede llamar a quien pertenece al destino. */
  private securityGroupDependencies(link: (s: CfnNode[], t: CfnNode[], rank: number, description: string, protocol?: string) => void): void {
    const rules: Array<{ via: string; targets: CfnNode[]; sources: CfnNode[]; block: Json }> = [];
    for (const node of this.nodes.values()) {
      if (node.type === 'AWS::EC2::SecurityGroup') {
        for (const block of arr(node.props.SecurityGroupIngress).map(rec)) {
          const sources = block ? this.nodesIn(block.SourceSecurityGroupId) : [];
          if (block && sources.length > 0) rules.push({ via: `Ingreso ${node.id}`, targets: [node], sources, block });
        }
      } else if (node.type === 'AWS::EC2::SecurityGroupIngress') {
        const sources = this.nodesIn(node.props.SourceSecurityGroupId);
        const targets = this.nodesIn(node.props.GroupId);
        if (sources.length > 0 && targets.length > 0) rules.push({ via: `Regla ${node.id}`, targets, sources, block: node.props });
      }
    }
    for (const { via, targets, sources, block } of rules) {
      const protocol = this.portText(block);
      for (const target of targets) {
        const destination = this.endpoint(target) ? [target] : this.members(target);
        for (const source of sources) {
          if (source === target) continue;
          link(this.endpoint(source) ? [source] : this.members(source), destination, 0, via, protocol);
        }
      }
    }
  }

  /** Balanceador → lo que sirve (por sus listeners, reglas y grupos de destino). */
  private balancerDependencies(link: (s: CfnNode[], t: CfnNode[], rank: number, description: string, protocol?: string) => void): void {
    for (const lb of this.nodes.values()) {
      if (!/^AWS::ElasticLoadBalancing(?:V2)?::LoadBalancer$/.test(lb.type) || !this.elems.has(lb.id)) continue;
      for (const listener of this.referrers(lb).filter((n) => n.type === 'AWS::ElasticLoadBalancingV2::Listener')) {
        const rules = this.referrers(listener).filter((n) => n.type === 'AWS::ElasticLoadBalancingV2::ListenerRule');
        const groups = unique([...this.refTargets(listener), ...rules.flatMap((r) => this.refTargets(r))].filter((n) => n.type === 'AWS::ElasticLoadBalancingV2::TargetGroup'));
        const protocol = this.query(listener).str('Protocol')?.toUpperCase();
        for (const group of groups) {
          const users = this.referrers(group).filter((n) => n !== lb && this.endpoint(n));
          const targets = this.refTargets(group).filter((n) => this.endpoint(n));
          link([lb], unique([...users, ...targets]), 1, `Listener ${listener.id} (grupo ${group.id})`, protocol);
        }
      }
    }
  }

  /** Sigue las versiones y alias de Lambda hasta la función que publican; el resto de nodos pasa tal cual. */
  private publishedFunctions(nodes: CfnNode[]): CfnNode[] {
    const out: CfnNode[] = [];
    const seen = new Set<string>();
    const queue = [...nodes];
    for (let head = 0; head < queue.length; head += 1) {
      const node = queue[head];
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      if (/^AWS::Lambda::(?:Version|Alias)$/.test(node.type)) queue.push(...this.refTargets(node));
      else out.push(node);
    }
    return out;
  }

  /** Recursos que solo existen para unir otros dos: registros DNS, orígenes de eventos y permisos de Lambda, suscripciones SNS, métodos e integraciones de API Gateway. */
  private glueDependencies(link: (s: CfnNode[], t: CfnNode[], rank: number, description: string, protocol?: string) => void): void {
    for (const node of this.nodes.values()) {
      switch (node.type) {
        case 'AWS::Route53::RecordSet':
        case 'AWS::Route53::RecordSetGroup': {
          const related = this.refTargets(node).filter((n) => this.endpoint(n));
          const zones = related.filter((n) => SPECS[n.type]?.kind === 'dns');
          link(zones, related.filter((n) => !zones.includes(n)), 2, `Registro ${node.id}`);
          break;
        }
        case 'AWS::Lambda::EventSourceMapping':
          link(this.publishedFunctions(this.nodesIn(node.props.FunctionName)), this.nodesIn(node.props.EventSourceArn), 1, `Origen de eventos ${node.id}`);
          break;
        case 'AWS::Lambda::Permission':
          link(this.nodesIn(node.props.SourceArn), this.publishedFunctions(this.nodesIn(node.props.FunctionName)), 1, `Permiso ${node.id}`);
          break;
        case 'AWS::SNS::Subscription':
          link(this.nodesIn(node.props.TopicArn), this.publishedFunctions(this.nodesIn(node.props.Endpoint)), 1, `Suscripción ${node.id}`);
          break;
        case 'AWS::ApiGateway::Method':
        case 'AWS::ApiGatewayV2::Integration': {
          const api = this.nodesIn(node.type === 'AWS::ApiGateway::Method' ? node.props.RestApiId : node.props.ApiId);
          link(api, this.publishedFunctions(this.refTargets(node)).filter((n) => !api.includes(n) && this.endpoint(n)), 1, `${node.type === 'AWS::ApiGateway::Method' ? 'Método' : 'Integración'} ${node.id}`);
          break;
        }
        default:
      }
    }
  }

  // ───────────── avisos ─────────────

  private reportWarnings(w: { unknown: string[]; support: string[]; nested: string[]; custom: string[] }): void {
    const n = (count: number, one: string, many: string): string => (count === 1 ? one : many.replace('{n}', String(count)));
    if (w.unknown.length > 0) this.warnings.add(`${n(w.unknown.length, '1 recurso de un tipo sin mapear, que no se importa', '{n} recursos de tipos sin mapear, que no se importan')}: ${countedList(w.unknown)}.`);
    if (w.support.length > 0) {
      this.warnings.add(`${n(w.support.length, '1 recurso de soporte que no se dibuja', '{n} recursos de soporte que no se dibujan')} (solo se consultan para deducir redes, exposición y dependencias): ${countedList(w.support)}.`);
    }
    if (w.nested.length > 0) this.warnings.add(`${n(w.nested.length, '1 pila anidada', '{n} pilas anidadas')} (AWS::CloudFormation::Stack): su plantilla (TemplateURL) no se descarga ni se lee, así que su contenido no se importa: ${shortList(w.nested)}.`);
    if (w.custom.length > 0) this.warnings.add(`${n(w.custom.length, '1 recurso personalizado', '{n} recursos personalizados')} (Custom::…): su lógica no se ejecuta ni se importa: ${shortList(w.custom)}.`);
    const transform = this.root.Transform;
    if (transform !== undefined) {
      const list = (Array.isArray(transform) ? transform : [transform]).map((t) => (typeof t === 'string' ? t : rec(t) && typeof (t as Json).Name === 'string' ? ((t as Json).Name as string) : '')).filter(Boolean);
      this.warnings.add(`La plantilla usa Transform (${shortList(list.length > 0 ? list : ['sin nombre'], 3)}) y no se expande: solo se importan los recursos tal como están escritos${list.some((t) => /Serverless/.test(t)) ? ' (los eventos de las funciones de SAM, la API implícita y los roles que generaría no aparecen)' : ''}.`);
    }
    if (this.ignoredEvents.size > 0) this.warnings.add(`${n(this.ignoredEvents.size, '1 función de SAM', '{n} funciones de SAM')} con «Events», que no se interpretan: ${shortList([...this.ignoredEvents])}.`);
    if (this.transforms > 0) this.warnings.add(`${n(this.transforms, '1 uso de Fn::Transform', '{n} usos de Fn::Transform')} (macros e Include): no se siguen, nunca se descarga nada.`);
    const conditional = [...this.nodes.values()].filter((x) => x.condition && this.elems.has(x.id)).map((x) => x.id);
    const conditions = rec(this.root.Conditions);
    if (conditional.length > 0 || (conditions && Object.keys(conditions).length > 0)) {
      this.warnings.add(`Las condiciones (Conditions, Fn::If) no se evalúan: ${conditional.length > 0 ? `${n(conditional.length, '1 recurso con Condition se importa', '{n} recursos con Condition se importan')} como si se crearan siempre (${shortList(conditional)})` : 'se ignoran'}.`);
    }
    if (this.imports > 0) this.warnings.add(`${n(this.imports, '1 referencia', '{n} referencias')} a exportaciones de otras pilas (Fn::ImportValue) no se resuelven: no se infieren esas dependencias.`);
    const broken = new Set<string>();
    for (const node of this.nodes.values()) {
      for (const r of node.refs) if (!this.nodes.has(r.target) && !this.params.has(r.target) && !this.isDeclaredParameter(r.target) && !r.target.startsWith('AWS::')) broken.add(r.target);
      for (const d of node.dependsOn) if (!this.nodes.has(d)) broken.add(d);
    }
    if (broken.size > 0) this.warnings.add(`${n(broken.size, '1 referencia', '{n} referencias')} a recursos que no existen en la plantilla (Ref, GetAtt, Sub o DependsOn): ${shortList([...broken].sort())}.`);
    if (this.unknownExposure.length > 0) {
      this.warnings.add(
        `${n(this.unknownExposure.length, '1 red sin dato de exposición', '{n} redes sin dato de exposición')} (ni MapPublicIpOnLaunch, ni ruta a un internet gateway, ni nombre o etiqueta que lo indique): se importan como privadas: ${shortList(this.unknownExposure)}.`,
      );
    }
    for (const m of this.mismatches) this.warnings.add(m);
    const sections = ['Mappings', 'Globals', 'Outputs', 'Metadata', 'Rules', 'Hooks']
      .map((key) => [key, rec(this.root[key]) ? Object.keys(rec(this.root[key])!).length : 0] as const)
      .filter(([, count]) => count > 0);
    if (sections.length > 0) this.warnings.add(`Secciones de la plantilla que no se interpretan: ${sections.map(([key, count]) => `${key} (${count})`).join(', ')}.`);
  }

  private isDeclaredParameter(name: string): boolean {
    return rec(this.root.Parameters) !== undefined && Object.hasOwn(rec(this.root.Parameters)!, name);
  }
}

/** Importa una plantilla de CloudFormation (YAML con etiquetas cortas, o JSON) como documento de plataforma. */
export function fromCloudFormation(source: string, options: InfraImportOptions = {}): PlatformImportResult {
  const root = readStructured(source, 'El archivo de CloudFormation', { cfnTags: true });
  const template = rec(root);
  if (!template) {
    const what = Array.isArray(root) ? 'una lista' : root === null ? 'vacía' : `un valor de tipo ${typeof root}`;
    throw new PlatformImportError(`La plantilla de CloudFormation es ${what}: se esperaba un mapa con la sección «Resources».`);
  }
  return new CloudFormationBuilder(template, options).build();
}
