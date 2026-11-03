import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../securityHeaders';
import { caddyDocumentCsp, documentSecurityHeaders, pagesHeadersFile } from './staticHosting';

describe('staticHosting (spec 009)', () => {
  it('CSP de documento sin unsafe-eval', () => {
    const csp = contentSecurityPolicy({ embed: false });
    expect(csp).not.toContain('unsafe-eval');
    expect(caddyDocumentCsp()).toBe(csp);
  });

  it('pagesHeadersFile incluye CSP en HTML', () => {
    const text = pagesHeadersFile();
    expect(text).toContain('Content-Security-Policy');
    expect(text).toContain(documentSecurityHeaders(true)['Referrer-Policy']);
  });

  it('Caddyfile alinea CSP con el código', () => {
    expect(readFileSync('deploy/Caddyfile', 'utf8')).toContain(caddyDocumentCsp());
  });
});
