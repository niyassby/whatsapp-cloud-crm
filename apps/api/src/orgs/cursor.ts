import { AppError, ErrorCode } from '@wacrm/shared';

/** Opaque keyset cursor over (created_at, id). Never use OFFSET pagination. */
export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso ?? '');
  if (!id || Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid cursor');
  }
  return { createdAt, id };
}
