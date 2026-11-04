import { describe, expect, it } from 'vitest';
import { canManageRole, hasPermission, Permission, rolePermissions } from './permissions';

describe('role permissions', () => {
  it('owner has every permission', () => {
    for (const p of Object.values(Permission)) expect(hasPermission('owner', p)).toBe(true);
  });

  it('admin has everything except org deletion and billing', () => {
    expect(hasPermission('admin', Permission.TEAM_INVITE)).toBe(true);
    expect(hasPermission('admin', Permission.WHATSAPP_MANAGE)).toBe(true);
    expect(hasPermission('admin', Permission.ORG_DELETE)).toBe(false);
    expect(hasPermission('admin', Permission.BILLING_MANAGE)).toBe(false);
  });

  it('agent can work the inbox but not manage the team or settings', () => {
    expect(hasPermission('agent', Permission.INBOX_REPLY)).toBe(true);
    expect(hasPermission('agent', Permission.TEAM_READ)).toBe(true);
    for (const p of [
      Permission.TEAM_INVITE,
      Permission.TEAM_UPDATE_ROLE,
      Permission.TEAM_REMOVE,
      Permission.ORG_UPDATE,
      Permission.API_KEYS_MANAGE,
      Permission.AUDIT_READ,
      Permission.WHATSAPP_MANAGE,
    ]) {
      expect(hasPermission('agent', p)).toBe(false);
    }
  });

  it('no role means no permissions', () => {
    expect(hasPermission(undefined, Permission.ORG_READ)).toBe(false);
  });

  it('role sets are nested: agent ⊂ admin ⊂ owner', () => {
    expect(rolePermissions.agent.every((p) => rolePermissions.admin.includes(p))).toBe(true);
    expect(rolePermissions.admin.every((p) => rolePermissions.owner.includes(p))).toBe(true);
  });
});

describe('canManageRole', () => {
  it.each([
    ['owner', 'owner', true],
    ['owner', 'admin', true],
    ['owner', 'agent', true],
    ['admin', 'owner', false],
    ['admin', 'admin', true],
    ['admin', 'agent', true],
    ['agent', 'agent', false],
    ['agent', 'admin', false],
  ] as const)('%s managing %s -> %s', (actor, target, expected) => {
    expect(canManageRole(actor, target)).toBe(expected);
  });
});
