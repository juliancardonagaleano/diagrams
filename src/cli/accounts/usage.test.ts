import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryProjectStore } from '@iark/kernel';
import { Accounts, DEFAULT_QUOTAS, type AccountsOptions } from './service';
import { asAsync, JsonAccountStore } from './store';
import { formatBytes, parseByteSize, Quotas } from './usage';

const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: Partial<Omit<AccountsOptions, 'store'>> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'iark-uso-'));
  folders.push(dir);
  // `store` es el síncrono (cómodo para preparar casos); las cuentas lo ven por el contrato asíncrono
  const store = JsonAccountStore.open(join(dir, 'cuentas.json'));
  const accounts = new Accounts({ store: asAsync(store), signup: 'open', admins: ['1'], ...options });
  const open = { signup: 'open', admin: false } as const;
  const ana = store.signIn({ id: 1, login: 'ana' }, open); // en --admins
  const beto = store.signIn({ id: 2, login: 'beto' }, open);
  const carla = store.signIn({ id: 3, login: 'carla' }, open);
  return { store, accounts, ana, beto, carla };
}

describe('formatBytes y parseByteSize', () => {
  it('escriben y leen tamaños de 1024 en 1024, con coma decimal y sin decimales de más', () => {
    expect([0, 1, 1023, 1024, 1536, 256 * 1024 * 1024, 100 * 1024 ** 2, 5 * 1024 ** 3].map(formatBytes)).toEqual(['0 B', '1 B', '1023 B', '1 KB', '1,5 KB', '256 MB', '100 MB', '5 GB']);
    expect(formatBytes(-5)).toBe('0 B');
  });

  it('leen 256M, 1.5G, 500k, bytes sueltos y las palabras que quitan el tope; rechazan lo demás con el motivo', () => {
    expect(['256M', '256 MB', '256MiB', '1.5G', '1,5g', '500k', '1048576', ' 2T ', '0'].map(parseByteSize)).toEqual([256 * 1024 ** 2, 256 * 1024 ** 2, 256 * 1024 ** 2, 1.5 * 1024 ** 3, 1.5 * 1024 ** 3, 500 * 1024, 1048576, 2 * 1024 ** 4, 0]);
    expect(['off', 'sin-tope', 'Unlimited', 'ilimitado'].map(parseByteSize)).toEqual([0, 0, 0, 0]);
    expect(parseByteSize(4096)).toBe(4096);
    for (const bad of ['', 'mucho', '-5', '12XB', '1e9', '99999999999999T', '1.2.3M']) expect(() => parseByteSize(bad), bad).toThrowError(/tamaño|grande/);
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_VALUE]) expect(() => parseByteSize(bad), String(bad)).toThrowError(/tamaño/);
  });
});

describe('Accounts: topes y propiedad de los proyectos', () => {
  it('los topes por omisión son razonables y cada uno se cambia por separado; maxProjectsPerUser sigue valiendo', () => {
    expect(setup().accounts.quotas).toEqual(DEFAULT_QUOTAS);
    expect(DEFAULT_QUOTAS).toEqual({ bytes: 256 * 1024 ** 2, projects: 25, diagramsPerProject: 200 });
    expect(setup({ quotas: { bytes: 1000 } }).accounts.quotas).toEqual({ ...DEFAULT_QUOTAS, bytes: 1000 });
    expect(setup({ maxProjectsPerUser: 3 }).accounts.maxProjectsPerUser).toBe(3);
    expect(setup({ quotas: { projects: 9 }, maxProjectsPerUser: 3 }).accounts.quotas.projects).toBe(3);
    expect(setup({ quotas: { bytes: undefined, projects: 0 } }).accounts.quotas).toEqual({ ...DEFAULT_QUOTAS, projects: 0 });
  });

  it('limitsFor: la instancia, con lo personal por encima campo a campo; los administradores no tienen tope salvo que se les fije', () => {
    const { store, accounts, ana, beto } = setup({ quotas: { bytes: 1000, projects: 2, diagramsPerProject: 3 } });
    expect(accounts.limitsFor(beto)).toEqual({ bytes: 1000, projects: 2, diagramsPerProject: 3 });
    const tuned = store.updateUser(beto.id, { quota: { bytes: 5000, diagramsPerProject: 0 } });
    expect(accounts.limitsFor(tuned)).toEqual({ bytes: 5000, projects: 2, diagramsPerProject: 0 });
    expect(accounts.limitsFor(ana)).toEqual({ bytes: 0, projects: 0, diagramsPerProject: 0 });
    expect(accounts.limitsFor(store.updateUser(ana.id, { quota: { bytes: 77 } }))).toEqual({ bytes: 77, projects: 0, diagramsPerProject: 0 });
    // un administrador degradado deja de estar exento
    expect(accounts.limitsFor({ ...beto, siteRole: 'admin' })).toEqual({ bytes: 0, projects: 0, diagramsPerProject: 0 });
  });

  it('un proyecto lo posee su persona administradora más antigua: quien lo creó, y solo si sigue administrándolo', async () => {
    const { store, accounts, beto, carla } = setup();
    store.registerProject('tienda', beto.id);
    expect((await accounts.ownerOf('tienda'))?.login).toBe('beto');
    store.setMember('tienda', carla.id, 'admin'); // llega después: no lo posee
    expect((await accounts.ownerOf('tienda'))?.login).toBe('beto');
    expect(await accounts.ownedProjects(beto.id)).toEqual(['tienda']);
    expect(await accounts.ownedProjects(carla.id)).toEqual([]);
    // si quien lo creó deja de administrarlo, pasa a la siguiente persona administradora
    store.setMember('tienda', beto.id, 'editor');
    expect((await accounts.ownerOf('tienda'))?.login).toBe('carla');
    expect(await accounts.ownedProjects(beto.id)).toEqual([]);
    expect(await accounts.ownedProjects(carla.id)).toEqual(['tienda']);
    expect(await accounts.ownerOf('no-existe')).toBeUndefined();
  });
});

