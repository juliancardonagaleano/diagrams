import { readFileSync } from 'node:fs';
import { ModuleError, ModuleRegistry } from '@iark/kernel';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { toDrawio } from '../export/drawio';
import { toMermaid } from '../export/mermaid';
import { toSvg } from '../export/render';
import { analyzeData } from '../issues';
import { dataModule } from '../module';
import { validateDataDocument } from '../schema';
import { findView, listViews } from '../views';
import type { DataDocument } from '../types';
import { fromDbt } from './fromDbt';
import { fromDdl, looksLikeDdl } from './fromDdl';
import { DataImportError, fromMermaid } from './fromMermaid';

const fixture = (name: string): string => readFileSync(`tests/fixtures/importar/ddl/${name}.sql`, 'utf8');
const asset = (doc: DataDocument, id: string) => {
  const found = doc.assets.find((a) => a.id === id);
  if (!found) throw new Error(`No hay activo «${id}»: ${doc.assets.map((a) => a.id).join(', ')}`);
  return found;
};
const relation = (doc: DataDocument, source: string, target: string) => doc.relations.find((r) => r.sourceId === source && r.targetId === target);
const columns = (doc: DataDocument, id: string) => Object.fromEntries((asset(doc, id).columns ?? []).map((c) => [c.name, c]));
const warn = (warnings: string[], fragment: string): string | undefined => warnings.find((w) => w.includes(fragment));
/** Importa un DDL pequeño, escrito en la propia prueba. */
const small = (sql: string) => fromDdl(sql, { name: 'Prueba' });

