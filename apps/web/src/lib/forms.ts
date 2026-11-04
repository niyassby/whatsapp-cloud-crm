'use client';

import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { toast } from 'sonner';
import { ApiError } from './api';

/**
 * Surface an API error: field errors go onto the form, anything else becomes a toast.
 * Returns the ApiError for callers that branch on `code`.
 */
export function handleApiError<T extends FieldValues>(
  err: unknown,
  setError?: UseFormSetError<T>,
): ApiError | undefined {
  if (err instanceof ApiError) {
    const fields = Object.entries(err.fieldErrors);
    if (setError && fields.length > 0) {
      for (const [path, message] of fields) setError(path as Path<T>, { message });
    } else {
      toast.error(err.message);
    }
    return err;
  }
  toast.error('Network error. Check your connection and try again.');
  return undefined;
}
