import { contentSecurityPolicy, securityHeaders } from '../securityHeaders';

export function resourceSecurityHeaders(secure = true): Record<string, string> {
  return securityHeaders({ kind: 'resource', secure });
}

export function documentSecurityHeaders(secure = true): Record<string, string> {
  return securityHeaders({ kind: 'document', secure, embed: false });
}

export function pagesHeadersFile(): string {
  const resource = resourceSecurityHeaders(true);
  const document = documentSecurityHeaders(true);
  const lines: string[] = ['# Generado desde src/cli/securityHeaders/staticHosting.ts — no editar a mano.', ''];
  lines.push('/*');
  for (const [name, value] of Object.entries(resource)) lines.push(`  ${name}: ${value}`);
  lines.push('');
  for (const pattern of ['/', '/*.html', '/index.html', '/modulos.html', '/suite.html', '/trazabilidad.html']) {
    lines.push(pattern);
    for (const [name, value] of Object.entries(document)) lines.push(`  ${name}: ${value}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function caddyDocumentCsp(): string {
  return contentSecurityPolicy({ embed: false });
}
