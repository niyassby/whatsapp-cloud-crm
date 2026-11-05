/**
 * Role -> permission map. The single source of truth for both the API guards and UI gating.
 * Add new permissions here first; never check roles directly in feature code.
 */
export const ROLES = ['owner', 'admin', 'agent'] as const;
export type Role = (typeof ROLES)[number];

export const Permission = {
  ORG_READ: 'org:read',
  ORG_UPDATE: 'org:update',
  ORG_DELETE: 'org:delete',
  BILLING_MANAGE: 'billing:manage',
  TEAM_READ: 'team:read',
  TEAM_INVITE: 'team:invite',
  TEAM_UPDATE_ROLE: 'team:update_role',
  TEAM_REMOVE: 'team:remove',
  API_KEYS_MANAGE: 'api_keys:manage',
  AUDIT_READ: 'audit:read',
  WHATSAPP_MANAGE: 'whatsapp:manage',
  INBOX_READ: 'inbox:read',
  INBOX_REPLY: 'inbox:reply',
  INBOX_ASSIGN: 'inbox:assign',
  CONTACTS_READ: 'contacts:read',
  CONTACTS_WRITE: 'contacts:write',
  /** Whole-list operations: import, export, bulk changes, delete, merge, fields and segments. */
  CONTACTS_MANAGE: 'contacts:manage',
  TEMPLATES_READ: 'templates:read',
  TEMPLATES_MANAGE: 'templates:manage',
  CAMPAIGNS_MANAGE: 'campaigns:manage',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

const ALL = Object.values(Permission);

const AGENT: readonly Permission[] = [
  Permission.ORG_READ,
  Permission.TEAM_READ,
  Permission.INBOX_READ,
  Permission.INBOX_REPLY,
  Permission.CONTACTS_READ,
  Permission.CONTACTS_WRITE,
  Permission.TEMPLATES_READ,
];

const ADMIN_EXCLUDED: readonly Permission[] = [Permission.ORG_DELETE, Permission.BILLING_MANAGE];

export const rolePermissions: Record<Role, readonly Permission[]> = {
  owner: ALL,
  admin: ALL.filter((p) => !ADMIN_EXCLUDED.includes(p)),
  agent: AGENT,
};

export function hasPermission(role: Role | undefined, permission: Permission): boolean {
  return role !== undefined && rolePermissions[role].includes(permission);
}

/** Higher number = more privileged. */
const RANK: Record<Role, number> = { agent: 1, admin: 2, owner: 3 };

/**
 * Whether `actor` may grant `target` to someone, or act on a member who currently holds
 * `target`. Owners manage everyone; admins manage admins and agents but never owners.
 */
export function canManageRole(actor: Role, target: Role): boolean {
  if (actor === 'owner') return true;
  if (actor === 'admin') return RANK[target] <= RANK.admin;
  return false;
}
