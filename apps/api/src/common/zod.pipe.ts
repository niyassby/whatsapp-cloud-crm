import { type PipeTransform } from '@nestjs/common';
import { AppError, ErrorCode } from '@wacrm/shared';
import type { z } from 'zod';

/** Validate a body/query/param with a shared Zod schema: `@Body(zod(signupSchema))`. */
export class ZodPipe<T extends z.ZodTypeAny> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid input', {
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}

export const zod = <T extends z.ZodTypeAny>(schema: T) => new ZodPipe(schema);
