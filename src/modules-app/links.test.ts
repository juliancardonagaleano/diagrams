import { describe, expect, it } from 'vitest';
import { WorkbenchController } from './controller';
import { linkTypeOptions, resolveRef, SuiteLinks } from './links';
import { MODULE_SOURCES } from './modules';

describe('SuiteLinks', () => {
  it('resuelve URN y encuentra quién apunta a un elemento entre los ejemplos de todos los módulos', async () => {
    expect(resolveRef('urn:iark:integration:pedidos')).toEqual({ moduleId: 'integration', elementId: 'pedidos', urn: 'urn:iark:integration:pedidos' });
    expect(resolveRef('pedidos')).toBeUndefined();
    const controller = new WorkbenchController(MODULE_SOURCES);
    const links = new SuiteLinks(controller);
    const back = await links.backlinks('integration', 'pedidos');
    expect(back.map((b) => `${b.moduleId}:${b.elementId}`).sort()).toEqual(['data:erp', 'platform:pedidos']);
    // cada enlace entrante trae el tipo que declaró quien apunta
    expect(Object.fromEntries(back.map((b) => [`${b.moduleId}:${b.elementId}`, b.type]))).toEqual({ 'data:erp': 'derives', 'platform:pedidos': 'implements' });
    expect(await links.exists('urn:iark:integration:pedidos')).toBe(true);
    expect(await links.exists('urn:iark:integration:no-existe')).toBe(false);
    expect(await links.exists('urn:iark:otro:x')).toBeUndefined();
    const entities = await links.entities('c4');
    expect(entities.length).toBeGreaterThan(0);
  }, 30000);
});

describe('linkTypeOptions', () => {
  it('ofrece el vocabulario sugerido, con depends-on primero y marcado como el de por omisión', () => {
    const options = linkTypeOptions();
    expect(options.map((o) => o.id)).toEqual(['depends-on', 'implements', 'deploys', 'protects', 'realizes', 'derives', 'documents']);
    expect(options[0].label).toBe('depends-on (por omisión)');
    expect(options[1].label).toBe('implements');
    expect(options.every((o) => o.description.length > 10)).toBe(true);
    expect(linkTypeOptions('protects')).toEqual(options);
  });

  it('añade al final el tipo propio que ya tenga el elemento, para no perderlo', () => {
    const options = linkTypeOptions('mi-tipo');
    expect(options).toHaveLength(8);
    expect(options[7]).toMatchObject({ id: 'mi-tipo', label: 'mi-tipo (propio)' });
    expect(linkTypeOptions('')).toHaveLength(7);
  });
});

