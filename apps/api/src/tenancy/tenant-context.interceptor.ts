import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { requestContext } from './request-context';

/**
 * Runs the route handler inside AsyncLocalStorage holding `request.auth`, so services can
 * read the tenant without it being threaded through every call.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const auth = context.switchToHttp().getRequest<FastifyRequest>().auth;
    if (!auth) return next.handle();

    return new Observable((subscriber) =>
      requestContext.run({ ...auth }, () => next.handle().subscribe(subscriber)),
    );
  }
}
