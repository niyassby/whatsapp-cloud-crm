/**
 * Data export and erasure (Phase 4.4): what the API takes and returns. The rules are in
 * packages/db/src/privacy.ts, the jobs in apps/worker/src/processors/privacy.ts.
 */
import { z } from 'zod';

export type PrivacyRequestKind = 'contact_export' | 'contact_erase' | 'org_export';

export interface PrivacyRequestDto {
  id: string;
  kind: PrivacyRequestKind;
  contactId: string | null;
  status: 'pending' | 'running' | 'done' | 'failed' | 'expired';
  fileSize: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Export files are deleted after this. */
  expiresAt: string | null;
}

export interface PrivacySettingsDto {
  /** Message text and files older than this are erased. Null keeps them. */
  messageRetentionDays: number | null;
  deletionRequestedAt: string | null;
  /** When the workspace is deleted, unless the owner cancels before. */
  deletesAt: string | null;
}

/** Erasure cannot be undone, so the person's name (or ERASE) is typed to confirm. */
export const eraseContactSchema = z.object({ confirm: z.string().trim().min(1).max(200) });

export const retentionSchema = z.object({
  messageRetentionDays: z.number().int().min(30).max(3650).nullable(),
});

export const orgDeletionSchema = z.object({ confirmName: z.string().trim().min(1).max(200) });

export type EraseContactInput = z.infer<typeof eraseContactSchema>;
export type RetentionInput = z.infer<typeof retentionSchema>;
export type OrgDeletionInput = z.infer<typeof orgDeletionSchema>;
/** Typed instead of the name, for a contact with none. */
export const ERASED_CONFIRM_WORD = 'ERASE';