describe('DDL de PostgreSQL (volcado de la tienda)', () => {
  const { document: doc, warnings } = fromDdl(fixture('tienda-postgres'), { fallbackName: 'tienda-postgres.sql' });

  it('valida, pasa por las reglas de gobierno sin errores y toma el nombre del archivo', () => {
    expect(validateDataDocument(doc).ok).toBe(true);
    expect(doc.workspace.name).toBe('tienda-postgres');
    expect(analyzeData(doc).filter((i) => i.severity === 'error')).toEqual([]);
    expect(fromDdl(fixture('tienda-postgres'), { name: 'Mi tienda', fallbackName: 'x.sql' }).document.workspace.name).toBe('Mi tienda');
  });

  it('cada esquema es un contenedor del que cuelgan sus tablas y vistas, con su comentario', () => {
    expect(asset(doc, 'tienda')).toMatchObject({ kind: 'database', name: 'tienda', description: 'Datos operacionales de la tienda en línea' });
    expect(asset(doc, 'analitica')).toMatchObject({ kind: 'database', description: 'Esquema «analitica» del DDL importado.' });
    expect(doc.assets.filter((a) => a.kind === 'table' && a.parentId === 'tienda').map((a) => a.name)).toEqual(['clientes', 'direcciones', 'perfiles', 'categorias', 'productos', 'pedidos', 'pedido_lineas', 'pagos']);
    expect(asset(doc, 'analitica-cache-resumen')).toMatchObject({ kind: 'table', parentId: 'analitica' });
    expect(doc.domains).toEqual([]);
  });

  it('las columnas llevan tipo con parámetros, claves, nulos y comentarios (COMMENT ON incluido)', () => {
    const c = columns(doc, 'tienda-clientes');
    expect(c.id).toEqual({ name: 'id', type: 'uuid', keys: ['pk'] });
    expect(c.email).toEqual({ name: 'email', type: 'character varying(255)', keys: ['uk'], description: 'Correo con el que inicia sesión' });
    expect(c.telefono).toEqual({ name: 'telefono', type: 'character varying(20)', nullable: true });
    expect(c.creado_en.type).toBe('timestamp with time zone');
    expect(asset(doc, 'tienda-clientes').description).toBe('Personas que compran en la tienda');
    expect(columns(doc, 'tienda-productos').precio.type).toBe('numeric(12,2)');
    expect(columns(doc, 'tienda-productos').etiquetas).toEqual({ name: 'etiquetas', type: 'text[]', nullable: true });
    expect(columns(doc, 'tienda-pedidos').estado.description).toBe('nuevo, pagado, enviado o cancelado');
  });

  it('las claves de ALTER TABLE ... ADD CONSTRAINT se aplican, también las compuestas', () => {
    const lineas = columns(doc, 'tienda-pedido-lineas');
    expect(lineas.pedido_id.keys).toEqual(['pk', 'fk']);
    expect(lineas.linea.keys).toEqual(['pk']);
    expect(lineas.producto_id.keys).toEqual(['fk']);
    expect(columns(doc, 'tienda-productos').sku.keys).toEqual(['uk']);
    // La clave primaria no admite nulos; sin NOT NULL ni clave, la columna es anulable.
    expect(columns(doc, 'tienda-pedidos').id.nullable).toBeUndefined();
    expect(columns(doc, 'tienda-pedidos').direccion_id).toMatchObject({ keys: ['fk'], nullable: true });
  });

  it('cada clave foránea es una relación con el padre como origen y la cardinalidad decidida por la unicidad', () => {
    expect(doc.relations.map((r) => [r.sourceId, r.targetId, r.cardinality])).toEqual([
      ['tienda-clientes', 'tienda-direcciones', '1:N'],
      ['tienda-clientes', 'tienda-perfiles', '1:1'], // la clave foránea es la clave primaria
      ['tienda-categorias', 'tienda-productos', '1:N'],
      ['tienda-clientes', 'tienda-pedidos', '1:N'],
      ['tienda-direcciones', 'tienda-pedidos', '1:N'],
      ['tienda-pedidos', 'tienda-pedido-lineas', '1:N'],
      ['tienda-productos', 'tienda-pedido-lineas', '1:N'],
      ['tienda-pedidos', 'tienda-pagos', '1:1'], // la clave foránea tiene UNIQUE
    ]);
  });

  it('la opcionalidad y la unicidad van anotadas en la descripción de la relación', () => {
    const d = (s: string, t: string) => relation(doc, s, t)!.description;
    expect(d('tienda-clientes', 'tienda-pedidos')).toBe('cliente_id · 1..1 → 0..N'); // NOT NULL: cada pedido tiene un cliente
    expect(d('tienda-direcciones', 'tienda-pedidos')).toBe('direccion_id · 0..1 → 0..N'); // anulable
    expect(d('tienda-clientes', 'tienda-perfiles')).toBe('cliente_id · 1..1 → 0..1'); // única
    expect(d('tienda-categorias', 'tienda-productos')).toBe('categoria_id · 0..1 → 0..N');
  });

  it('una clave foránea de una tabla a sí misma no es una relación: se marca la columna y se avisa', () => {
    expect(columns(doc, 'tienda-categorias').padre_id.keys).toEqual(['fk']);
    expect(warn(warnings, 'recursivas')).toMatch(/«categorias» se refiere a sí misma \(padre_id\)/);
  });

  it('las vistas son activos con un pipeline elt desde las tablas del FROM y el JOIN, con el linaje de columnas', () => {
    expect(asset(doc, 'analitica-ventas-por-cliente')).toMatchObject({ kind: 'view', parentId: 'analitica' });
    const p = doc.pipelines.find((x) => x.outputs[0] === 'analitica-ventas-por-cliente')!;
    expect(p).toMatchObject({ name: 'Vista ventas_por_cliente', kind: 'elt', tool: 'SQL', schedule: 'en cada consulta', inputs: ['tienda-clientes', 'tienda-pedidos'] });
    expect(columns(doc, 'analitica-ventas-por-cliente').cliente_id).toEqual({ name: 'cliente_id', type: 'uuid' }); // el tipo viene de la tabla
    expect((p.mappings ?? []).map((m) => `${m.from.assetId}.${m.from.column} -> ${m.to.column} (${m.transform})`)).toEqual([
      'tienda-clientes.id -> cliente_id (copia)',
      'tienda-clientes.pais -> pais (copia)',
      'tienda-pedidos.id -> pedidos (count(DISTINCT p.id))',
      'tienda-pedidos.total -> total_gastado (sum(p.total))',
      'tienda-pedidos.creado_en -> ultimo_pedido (max(p.creado_en))',
    ]);
  });

  it('una vista materializada con CTE y subconsultas lee sus tablas (sin contar el CTE) y conserva los nombres de columna', () => {
    expect(asset(doc, 'analitica-productos-top')).toMatchObject({ kind: 'view', tags: ['materializada'] });
    const p = doc.pipelines.find((x) => x.outputs[0] === 'analitica-productos-top')!;
    expect(p.name).toBe('Vista materializada productos_top');
    expect(p.inputs).toEqual(['tienda-pedido-lineas', 'tienda-productos']);
    expect(p.schedule).toBeUndefined(); // cuándo se refresca no lo dice el DDL
    expect(p.mappings).toBeUndefined(); // con un CTE los alias podrían esconder otras tablas: no se enlazan columnas
    expect((asset(doc, 'analitica-productos-top').columns ?? []).map((c) => c.name)).toEqual(['id', 'nombre', 'unidades']);
  });

  it('un SELECT que no lee ninguna tabla se avisa y la vista queda sin pipeline', () => {
    expect(doc.pipelines.some((p) => p.outputs.includes('analitica-generador'))).toBe(false);
    expect(warn(warnings, 'analitica.generador')).toMatch(/línea \d+: no se pudo deducir el linaje de la vista «analitica\.generador» \(solo lee funciones de tabla\); se importa sin pipeline/);
  });

  it('lo que el modelo no recoge se cuenta en un aviso (defaults, CHECK, índices, secuencias, funciones, permisos)', () => {
    expect(warn(warnings, 'Sin mapear')).toBe('Sin mapear (el modelo de datos no los recoge): 8 valor(es) por defecto, 1 restricción(es) CHECK, 1 × CREATE SEQUENCE, 1 × CREATE FUNCTION, 2 × CREATE INDEX, 1 × GRANT.');
  });

  it('NO marca datos personales ni clasifica por el nombre de las columnas: solo lo sugiere en un aviso', () => {
    expect(doc.assets.some((a) => a.pii || a.classification || (a.columns ?? []).some((c) => c.pii))).toBe(false);
    expect(doc.assets.some((a) => a.owner || a.steward || a.retention)).toBe(false);
    expect(warn(warnings, 'nombre de dato personal')).toBe(
      '2 columna(s) tienen nombre de dato personal (clientes.email, clientes.telefono); se importan sin marcar como PII porque un nombre no lo demuestra: márcalas tú si lo son.',
    );
  });

  it('el mismo archivo importado dos veces da el mismo documento y avisos', () => {
    const again = fromDdl(fixture('tienda-postgres'), { fallbackName: 'tienda-postgres.sql' });
    expect(again.document).toEqual(doc);
    expect(again.warnings).toEqual(warnings);
  });

  it('se exporta a Mermaid (ERD y linaje), SVG y draw.io, y las vistas del lienzo existen', async () => {
    const views = listViews(doc);
    expect(views.map((v) => v.id)).toEqual(expect.arrayContaining(['lineage', 'erd']));
    const erd = findView(doc, 'erd');
    expect(erd.assetIds).toContain('tienda-pedidos');
    expect(erd.relationIds).toHaveLength(8);
    const mermaid = toMermaid(doc, { viewId: 'erd' });
    expect(mermaid).toContain('erDiagram');
    expect(mermaid).toMatch(/tienda_clientes \|\|--o\{ tienda_pedidos : "cliente_id · 1\.\.1 → 0\.\.N"/);
    expect(mermaid).toMatch(/tienda_clientes \|\|--\|\| tienda_perfiles/);
    expect(toMermaid(doc, { viewId: 'lineage' })).toContain('Vista ventas_por_cliente [elt]');
    expect(await toSvg(doc, 'erd')).toContain('<svg');
    expect(await toSvg(doc, 'lineage')).toContain('<svg');
    const drawio = await toDrawio(doc);
    expect(() => new XMLParser({ ignoreAttributes: false }).parse(drawio)).not.toThrow();
    // El ERD exportado se vuelve a leer con el importador de Mermaid: las tablas y las relaciones sobreviven.
    const back = fromMermaid(toMermaid(doc, { viewId: 'erd' })).document;
    expect(back.relations).toHaveLength(8);
  });
});

describe('DDL de MySQL / MariaDB (mysqldump)', () => {
  const { document: doc, warnings } = fromDdl(fixture('tienda-mysql'), { fallbackName: 'tienda-mysql.sql' });

  it('lee las comillas invertidas, los tipos con modificadores, los ENUM y el comentario de columna y de tabla', () => {
    expect(validateDataDocument(doc).ok).toBe(true);
    expect(doc.assets.filter((a) => a.parentId === undefined).map((a) => a.id)).toEqual(['clientes', 'productos', 'pedidos', 'pedido-lineas', 'ventas-por-cliente', 'productos-activos']);
    const c = columns(doc, 'clientes');
    expect(c.id).toEqual({ name: 'id', type: 'int unsigned', keys: ['pk'] });
    expect(c.email).toEqual({ name: 'email', type: 'varchar(255)', keys: ['uk'], description: 'Correo de acceso' });
    expect(c.estado.type).toBe("enum('activo','baja','bloqueado')");
    expect(c.actualizado_en).toMatchObject({ type: 'datetime', nullable: true });
    expect(asset(doc, 'clientes').description).toBe('Personas que compran en la tienda');
  });

  it('las claves foráneas con CONSTRAINT y las claves primarias compuestas se leen; KEY e índices se cuentan', () => {
    expect(columns(doc, 'pedido-lineas').pedido_id.keys).toEqual(['pk', 'fk']);
    expect(doc.relations.map((r) => [r.sourceId, r.targetId])).toEqual([
      ['clientes', 'pedidos'],
      ['pedidos', 'pedido-lineas'],
      ['productos', 'pedido-lineas'],
    ]);
    expect(warn(warnings, 'Sin mapear')).toBe('Sin mapear (el modelo de datos no los recoge): 7 valor(es) por defecto, 1 restricción(es) CHECK, 3 índice(s) o clave(s) de búsqueda de CREATE TABLE, 1 × CREATE TRIGGER.');
  });

  it('las vistas de mysqldump, escritas en comentarios condicionales /*!50001 ... */, se leen con su linaje', () => {
    const p = doc.pipelines.find((x) => x.outputs[0] === 'ventas-por-cliente')!;
    expect(p.inputs).toEqual(['clientes', 'pedidos']); // `from (`clientes` `c` left join `pedidos` `p` on(...))`
    expect((p.mappings ?? []).map((m) => `${m.from.assetId}.${m.from.column}->${m.to.column}`)).toEqual(['clientes.id->cliente_id', 'clientes.nombre->nombre', 'pedidos.id->pedidos', 'pedidos.total->total']);
    const plain = doc.pipelines.find((x) => x.outputs[0] === 'productos-activos')!;
    expect(plain.inputs).toEqual(['productos']);
  });

  it('el disparador con DELIMITER y BEGIN...END no se parte en sentencias sueltas', () => {
    expect(warnings.join('\n')).not.toMatch(/INSERT|IF|SET/);
  });
});

describe('DDL de SQL Server (SSMS)', () => {
  const { document: doc, warnings } = fromDdl(fixture('tienda-sqlserver'), { fallbackName: 'tienda-sqlserver.sql' });

  it('lee los corchetes, GO, IDENTITY, las columnas calculadas y las restricciones CLUSTERED con opciones', () => {
    expect(validateDataDocument(doc).ok).toBe(true);
    expect(asset(doc, 'ventas')).toMatchObject({ kind: 'database' });
    const c = columns(doc, 'ventas-clientes');
    expect(c.ClienteId).toEqual({ name: 'ClienteId', type: 'int', keys: ['pk'] });
    expect(c.Email).toEqual({ name: 'Email', type: 'nvarchar(255)', keys: ['uk'] });
    expect(c.Notas).toEqual({ name: 'Notas', type: 'nvarchar(max)', nullable: true });
    expect(c.Saldo.type).toBe('decimal(12,2)');
    expect(c.SaldoConIva).toMatchObject({ nullable: true }); // columna calculada: AS (...)
    expect(columns(doc, 'ventas-pedidos').PedidoId.keys).toEqual(['pk']); // PRIMARY KEY CLUSTERED sin nombre
    expect(columns(doc, 'ventas-pedidolineas').PedidoId.keys).toEqual(['pk', 'fk']);
  });

  it('ALTER TABLE ... WITH CHECK/NOCHECK ADD CONSTRAINT ... FOREIGN KEY crea las relaciones', () => {
    expect(doc.relations.map((r) => [r.sourceId, r.targetId, r.cardinality])).toEqual([
      ['ventas-clientes', 'ventas-pedidos', '1:N'],
      ['ventas-pedidos', 'ventas-pedidolineas', '1:N'],
      ['ventas-productos', 'ventas-pedidolineas', '1:N'],
    ]);
  });

  it('la vista con SCHEMABINDING y JOIN tiene su pipeline y lo que no se recoge (EXEC, CREATE INDEX) se cuenta', () => {
    const p = doc.pipelines[0];
    expect(p).toMatchObject({ name: 'Vista VentasPorCliente', inputs: ['ventas-clientes', 'ventas-pedidos'], outputs: ['ventas-ventasporcliente'] });
    expect(warn(warnings, 'Sin mapear')).toBe('Sin mapear (el modelo de datos no los recoge): 1 × EXEC, 1 × CREATE INDEX.');
  });
});

describe('DDL de Oracle (SQL Developer)', () => {
  const { document: doc, warnings } = fromDdl(fixture('tienda-oracle'), { fallbackName: 'tienda-oracle.sql' });

  it('lee los nombres entre comillas, USING INDEX, ENABLE, NUMBER, VARCHAR2 y las claves en línea', () => {
    expect(validateDataDocument(doc).ok).toBe(true);
    const c = columns(doc, 'tienda-clientes');
    expect(c.ID).toEqual({ name: 'ID', type: 'number(10,0)', keys: ['pk'] });
    expect(c.EMAIL).toEqual({ name: 'EMAIL', type: 'varchar2(255 char)', keys: ['uk'], description: 'Correo de acceso' });
    expect(c.TELEFONO).toMatchObject({ type: 'varchar2(20 byte)', nullable: true });
    expect(columns(doc, 'tienda-productos').id.keys).toEqual(['pk']); // PRIMARY KEY en línea
    expect(columns(doc, 'tienda-productos').sku.keys).toEqual(['uk']);
    expect(columns(doc, 'tienda-pedido-lineas').pedido_id.keys).toEqual(['pk', 'fk']); // REFERENCES en línea
    expect(asset(doc, 'tienda-clientes').description).toBe('Personas que compran en la tienda');
  });

  it('las referencias entre esquemas con y sin comillas y mayúsculas se resuelven a las mismas tablas', () => {
    expect(doc.relations.map((r) => [r.sourceId, r.targetId])).toEqual([
      ['tienda-clientes', 'tienda-pedidos'],
      ['tienda-pedidos', 'tienda-pedido-lineas'],
      ['tienda-productos', 'tienda-pedido-lineas'],
    ]);
  });

  it('la vista con lista de columnas y JOIN con comas, y la vista materializada, tienen linaje', () => {
    const v = doc.pipelines.find((p) => p.outputs[0] === 'tienda-v-ventas-cliente')!;
    expect(v.inputs).toEqual(['tienda-clientes', 'tienda-pedidos']);
    expect((asset(doc, 'tienda-v-ventas-cliente').columns ?? []).map((c) => c.name)).toEqual(['CLIENTE_ID', 'NOMBRE', 'TOTAL']);
    expect(v.mappings!.map((m) => `${m.from.column}->${m.to.column}`)).toEqual(['ID->CLIENTE_ID', 'NOMBRE->NOMBRE', 'TOTAL->TOTAL']);
    expect(asset(doc, 'tienda-mv-ventas-mes')).toMatchObject({ kind: 'view', tags: ['materializada'] });
    expect(doc.pipelines.find((p) => p.outputs[0] === 'tienda-mv-ventas-mes')!.inputs).toEqual(['tienda-pedidos']);
  });

  it('el procedimiento con DECLARE/BEGIN/END y la barra `/` no generan sentencias sueltas; PROMPT y SET DEFINE se ignoran', () => {
    expect(warn(warnings, 'Sin mapear')).toBe('Sin mapear (el modelo de datos no los recoge): 2 valor(es) por defecto, 1 × CREATE PROCEDURE, 1 × CREATE INDEX.');
  });
});

describe('DDL de Snowflake', () => {
  const { document: doc, warnings } = fromDdl(fixture('tienda-snowflake'), { fallbackName: 'tienda-snowflake.sql' });

  it('lee TRANSIENT, VARIANT, TIMESTAMP_NTZ, AUTOINCREMENT, COMMENT en línea y COMMENT = de la tabla y del esquema', () => {
    expect(validateDataDocument(doc).ok).toBe(true);
    expect(asset(doc, 'analitica').description).toBe('Capa analítica');
    expect(asset(doc, 'analitica-dim-cliente').description).toBe('Una fila por cliente');
    const c = columns(doc, 'analitica-dim-cliente');
    expect(c.cliente_key).toEqual({ name: 'cliente_key', type: 'number(38,0)', keys: ['pk'] });
    expect(c.cliente_id).toEqual({ name: 'cliente_id', type: 'varchar(36)', keys: ['uk'], description: 'Id en el sistema operacional' });
    expect(c.atributos).toMatchObject({ type: 'variant', nullable: true });
    expect(c.cargado_en.type).toBe('timestamp_ntz(9)');
    expect(asset(doc, 'analitica-stg-pedidos')).toBeDefined();
    expect(doc.relations.map((r) => [r.sourceId, r.targetId])).toEqual([['analitica-dim-cliente', 'analitica-fact-ventas']]);
  });

  it('CREATE TABLE AS SELECT y las tablas dinámicas son tablas con pipeline; la vista segura, una vista', () => {
    expect(asset(doc, 'analitica-ventas-mes')).toMatchObject({ kind: 'table' });
    expect(doc.pipelines.find((p) => p.outputs[0] === 'analitica-ventas-mes')).toMatchObject({ name: 'Carga de ventas_mes', inputs: ['analitica-fact-ventas'] });
    expect(doc.pipelines.find((p) => p.outputs[0] === 'analitica-ventas-dia')).toMatchObject({ inputs: ['analitica-fact-ventas'] });
    expect(asset(doc, 'analitica-v-clientes-activos')).toMatchObject({ kind: 'view', description: 'Clientes con compras' });
    expect(doc.pipelines.find((p) => p.outputs[0] === 'analitica-v-clientes-activos')!.inputs).toEqual(['analitica-dim-cliente', 'analitica-fact-ventas']);
    expect(warnings.join('\n')).not.toMatch(/STAGE/);
  });
});

describe('las cuatro tiendas dan el mismo modelo', () => {
  it('mismas relaciones padre → hijo y mismas cardinalidades en PostgreSQL, MySQL, SQL Server y Oracle', () => {
    const shape = (name: string) =>
      fromDdl(fixture(name)).document.relations.map((r) => {
        const base = (id: string) => id.replace(/^(tienda|ventas)-/, '').replace(/-/g, '').toLowerCase();
        return `${base(r.sourceId)} -> ${base(r.targetId)} ${r.cardinality}`;
      });
    const common = ['clientes -> pedidos 1:N', 'pedidos -> pedidolineas 1:N', 'productos -> pedidolineas 1:N'];
    for (const name of ['tienda-postgres', 'tienda-mysql', 'tienda-sqlserver', 'tienda-oracle']) {
      expect(shape(name), name).toEqual(expect.arrayContaining(common));
    }
  });
});

describe('cardinalidad conservadora y claves', () => {
  const t = (cliente: string, extra = '') => small(`CREATE TABLE c (id int PRIMARY KEY); CREATE TABLE p (id int PRIMARY KEY, ${cliente}${extra});`).document.relations[0];

  it('una clave foránea NOT NULL es 1..1 → 0..N; anulable, 0..1 → 0..N; única, 1:1', () => {
    expect(t('c_id int NOT NULL REFERENCES c(id)')).toMatchObject({ cardinality: '1:N', description: 'c_id · 1..1 → 0..N' });
    expect(t('c_id int REFERENCES c(id)')).toMatchObject({ cardinality: '1:N', description: 'c_id · 0..1 → 0..N' });
    expect(t('c_id int NOT NULL UNIQUE REFERENCES c(id)')).toMatchObject({ cardinality: '1:1', description: 'c_id · 1..1 → 0..1' });
    expect(t('c_id int', ', CONSTRAINT u UNIQUE (c_id), FOREIGN KEY (c_id) REFERENCES c (id)')).toMatchObject({ cardinality: '1:1', description: 'c_id · 0..1 → 0..1' });
  });

  it('una columna que solo es única junto a otras no hace 1:1, y se avisa de que no se marca como clave', () => {
    const r = small('CREATE TABLE c (id int PRIMARY KEY); CREATE TABLE p (c_id int NOT NULL, k int, UNIQUE (c_id, k), FOREIGN KEY (c_id) REFERENCES c (id));');
    expect(r.document.relations[0].cardinality).toBe('1:N');
    expect(r.document.assets.find((a) => a.id === 'p')!.columns!.map((c) => c.keys)).toEqual([['fk'], undefined]);
    expect(warn(r.warnings, 'UNIQUE de varias columnas')).toContain('p(c_id, k)');
    // Pero si la propia clave foránea es única entera (clave compuesta), sí.
    const composite = small('CREATE TABLE c (a int, b int, PRIMARY KEY (a, b)); CREATE TABLE p (a int, b int, FOREIGN KEY (a, b) REFERENCES c (a, b), UNIQUE (a, b));');
    expect(composite.document.relations[0]).toMatchObject({ cardinality: '1:1', description: 'a, b · 0..1 → 0..1' });
    expect(composite.document.assets.find((a) => a.id === 'c')!.columns!.map((c) => c.keys)).toEqual([['pk'], ['pk']]);
  });

  it('dos claves foráneas entre las mismas tablas dan dos relaciones con ids distintos', () => {
    const r = small('CREATE TABLE u (id int PRIMARY KEY); CREATE TABLE m (de int REFERENCES u(id), para int REFERENCES u(id));');
    expect(r.document.relations.map((x) => [x.id, x.description])).toEqual([
      ['u--m', 'de · 0..1 → 0..N'],
      ['u--m-2', 'para · 0..1 → 0..N'],
    ]);
  });
});

describe('analizador de SQL: tolerancia', () => {
  it('comentarios -- y /* */, comillas "x", `x` y [x], mayúsculas y saltos de línea raros', () => {
    const r = small(`-- CREATE TABLE fantasma (x int);
      /* CREATE TABLE otra (y int); */
      CREATE TABLE "Mi Esquema"."Mis Pedidos" ( -- comentario dentro
        [Id]   INT /* inline */ NOT NULL,
        \`nota\` TEXT
      )
      ;
      create table minus(a int)`);
    expect(r.document.assets.map((a) => [a.id, a.name])).toEqual([
      ['mi-esquema', 'Mi Esquema'],
      ['mi-esquema-mis-pedidos', 'Mis Pedidos'],
      ['minus', 'minus'],
    ]);
    expect(r.document.assets[1].columns).toEqual([{ name: 'Id', type: 'int' }, { name: 'nota', type: 'text', nullable: true }]);
  });

  it('una cadena con punto y coma o paréntesis dentro no corta la sentencia', () => {
    const r = small("CREATE TABLE t (a text DEFAULT 'a;b)(c' NOT NULL COMMENT 'con ; punto y coma', b int);");
    expect(r.document.assets[0].columns).toEqual([{ name: 'a', type: 'text', description: 'con ; punto y coma' }, { name: 'b', type: 'int', nullable: true }]);
  });

  it('lo que no son tablas ni vistas se cuenta; las sentencias de sesión y los DROP se ignoran sin más', () => {
    const r = small(`SET search_path = x; USE db; BEGIN; DROP TABLE IF EXISTS t;
      CREATE TABLE t (a int);
      CREATE TYPE color AS ENUM ('r'); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);
      GRANT ALL ON t TO PUBLIC; ALTER SEQUENCE s RESTART; COMMIT;`);
    expect(warn(r.warnings, 'Sin mapear')).toBe('Sin mapear (el modelo de datos no los recoge): 1 × CREATE TYPE, 2 × INSERT, 1 × GRANT, 1 × ALTER SEQUENCE.');
  });

  it('los datos de COPY ... FROM stdin de pg_dump no se leen como SQL', () => {
    const r = small(`CREATE TABLE t (a int, b text);\nCOPY public.t (a, b) FROM stdin;\n1\tCREATE TABLE falso (x int);\n2\tuno; dos'\n\\.\nCREATE TABLE u (c int);`);
    expect(r.document.assets.map((a) => a.id)).toEqual(['t', 'u']);
    expect(warn(r.warnings, 'Sin mapear')).toContain('1 × COPY');
  });

  it('un nombre repetido entre esquemas lleva el esquema delante, y una referencia sin esquema ambigua se omite con aviso', () => {
    const r = small(`CREATE TABLE a.pedidos (id int PRIMARY KEY); CREATE TABLE b.pedidos (id int PRIMARY KEY);
      CREATE TABLE a.lineas (pedido_id int REFERENCES pedidos(id));`);
    expect(r.document.assets.filter((x) => x.kind === 'table').map((x) => x.name)).toEqual(['a.pedidos', 'b.pedidos', 'lineas']);
    expect(r.document.relations).toEqual([]);
    expect(warn(r.warnings, 'existe en varios esquemas')).toContain('«pedidos»');
  });

  it('una referencia sin esquema encuentra la tabla definida con esquema si es la única', () => {
    const r = small('CREATE TABLE ventas.c (id int PRIMARY KEY); CREATE TABLE ventas.p (c_id int NOT NULL REFERENCES c (id));');
    expect(r.document.relations.map((x) => [x.sourceId, x.targetId])).toEqual([['ventas-c', 'ventas-p']]);
  });

  it('una tabla referenciada o leída pero no definida se crea vacía y se avisa', () => {
    const r = small(`CREATE TABLE pedidos (id int PRIMARY KEY, cliente_id int REFERENCES auth.usuarios (id));
      CREATE VIEW v AS SELECT p.id FROM pedidos p JOIN externa e ON e.id = p.id JOIN information_schema.tables t ON 1 = 1;`);
    const vacia = r.document.assets.find((a) => a.name === 'usuarios')!;
    expect(vacia).toMatchObject({ kind: 'table', parentId: 'auth', description: 'Se lee o se referencia en el DDL, pero no está definida en él.' });
    expect(vacia.columns).toBeUndefined();
    expect(r.document.assets.map((a) => a.name)).toContain('externa');
    expect(r.document.assets.map((a) => a.name)).not.toContain('tables'); // el catálogo del sistema no es un activo
    expect(warn(r.warnings, 'no están definidas')).toMatch(/2 tabla\(s\) se leen o se referencian pero no están definidas en el DDL.*auth\.usuarios, externa/);
  });

  it('una tabla definida dos veces se queda con la última definición y avisa', () => {
    const r = small('CREATE TABLE t (a int);\nCREATE OR REPLACE TABLE t (a int, b int);');
    expect(r.document.assets).toHaveLength(1);
    expect(r.document.assets[0].columns).toHaveLength(2);
    expect(warn(r.warnings, 'ya estaba definida en la línea 1')).toBeDefined();
  });

  it('las particiones y las tablas con LIKE se avisan', () => {
    const r = small(`CREATE TABLE m (id int, f date) PARTITION BY RANGE (f);
      CREATE TABLE m_2024 PARTITION OF m FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
      CREATE TABLE copia (LIKE m INCLUDING ALL);
      CREATE TABLE copia2 LIKE m;`);
    expect(r.document.assets.map((a) => a.id)).toEqual(['m', 'copia', 'copia2']);
    expect(warn(r.warnings, 'm_2024')).toContain('partición');
    expect(r.warnings.filter((w) => w.includes('LIKE'))).toHaveLength(2);
  });

  it('TEMP, ALTER TABLE ADD COLUMN y SET NOT NULL', () => {
    const r = small(`CREATE TEMPORARY TABLE IF NOT EXISTS tmp (a int); CREATE TABLE t (a int);
      ALTER TABLE t ADD COLUMN IF NOT EXISTS b varchar(10) NOT NULL, ADD c int;
      ALTER TABLE t ALTER COLUMN a SET NOT NULL;
      ALTER TABLE t ADD PRIMARY KEY (a);
      ALTER TABLE fantasma ADD COLUMN x int;`);
    expect(r.document.assets.find((a) => a.id === 'tmp')!.tags).toEqual(['temporal']);
    expect(r.document.assets.find((a) => a.id === 't')!.columns).toEqual([
      { name: 'a', type: 'int', keys: ['pk'] },
      { name: 'b', type: 'varchar(10)' },
      { name: 'c', type: 'int', nullable: true },
    ]);
    expect(warn(r.warnings, 'Sin mapear')).toContain('1 × ALTER TABLE de tablas que no están en el archivo');
  });
});

describe('vistas: qué se lee y cuándo se avisa', () => {
  const view = (select: string, tables = 'CREATE TABLE a (id int, x int); CREATE TABLE b (id int, a_id int); CREATE TABLE c (id int);') => small(`${tables} CREATE VIEW v AS ${select};`);
  const inputs = (r: ReturnType<typeof small>): string[] => r.document.pipelines[0]?.inputs ?? [];

  it('JOIN, comas, subconsulta en FROM y en WHERE, UNION y alias con y sin AS', () => {
    expect(inputs(view('SELECT * FROM a x JOIN b AS y ON y.a_id = x.id LEFT OUTER JOIN c ON c.id = y.id'))).toEqual(['a', 'b', 'c']);
    expect(inputs(view('SELECT 1 FROM a, b WHERE a.id = b.a_id'))).toEqual(['a', 'b']);
    expect(inputs(view('SELECT s.id FROM (SELECT id FROM a) s JOIN b ON b.id = s.id'))).toEqual(['a', 'b']);
    expect(inputs(view('SELECT id FROM a WHERE id IN (SELECT a_id FROM b)'))).toEqual(['a', 'b']);
    expect(inputs(view('SELECT id FROM a UNION ALL SELECT id FROM c'))).toEqual(['a', 'c']);
  });

  it('el FROM de EXTRACT, SUBSTRING, TRIM y IS DISTINCT FROM no es una tabla; los CTE tampoco', () => {
    const r = view(`WITH t AS (SELECT id FROM a), u AS (SELECT id FROM t) SELECT extract(year FROM now()), substring(x FROM 2), trim(both ' ' from x) FROM u JOIN b ON b.id IS DISTINCT FROM u.id`);
    expect(inputs(r)).toEqual(['a', 'b']);
  });

  it('un SELECT sin tablas, que no es un SELECT o con paréntesis rotos se avisa y no hay pipeline', () => {
    for (const [select, reason] of [
      ['SELECT 1', 'no lee ninguna tabla'],
      ['EXEC sp_x', 'el cuerpo no empieza por SELECT («EXEC»)'],
      ['SELECT id FROM (SELECT id FROM a', 'los paréntesis del SELECT no cuadran'],
    ] as const) {
      const r = view(select);
      expect(r.document.pipelines, select).toEqual([]);
      expect(warn(r.warnings, 'no se pudo deducir el linaje de la vista «v»'), select).toContain(reason);
      expect(r.document.assets.some((a) => a.id === 'v'), select).toBe(true);
    }
  });

  it('una vista sin AS se omite con aviso; con lista de columnas las toma de ahí', () => {
    const none = small('CREATE TABLE t (a int); CREATE VIEW v;');
    expect(none.document.assets.map((a) => a.id)).toEqual(['t']);
    expect(warn(none.warnings, 'no tiene AS')).toBeDefined();
    const named = small('CREATE TABLE t (a int, b int); CREATE VIEW v (x, y) AS SELECT a, b FROM t;');
    expect(named.document.assets.find((a) => a.id === 'v')!.columns!.map((c) => c.name)).toEqual(['x', 'y']);
    expect(named.document.pipelines[0].mappings!.map((m) => `${m.from.column}->${m.to.column}`)).toEqual(['a->x', 'b->y']);
  });

  it('el linaje de columnas solo enlaza lo que se puede resolver: SELECT *, calificadores, sin ambigüedad y columnas declaradas', () => {
    const star = view('SELECT * FROM a');
    expect(star.document.assets.find((x) => x.id === 'v')!.columns!.map((c) => c.name)).toEqual(['id', 'x']);
    expect(star.document.pipelines[0].mappings).toHaveLength(2);
    // `id` está en las dos tablas: sin calificador no se sabe de cuál viene; `zzz` no existe en ninguna.
    const ambiguous = view('SELECT id, x, zzz, a.id AS a_id, b.id AS b_id, sum(x) AS total FROM a JOIN b ON b.a_id = a.id GROUP BY 1');
    expect(ambiguous.document.pipelines[0].mappings!.map((m) => `${m.from.assetId}.${m.from.column}->${m.to.column}`)).toEqual(['a.x->x', 'a.id->a_id', 'b.id->b_id', 'a.x->total']);
    // Con subconsulta o UNION solo se toman los nombres de las columnas, no los enlaces.
    const union = view('SELECT id, x FROM a UNION SELECT id, id FROM c');
    expect(union.document.pipelines[0].mappings).toBeUndefined();
    expect(union.document.assets.find((x) => x.id === 'v')!.columns!.map((c) => c.name)).toEqual(['id', 'x']);
    // Las reglas de gobierno no tienen nada que reprochar a un linaje de columnas deducido (solo avisos informativos).
    for (const r of [star, ambiguous, union]) expect(analyzeData(r.document).filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('una vista que lee de otra vista encadena el linaje, también hacia delante', () => {
    const r = small('CREATE VIEW v2 AS SELECT * FROM v1; CREATE VIEW v1 AS SELECT id FROM t; CREATE TABLE t (id int);');
    expect(r.document.pipelines.map((p) => [p.inputs[0], p.outputs[0]])).toEqual([['v1', 'v2'], ['t', 'v1']]);
  });
});

describe('entradas rotas', () => {
  it('vacío, sin definiciones y sin tablas dan un error del módulo claro', () => {
    expect(() => fromDdl('')).toThrow(DataImportError);
    expect(() => fromDdl('  \n -- solo un comentario\n')).toThrow(/vacío|ninguna tabla/);
    expect(() => fromDdl('SELECT 1; INSERT INTO t VALUES (1);')).toThrow(/no define ninguna tabla ni vista/);
    try {
      fromDdl('GRANT ALL ON x TO y;');
    } catch (error) {
      expect(error).toBeInstanceOf(ModuleError);
    }
  });

  it('una cadena, un identificador o un comentario sin cerrar dan error con la línea', () => {
    expect(() => fromDdl("CREATE TABLE t (a int);\nCREATE TABLE u (b text DEFAULT 'sin cerrar);")).toThrow(/línea 2: una cadena sin cerrar/);
    expect(() => fromDdl('CREATE TABLE t (a int);\n\nCREATE TABLE "u (b int);')).toThrow(/línea 3: un identificador entre comillas sin cerrar/);
    expect(() => fromDdl('CREATE TABLE t (a int);\n/* nota\nsin cerrar')).toThrow(/línea 2: un comentario \/\* \*\/ sin cerrar/);
  });

  it('un archivo en UTF-16 o binario se rechaza diciendo cómo arreglarlo', () => {
    const utf16 = Buffer.from('CREATE TABLE t (a int);', 'utf16le').toString('utf8');
    expect(() => fromDdl(utf16)).toThrow(/UTF-16/);
  });

  it('un CREATE TABLE incompleto se avisa y se sigue con el resto; si es lo único, es un error con ese motivo', () => {
    const r = small('CREATE TABLE roto (a int, b varchar(10;\nCREATE TABLE bueno (c int);');
    expect(r.document.assets.map((a) => a.id)).toEqual(['bueno']);
    expect(() => fromDdl('CREATE TABLE solo (a int')).toThrow(/ninguna tabla ni vista.*«solo» está incompleta/);
  });

  it('un BOM al principio no estorba', () => {
    expect(small('﻿CREATE TABLE t (a int);').document.assets).toHaveLength(1);
  });
});

describe('detect y registro en el módulo', () => {
  it('reconoce CREATE TABLE/VIEW en sus variantes y no se deja engañar por comentarios, JSON ni otros formatos', () => {
    for (const sql of [
      'CREATE TABLE t (a int);',
      '  create or replace table x.y (a int)',
      'CREATE VIEW v AS SELECT 1',
      'CREATE MATERIALIZED VIEW m AS SELECT 1',
      'CREATE GLOBAL TEMPORARY TABLE t (a int)',
      'CREATE OR REPLACE FORCE EDITIONABLE VIEW v AS SELECT 1',
      'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW v AS SELECT 1',
      '-- cabecera\nSET x;\nCREATE TRANSIENT TABLE t (a int)',
    ]) expect(looksLikeDdl(sql), sql).toBe(true);
    for (const text of ['-- CREATE TABLE en un comentario', '/* create view v */ select 1', 'SELECT * FROM t', 'CREATE INDEX i ON t (a)', 'erDiagram\n A ||--o{ B : x', 'flowchart LR\n a --> b', '{"sql": "create table t (a int)"}', '']) {
      expect(looksLikeDdl(text), text).toBe(false);
    }
  });

  it('el módulo lo registra con .sql y .ddl, y no confunde su detección con la de Mermaid ni dbt', () => {
    const importers = dataModule.importers;
    expect(importers.map((i) => i.id)).toEqual(['mermaid', 'ddl', 'dbt', 'openlineage']);
    expect(importers[1]).toMatchObject({ label: 'SQL (DDL)', extensions: ['.sql', '.ddl'] });
    const detected = (text: string) => importers.find((i) => i.detect?.(text))?.id;
    expect(detected(fixture('tienda-postgres'))).toBe('ddl');
    expect(detected(fixture('tienda-mysql'))).toBe('ddl');
    expect(detected('erDiagram\n A ||--o{ B : x')).toBe('mermaid');
    expect(detected(readFileSync('tests/fixtures/importar/dbt/manifest-tienda.json', 'utf8'))).toBe('dbt');
    const registry = new ModuleRegistry().register(dataModule);
    expect(registry.detectImporter('data', 'esquema.sql', 'lo que sea')?.id).toBe('ddl');
    expect(registry.detectImporter('data', 'esquema.DDL', 'lo que sea')?.id).toBe('ddl');
    expect(registry.detectImporter('data', 'manifest.json', 'lo que sea')?.id).toBe('dbt');
    expect(registry.detectImporter('data', undefined, fixture('tienda-oracle'))?.id).toBe('ddl');
  });

  it('el importador del módulo pasa el nombre y el nombre de archivo sin extensión', async () => {
    const ddl = dataModule.importers[1];
    const named = await ddl.import(fixture('tienda-snowflake'), { name: 'Almacén' });
    expect(named.document.workspace.name).toBe('Almacén');
    const fromFile = await ddl.import(fixture('tienda-snowflake'), { fallbackName: 'analitica.sql' });
    expect(fromFile.document.workspace.name).toBe('analitica');
  });

  it('un DDL y un manifest de dbt del mismo proyecto no comparten nada, y ambos son documentos válidos del módulo', () => {
    const a = fromDdl(fixture('tienda-snowflake')).document;
    const b = fromDbt(readFileSync('tests/fixtures/importar/dbt/manifest-tienda.json', 'utf8')).document;
    expect(validateDataDocument(a).ok && validateDataDocument(b).ok).toBe(true);
  });
});

/** Generador pseudoaleatorio con semilla: las mutaciones son las mismas en cada ejecución. */
const seeded = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

describe('DDL: robustez ante entradas dañadas y muy grandes', () => {
  it('un DDL truncado, mutilado o con basura dentro, o se importa como documento válido o se rechaza con DataImportError (nunca otra excepción)', () => {
    const rnd = seeded(20260929);
    const junk = ['(', ')', "'", '"', '`', '[', ']', ';', '--', '/*', '*/', '$$', ',', '\n', 'CREATE TABLE', 'AS', 'SELECT', 'FROM', 'JOIN', 'REFERENCES', 'DELIMITER ;;', 'GO', '\u0000'];
    const sources = ['postgres', 'mysql', 'sqlserver', 'oracle', 'snowflake'].map((dialect) => fixture(`tienda-${dialect}`));
    let imported = 0;
    let rejected = 0;
    for (let n = 0; n < 500; n += 1) {
      let text = sources[Math.floor(rnd() * sources.length)];
      const pos = Math.floor(rnd() * text.length);
      const kind = Math.floor(rnd() * 4);
      if (kind === 0) text = text.slice(0, pos);
      else if (kind === 1) text = text.slice(0, pos) + text.slice(pos + 1 + Math.floor(rnd() * 40));
      else if (kind === 2) text = text.slice(0, pos) + junk[Math.floor(rnd() * junk.length)] + text.slice(pos);
      else {
        const other = Math.floor(rnd() * text.length);
        text = text.slice(Math.min(pos, other), Math.max(pos, other));
      }
      try {
        expect(validateDataDocument(fromDdl(text).document).ok).toBe(true);
        imported += 1;
      } catch (error) {
        if (!(error instanceof DataImportError)) throw error;
        rejected += 1;
      }
    }
    expect(imported).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(0);
  });

  it('miles de tablas con claves foráneas, paréntesis muy anidados y vistas encadenadas no agotan la pila ni el tiempo', () => {
    const tables = Array.from({ length: 3000 }, (_, i) => `CREATE TABLE s${i % 20}.t${i} (id int PRIMARY KEY, padre int${i > 0 ? ` REFERENCES s${(i + 19) % 20}.t${i - 1} (id)` : ''});`).join('\n');
    const big = fromDdl(tables);
    expect(big.document.assets.filter((a) => a.kind === 'table')).toHaveLength(3000);
    expect(big.document.relations).toHaveLength(2999);
    expect(validateDataDocument(big.document).ok).toBe(true);

    expect(fromDdl(`CREATE TABLE a (x int DEFAULT ${'('.repeat(20000)}1${')'.repeat(20000)});`).document.assets.map((a) => a.id)).toEqual(['a']);
    const nested = fromDdl(`CREATE TABLE t (id int); CREATE VIEW v AS ${'SELECT * FROM ('.repeat(3000)}SELECT * FROM t${') s'.repeat(3000)};`);
    expect(nested.document.pipelines).toHaveLength(1);
    const chain = Array.from({ length: 1500 }, (_, i) => `CREATE VIEW v${i} AS SELECT id FROM ${i === 0 ? 't' : `v${i - 1}`};`).join('\n');
    expect(fromDdl(`${chain}\nCREATE TABLE t (id int);`).document.pipelines).toHaveLength(1500);
  });
});