describe('Quotas con un almacén que no sabe medir documentos (memoria)', () => {
  it('mide leyendo los diagramas y suma las versiones del historial; sin historial, solo los documentos', async () => {
    const { store, accounts, beto } = setup();
    for (const versions of [undefined, false] as const) {
      const projects = new MemoryProjectStore(undefined, versions === false ? { versions: false } : { versions: { coalesceSeconds: 0 } });
      const p = await projects.createProject({ name: 'P' });
      store.registerProject(p.id, beto.id);
      await projects.saveDiagram(p.id, { module: 'c4', name: 'a', text: 'é'.repeat(100) }); // 200 bytes en UTF-8
      const quotas = new Quotas({ accounts, store: projects });
      const usage = await quotas.person(beto.id, { fresh: true });
      expect(usage).toMatchObject(versions === false ? { documentBytes: 200, versionBytes: 0, bytes: 200 } : { documentBytes: 200, versionBytes: 200, versions: 1, bytes: 400 });
      store.dropProject(p.id);
    }
  });

  it('el crecimiento sin historial es nuevo − actual: cuenta la mitad que con historial', async () => {
    const { store, accounts, beto } = setup({ quotas: { bytes: 1000 } });
    const projects = new MemoryProjectStore(undefined, { versions: false });
    const p = await projects.createProject({ name: 'P' });
    store.registerProject(p.id, beto.id);
    const quotas = new Quotas({ accounts, store: projects });
    await expect(quotas.assertCanSave(p.id, { text: 'x'.repeat(1000) })).resolves.toBeUndefined(); // 1000 ≤ 1000 (con historial serían 2000)
    await expect(quotas.assertCanSave(p.id, { text: 'x'.repeat(1001) })).rejects.toMatchObject({ status: 409, extra: { code: 'limit', quota: 'bytes' } });
  });

  it('un proyecto que ya no existe en la carpeta no cuenta ni rompe la medida', async () => {
    const { store, accounts, beto } = setup();
    store.registerProject('fantasma', beto.id);
    const quotas = new Quotas({ accounts, store: new MemoryProjectStore() });
    expect(await quotas.person(beto.id)).toMatchObject({ bytes: 0, projects: 1, items: [] });
  });

  it('un proyecto sin dueño solo tiene el tope de diagramas de la instancia; el de bytes no se cobra a nadie', async () => {
    const { accounts } = setup({ quotas: { bytes: 10, diagramsPerProject: 1 } });
    const projects = new MemoryProjectStore();
    const p = await projects.createProject({ name: 'Huérfano' });
    const quotas = new Quotas({ accounts, store: projects });
    await quotas.assertCanSave(p.id, { text: 'x'.repeat(5000) });
    await projects.saveDiagram(p.id, { module: 'c4', name: 'a', text: 'x' });
    await expect(quotas.assertCanSave(p.id, { text: 'y' })).rejects.toMatchObject({ extra: { quota: 'diagrams' } });
  });
});

describe('Quotas: la caché de lo medido', () => {
  it('reutiliza la medida de un proyecto hasta que caduca o se invalida; fresh la ignora', async () => {
    let clock = 1_000;
    const { store, accounts, beto } = setup();
    const projects = new MemoryProjectStore(undefined, { versions: false });
    const p = await projects.createProject({ name: 'P' });
    store.registerProject(p.id, beto.id);
    const quotas = new Quotas({ accounts, store: projects, ttlMs: 30_000, now: () => clock });
    expect((await quotas.person(beto.id)).bytes).toBe(0);
    await projects.saveDiagram(p.id, { module: 'c4', name: 'a', text: 'x'.repeat(10) });
    expect((await quotas.person(beto.id)).bytes).toBe(0); // la medida guardada
    expect((await quotas.person(beto.id, { fresh: true })).bytes).toBe(10);
    await projects.saveDiagram(p.id, { module: 'c4', name: 'b', text: 'x'.repeat(5) });
    expect((await quotas.person(beto.id, { fresh: p.id })).bytes).toBe(15); // medir solo ese proyecto
    await projects.saveDiagram(p.id, { module: 'c4', name: 'c', text: 'x'.repeat(5) });
    expect((await quotas.person(beto.id)).bytes).toBe(15);
    quotas.invalidate(p.id);
    expect((await quotas.person(beto.id)).bytes).toBe(20);
    await projects.saveDiagram(p.id, { module: 'c4', name: 'd', text: 'x'.repeat(5) });
    clock += 29_999;
    expect((await quotas.person(beto.id)).bytes).toBe(20);
    clock += 2;
    expect((await quotas.person(beto.id)).bytes).toBe(25); // caducó
  });
});
