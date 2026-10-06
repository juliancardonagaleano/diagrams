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
