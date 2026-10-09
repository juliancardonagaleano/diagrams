import { join } from 'node:path';
import { JsonAccountStore } from '../../src/cli/accounts/jsonStore';

export const OPEN = { signup: 'open', admin: false } as const;
export const INVITE = { signup: 'invite', admin: false } as const;

/**
 * Un JSON de cuentas de verdad, escrito por el almacén JSON a lo largo de una vida de la instancia: personas que entraron, un cambio de nombre
 * de usuario, invitaciones (de instancia y de proyecto), una cuenta desactivada, proyectos con todos los roles y sesiones vigentes y caducadas.
 */
export function realJson(dir: string) {
  let now = Date.parse('2026-09-01T10:00:00Z');
  const tick = (): void => void (now += 3600_000);
  const file = join(dir, 'cuentas.json');
  const store = JsonAccountStore.open(file, { now: () => new Date(now) });
  const ana = store.signIn({ id: 583231, login: 'ana', name: 'Ana Pérez', avatarUrl: 'https://avatars.example.test/583231' }, OPEN);
  tick();
  const beto = store.signIn({ id: 202, login: 'Beto' }, OPEN);
  tick();
  const dani = store.signIn({ id: 303, login: 'dani' }, OPEN);
  store.updateUser(dani.id, { disabled: true });
  tick();
  store.registerProject('tienda', ana.id);
  store.registerProject('banca', beto.id);
  store.setMember('tienda', beto.id, 'editor');
  store.setMember('banca', ana.id, 'viewer');
  store.shareProject('tienda', 'carla', 'viewer', 'guest'); // invitación de proyecto: guest, pendiente
  store.shareProject('banca', 'eva', 'editor', 'member'); // invitación de proyecto en una instancia abierta
  store.invite('fede', 'guest'); // invitación de instancia, sin proyectos
  store.signIn({ id: 404, login: 'ana' }, OPEN); // alguien toma «ana»: la cuenta antigua pasa a «ana~583231»
  const sessions: Record<string, string> = {};
  sessions.ana = store.createSession(ana.id, 30 * 24 * 3600_000).token;
  tick();
  sessions.beto = store.createSession(beto.id, 3600_000).token;
  sessions.betoOtra = store.createSession(beto.id, 30 * 24 * 3600_000).token;
  const snapshot = store.snapshot();
  // «ahora» para la base nueva: dos días después, cuando la sesión de una hora ya caducó y la de 30 días no
  const later = new Date(now + 2 * 24 * 3600_000);
  return { file, snapshot, sessions, now: () => later, counts: { users: snapshot.users.length, sessions: snapshot.sessions.length } };
}

