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

export {
  bearerToken,
  clientAddress,
  createAuthenticator,
  FailureLimiter,
  isLoopbackHost,
  type Authenticator,
  type AuthenticatorOptions,
  type FailureLimiterOptions,
  type Identity,
} from './authenticator';
