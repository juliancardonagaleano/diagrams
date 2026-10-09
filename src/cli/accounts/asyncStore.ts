import type { AccountStore, SyncAccountStore } from './model';

/**
 * Presenta un almacén de archivo (`JsonAccountStore`, `SqliteAccountStore`: síncronos por dentro) con el contrato asíncrono que consume el
 * servicio (`AccountStore`). No añade ninguna lógica: cada método llama al del almacén de debajo y devuelve su resultado, y un error
 * síncrono (`AccountError`) pasa a ser un rechazo de la promesa, igual que el de un almacén de red.
 *
 * Las operaciones siguen siendo síncronas por dentro: mientras corren no cede el hilo, así que el comportamiento transaccional de cada
 * almacén (el JSON de un solo proceso, `BEGIN IMMEDIATE` en SQLite) no cambia en nada.
 */
export function asAsync(store: SyncAccountStore): AccountStore {
  return {
    kind: store.kind,
    path: store.path,
    userCount: async () => store.userCount,
    stats: async () => store.stats(),
    readable: async () => store.readable(),
    users: async () => store.users(),
    findUser: async (id) => store.findUser(id),
    findByLogin: async (login) => store.findByLogin(login),
    signIn: async (profile, policy) => store.signIn(profile, policy),
    invite: async (login, siteRole) => store.invite(login, siteRole),
    updateUser: async (id, change) => store.updateUser(id, change),
    upsertUser: async (login, change) => store.upsertUser(login, change),
    removePending: async (userId) => store.removePending(userId),
    createSession: async (userId, ttlMs) => store.createSession(userId, ttlMs),
    lookupSession: async (token) => store.lookupSession(token),
    revokeSession: async (token) => store.revokeSession(token),
    sessionCount: async (userId) => store.sessionCount(userId),
    roleOf: async (userId, projectId) => store.roleOf(userId, projectId),
    rolesOf: async (userId) => store.rolesOf(userId),
    membersOf: async (projectId) => store.membersOf(projectId),
    adminCount: async (userId) => store.adminCount(userId),
    registerProject: async (projectId, ownerId) => store.registerProject(projectId, ownerId),
    setMember: async (projectId, userId, role) => store.setMember(projectId, userId, role),
    shareProject: async (projectId, login, role, newUserSiteRole) => store.shareProject(projectId, login, role, newUserSiteRole),
    removeMember: async (projectId, userId) => store.removeMember(projectId, userId),
    dropProject: async (projectId) => store.dropProject(projectId),
    membershipCounts: async () => store.membershipCounts(),
    snapshot: async () => store.snapshot(),
    close: async () => store.close(),
  };
}
