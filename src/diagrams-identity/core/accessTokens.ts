/**
 * Core `access-tokens`: hashes y comprobación Bearer (spec 004).
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
} from './tokens';

export { createAuthenticator, FailureLimiter, type Authenticator, type FailureLimiterOptions } from '../../cli/serveAuth';
