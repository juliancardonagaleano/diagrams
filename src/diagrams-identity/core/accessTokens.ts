/**
 * Core `access-tokens`: hashes y comprobación Bearer (spec 004).
 * Implementación actual en `src/cli/tokens.ts` y `src/cli/serveAuth.ts`.
 */
export {
  createToken,
  listTokens,
  revokeToken,
  roleAllows,
  TOKEN_ROLES,
  TokenStore,
  type TokenIdentity,
  type TokenRole,
} from '../../cli/tokens';

export { createAuthenticator, FailureLimiter, type Authenticator, type FailureLimiterOptions } from '../../cli/serveAuth';
