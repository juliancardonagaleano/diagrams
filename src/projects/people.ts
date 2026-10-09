import type { ProjectRole, SiteRole } from '@iark/kernel';

/**
 * Cómo se le cuenta a la persona quién es cada quién en un servidor con cuentas: el rol que tiene en un proyecto, el que tiene en la
 * instancia y la foto (que solo se muestra si viene por https: es una dirección que pone el servidor y la carga el navegador de quien mira).
 */

export const PROJECT_ROLE_LABEL: Record<ProjectRole, string> = { viewer: 'Lector', editor: 'Editor', admin: 'Administrador' };

/** Lo que puede hacer cada rol en un proyecto, en una frase (para la ayuda de los selectores). */
export const PROJECT_ROLE_HELP: Record<ProjectRole, string> = {
  viewer: 'puede ver los diagramas, no cambiarlos',
  editor: 'puede ver y editar los diagramas',
  admin: 'además comparte el proyecto con otras personas y lo borra',
};

export const PROJECT_ROLES: readonly ProjectRole[] = ['viewer', 'editor', 'admin'];

export const SITE_ROLE_LABEL: Record<SiteRole, string> = {
  admin: 'administrador de la instancia',
  member: 'miembro',
  guest: 'invitado (solo entra a los proyectos que le compartan)',
};

/** Los roles de la instancia, del que más puede al que menos (el orden en que se ofrecen y en que se listan). */
export const SITE_ROLES: readonly SiteRole[] = ['admin', 'member', 'guest'];

/** El rol en la instancia como título de una columna o de una opción. (`SITE_ROLE_LABEL` es para frases: «Rol en la instancia: …»). */
export const SITE_ROLE_TITLE: Record<SiteRole, string> = { admin: 'Administrador', member: 'Miembro', guest: 'Invitado' };

/** Lo que puede hacer cada rol de la instancia, en una frase (para la ayuda de los selectores de la pantalla de administración). */
export const SITE_ROLE_HELP: Record<SiteRole, string> = {
  admin: 've y cambia las cuentas y todos los proyectos de la instancia',
  member: 'crea, importa y comparte sus propios proyectos',
  guest: 'solo entra a los proyectos que le comparten; no crea proyectos propios',
};

/** La foto de una persona si es una dirección https; si no, `undefined` (no se carga nada de direcciones http ni de otros esquemas). */
export function safeAvatarUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Un nombre de usuario de GitHub: letras, números y guiones sueltos (ni al principio ni al final), hasta 39 caracteres. */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/**
 * El nombre de usuario como lo valida el servicio al administrar cuentas (`src/cli/accounts/store.ts`): igual que el de GitHub, pero admite `_`
 * (lo usan las cuentas gestionadas de GitHub Enterprise) y no admite dos guiones seguidos. Es lo que decide si una cuenta se puede tocar desde la
 * API: el servicio aparta con un `~` el nombre que dejó alguien que cambió de nombre en GitHub, y a esa cuenta no se la puede nombrar.
 */
export const INSTANCE_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9_]|-(?=[A-Za-z0-9_])){0,38}$/;
