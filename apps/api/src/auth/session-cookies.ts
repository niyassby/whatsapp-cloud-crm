import { Inject, Injectable } from '@nestjs/common';
import { AppError, type AuthTokensResponse, ErrorCode } from '@wacrm/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { API_ENV, type ApiEnv } from '../env';
import type { SessionTokens } from './auth.service';
import { TokenService } from './token.service';

export const REFRESH_COOKIE = 'wacrm_rt';

/** The refresh token travels only in an httpOnly cookie scoped to /auth. */
@Injectable()
export class SessionCookies {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly tokens: TokenService,
  ) {}

  /** Set the refresh cookie and strip the refresh token from the JSON body. */
  issue(reply: FastifyReply, tokens: SessionTokens): AuthTokensResponse {
    void reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: this.env.COOKIE_SECURE ?? this.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/auth',
      maxAge: this.tokens.refreshTtlSeconds,
    });
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  clear(reply: FastifyReply): void {
    void reply.clearCookie(REFRESH_COOKIE, { path: '/auth' });
  }

  read(req: FastifyRequest): string | undefined {
    return req.cookies[REFRESH_COOKIE];
  }

  /**
   * CSRF defence for cookie-authenticated endpoints (on top of SameSite=Lax): a browser
   * request from another site carries a foreign Origin header.
   */
  assertSameOrigin(req: FastifyRequest): void {
    const origin = req.headers.origin;
    if (origin && origin !== new URL(this.env.WEB_URL).origin) {
      throw new AppError(ErrorCode.FORBIDDEN, 'Cross-site request blocked');
    }
  }
}
