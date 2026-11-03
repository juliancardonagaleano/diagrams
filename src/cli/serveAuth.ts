/**
 * Compatibilidad de imports históricos: autenticación Bearer y sesiones en `src/diagrams-identity/`.
 */
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
} from '../diagrams-identity/core/authenticator';
