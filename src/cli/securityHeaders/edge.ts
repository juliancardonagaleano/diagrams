import type { IncomingMessage, ServerResponse } from 'node:http';
import { applySecurityHeaders, type SecurityHeadersSettings } from '../securityHeaders';

export function applyEdgeSecurityHeaders(req: IncomingMessage, res: ServerResponse, settings: SecurityHeadersSettings = {}): void {
  applySecurityHeaders(req, res, settings);
}
