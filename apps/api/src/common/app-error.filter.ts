import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { InvalidDbContextError } from '@wacrm/db';
import { AppError, ErrorCode, type ErrorResponse, errorHttpStatus } from '@wacrm/shared';
import type { FastifyReply } from 'fastify';

/** Maps every error to `{ code, message, details? }` with a stable code from packages/shared. */
@Catch()
export class AppErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const { status, body } = this.toResponse(exception);
    if (status >= 500) this.logger.error(exception);
    void reply.status(status).type('application/json').send(body);
  }

  private toResponse(exception: unknown): { status: number; body: ErrorResponse } {
    if (exception instanceof AppError) {
      return {
        status: exception.httpStatus,
        body: { code: exception.code, message: exception.message, details: exception.details },
      };
    }
    if (exception instanceof InvalidDbContextError) {
      const code = ErrorCode.DB_INVALID_CONTEXT;
      return { status: errorHttpStatus[code], body: { code, message: exception.message } };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code =
        status === 404
          ? ErrorCode.NOT_FOUND
          : status === 401
            ? ErrorCode.UNAUTHENTICATED
            : status === 403
              ? ErrorCode.FORBIDDEN
              : status < 500
                ? ErrorCode.VALIDATION_FAILED
                : ErrorCode.INTERNAL;
      return { status, body: { code, message: exception.message } };
    }
    return { status: 500, body: { code: ErrorCode.INTERNAL, message: 'Internal server error' } };
  }
}
