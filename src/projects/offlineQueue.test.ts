import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { ProjectError } from '@iark/kernel';
import { backoffDelay, byteLength, DEFAULT_RETRY, IdbQueueBackend, isTransient, MemoryQueueBackend, OfflineQueue, queueKey, type PendingChange, type QueueLimits } from './offlineQueue';

/** La cola de cambios pendientes: persistencia real (IndexedDB de mentira, pero con su semántica), tope, un estado por diagrama y la espera entre reintentos. */
const SERVER = 'http://localhost:8787';

function change(over: Partial<PendingChange> = {}): PendingChange {
  const text = over.text ?? '{"v":1}';
  const base: PendingChange = {
    key: '',
    server: SERVER,
    owner: 'u:1',
    projectId: 'tienda',
    diagramId: 'ventas',
    name: 'Ventas',
    module: 'data',
    text,
    baseUpdatedAt: '2026-01-01T00:00:00.000Z',
    status: 'retry',
    rev: 1,
    createdAt: 1,
    updatedAt: 1,
    bytes: byteLength(text),
    ...over,
  };
  return { ...base, key: over.key ?? queueKey(base.server, base.owner, base.projectId, base.diagramId) };
}

describe('cola de cambios pendientes', () => {
  describe('persistencia (IndexedDB)', () => {
    it('lo guardado sobrevive a cerrar y reabrir la base, y se relee entero', async () => {
      const factory = new IDBFactory();
      const first = new OfflineQueue(new IdbQueueBackend(factory));
      expect((await first.upsert(change({ text: '{"a":"ñandú"}' }))).ok).toBe(true);
      expect((await first.upsert(change({ diagramId: 'otro', name: 'Otro', createdAt: 2 }))).ok).toBe(true);

      const reopened = new OfflineQueue(new IdbQueueBackend(factory));
      await reopened.load();
      expect(reopened.all().map((c) => c.diagramId)).toEqual(['ventas', 'otro']);
      expect(reopened.get(queueKey(SERVER, 'u:1', 'tienda', 'ventas'))?.text).toBe('{"a":"ñandú"}');
      expect(reopened.durable).toBe(true);
    });

    it('guardar otra vez el mismo diagrama sustituye el texto: solo queda el último estado, no una cola', async () => {
      const factory = new IDBFactory();
      const queue = new OfflineQueue(new IdbQueueBackend(factory));
      for (let n = 1; n <= 5; n += 1) await queue.upsert(change({ text: `{"v":${n}}`, rev: n }));
      const reopened = new OfflineQueue(new IdbQueueBackend(factory));
      await reopened.load();
      expect(reopened.all()).toHaveLength(1);
      expect(reopened.all()[0]).toMatchObject({ text: '{"v":5}', rev: 5 });
    });

    it('la base solo contiene el contenido y metadatos: ningún campo ni valor es un token', async () => {
      const factory = new IDBFactory();
      const queue = new OfflineQueue(new IdbQueueBackend(factory));
      await queue.upsert(change());
      const rows = await new IdbQueueBackend(factory).list();
      expect(Object.keys(rows[0]).sort()).toEqual(['baseUpdatedAt', 'bytes', 'createdAt', 'diagramId', 'key', 'module', 'name', 'owner', 'projectId', 'rev', 'server', 'status', 'text', 'updatedAt']);
      expect(JSON.stringify(rows)).not.toMatch(/token|bearer|iark_s_|authorization/i);
    });

    it('sin IndexedDB la escritura falla con un mensaje claro y el espejo no cambia', async () => {
      const queue = new OfflineQueue(new IdbQueueBackend(null));
      const result = await queue.upsert(change());
      expect(result).toMatchObject({ ok: false, reason: 'storage' });
      expect(queue.all()).toEqual([]);
    });

    it('patch cambia el estado sin tocar el texto, y remove lo borra de la base', async () => {
      const factory = new IDBFactory();
      const queue = new OfflineQueue(new IdbQueueBackend(factory));
      const row = change();
      await queue.upsert(row);
      await queue.patch(row.key, { status: 'conflict', problem: 'changed', reason: 'otro guardó' });
      const reopened = new OfflineQueue(new IdbQueueBackend(factory));
      await reopened.load();
      expect(reopened.get(row.key)).toMatchObject({ status: 'conflict', problem: 'changed', reason: 'otro guardó', text: row.text });
      await reopened.patch(row.key, { status: 'retry', problem: undefined, reason: undefined });
      expect(reopened.get(row.key)).not.toHaveProperty('problem');
      await reopened.remove([row.key]);
      const last = new OfflineQueue(new IdbQueueBackend(factory));
      await last.load();
      expect(last.all()).toEqual([]);
    });
  });

  describe('tope de tamaño', () => {
    const limits: QueueLimits = { maxBytes: 100, maxEntries: 3 };

    it('un cambio que no cabe no se guarda a medias: devuelve «full» con un aviso claro y lo anterior queda intacto', async () => {
      const queue = new OfflineQueue(new MemoryQueueBackend(), limits);
      expect((await queue.upsert(change({ text: 'x'.repeat(60) }))).ok).toBe(true);
      const result = await queue.upsert(change({ diagramId: 'b', text: 'y'.repeat(60) }));
      expect(result).toMatchObject({ ok: false, reason: 'full' });
      expect(result.ok === false && result.message).toMatch(/tope de cambios sin conexión/);
      expect(queue.all().map((c) => c.diagramId)).toEqual(['ventas']);
      expect(queue.totalBytes).toBe(60);
    });

    it('sustituir el mismo diagrama descuenta lo anterior: un diagrama puede crecer hasta el tope sin contarse dos veces', async () => {
      const queue = new OfflineQueue(new MemoryQueueBackend(), limits);
      await queue.upsert(change({ text: 'x'.repeat(60) }));
      expect((await queue.upsert(change({ text: 'y'.repeat(95), rev: 2 }))).ok).toBe(true);
      expect((await queue.upsert(change({ text: 'z'.repeat(101), rev: 3 }))).ok).toBe(false);
      expect(queue.get(queueKey(SERVER, 'u:1', 'tienda', 'ventas'))?.text).toHaveLength(95);
    });

    it('también hay un tope de diagramas distintos, y se cuentan bytes (no letras)', async () => {
      const queue = new OfflineQueue(new MemoryQueueBackend(), limits);
      for (const id of ['a', 'b', 'c']) expect((await queue.upsert(change({ diagramId: id, text: 'ñ' }))).ok).toBe(true);
      expect(queue.totalBytes).toBe(6); // «ñ» son 2 bytes
      expect(await queue.upsert(change({ diagramId: 'd', text: 'x' }))).toMatchObject({ ok: false, reason: 'full' });
      await queue.remove([queueKey(SERVER, 'u:1', 'tienda', 'a')]);
      expect((await queue.upsert(change({ diagramId: 'd', text: 'x' }))).ok).toBe(true);
    });
  });

  describe('aislamiento por persona y servidor', () => {
    it('la clave incluye servidor, persona, proyecto y diagrama: dos personas con el mismo diagrama no se pisan', async () => {
      const queue = new OfflineQueue(new MemoryQueueBackend());
      await queue.upsert(change({ owner: 'u:1', text: 'de ana' }));
      await queue.upsert(change({ owner: 'u:2', text: 'de beto' }));
      await queue.upsert(change({ server: 'http://otro:1', text: 'de otro servidor' }));
      expect(queue.all().map((c) => c.text).sort()).toEqual(['de ana', 'de beto', 'de otro servidor']);
      expect(queueKey('a', 'b', 'c', 'd')).not.toBe(queueKey('a', 'b', 'cd', ''));
    });
  });

  describe('reintentos', () => {
    const exact = { ...DEFAULT_RETRY, jitter: 0 };

    it('la espera crece al doble en cada fallo seguido y se queda en el máximo', () => {
      const waits = [1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => backoffDelay(n, exact));
      expect(waits).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000]);
    });

    it('la variación aleatoria no pasa del máximo ni baja de cero', () => {
      const wide = { ...DEFAULT_RETRY, jitter: 0.5 };
      expect(backoffDelay(1, { ...wide, random: () => 0 })).toBe(1000);
      expect(backoffDelay(1, { ...wide, random: () => 1 })).toBe(3000);
      expect(backoffDelay(10, { ...wide, random: () => 1 })).toBe(60000);
    });

    it('se reintenta lo que se arregla esperando (red, 5xx, 429, portal cautivo) y no lo demás', () => {
      const unavailable = (info: ConstructorParameters<typeof ProjectError>[2]) => new ProjectError('unavailable', 'x', info);
      expect(isTransient(unavailable({ network: true }))).toBe(true);
      expect(isTransient(unavailable({ status: 503 }))).toBe(true);
      expect(isTransient(unavailable({ status: 429 }))).toBe(true);
      expect(isTransient(unavailable({ status: 200 }))).toBe(true);
      expect(isTransient(unavailable({ status: 404 }))).toBe(false);
      expect(isTransient(new ProjectError('unauthorized', 'x', { status: 401 }))).toBe(false);
      expect(isTransient(new ProjectError('forbidden', 'x'))).toBe(false);
      expect(isTransient(new ProjectError('conflict', 'x'))).toBe(false);
      expect(isTransient(new Error('x'))).toBe(false);
    });
  });
});
