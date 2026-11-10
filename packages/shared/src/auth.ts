import { z } from 'zod';
import { ROLES, type Permission, type Role } from './permissions';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Enter a valid email address' }).max(254));

/** 10+ chars. Length beats composition rules (NIST 800-63B). */
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128, 'Use at most 128 characters');

const nameSchema = z.string().trim().min(1, 'Required').max(100);
const tokenSchema = z.string().min(20).max(200);
const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code');

export const roleSchema = z.enum(ROLES);

export const signupSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
    orgName: nameSchema,
  })
  .refine((v) => v.password.toLowerCase() !== v.email, {
    path: ['password'],
    message: 'Password must not be your email',
  });
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Required').max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const mfaVerifySchema = z.object({ mfaToken: z.string().min(1), code: totpCodeSchema });
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({ token: tokenSchema, password: passwordSchema });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const verifyEmailSchema = z.object({ token: tokenSchema });
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const switchOrgSchema = z.object({ orgId: z.uuid() });
export type SwitchOrgInput = z.infer<typeof switchOrgSchema>;

export const totpEnableSchema = z.object({ code: totpCodeSchema });
export type TotpEnableInput = z.infer<typeof totpEnableSchema>;

export const totpDisableSchema = z.object({
  password: z.string().min(1).max(128),
  code: totpCodeSchema,
});
export type TotpDisableInput = z.infer<typeof totpDisableSchema>;

export const createOrgSchema = z.object({ name: nameSchema });
export type CreateOrgInput = z.infer<typeof createOrgSchema>;

export const updateOrgSchema = z.object({
  name: nameSchema.optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
});
export type UpdateOrgInput = z.infer<typeof updateOrgSchema>;

export const createInvitationSchema = z.object({ email: emailSchema, role: roleSchema });
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

/** New users send name + password; existing (logged-in) users send only the token. */
export const acceptInvitationSchema = z.object({
  token: tokenSchema,
  name: nameSchema.optional(),
  password: passwordSchema.optional(),
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

export const updateMemberRoleSchema = z.object({ role: roleSchema });
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

export const cursorQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

// ------------------------------------------------------------------ response DTOs

export interface AuthTokensResponse {
  accessToken: string;
  /** Seconds until the access token expires. The refresh token is an httpOnly cookie. */
  expiresIn: number;
}

export interface MfaChallengeResponse {
  mfaRequired: true;
  mfaToken: string;
}

export type LoginResponse = AuthTokensResponse | MfaChallengeResponse;

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

export interface MeResponse {
  user: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    totpEnabled: boolean;
  };
  orgs: OrgSummary[];
  currentOrg: OrgSummary | null;
  permissions: Permission[];
}

export interface TotpSetupResponse {
  /** otpauth:// URI for QR codes. */
  otpauthUrl: string;
  /** Base32 secret for manual entry. */
  secret: string;
}

export interface MemberDto {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  status: 'active' | 'invited' | 'disabled';
  /** Takes new conversations. */
  available: boolean;
  skills: string[];
  createdAt: string;
}

export interface InvitationDto {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
}

export interface InvitationPreviewDto {
  orgName: string;
  email: string;
  role: Role;
  /** True when an account with this email already exists (log in to accept). */
  accountExists: boolean;
}

export interface AuditLogDto {
  id: string;
  action: string;
  actorUserId: string | null;
  actorName: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  ip: string | null;
  createdAt: string;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}
