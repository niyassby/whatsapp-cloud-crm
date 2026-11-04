import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  AppError,
  type AuthTokensResponse,
  ErrorCode,
  forgotPasswordSchema,
  type ForgotPasswordInput,
  type LoginResponse,
  loginSchema,
  type LoginInput,
  type MeResponse,
  mfaVerifySchema,
  type MfaVerifyInput,
  resetPasswordSchema,
  type ResetPasswordInput,
  signupSchema,
  type SignupInput,
  switchOrgSchema,
  type SwitchOrgInput,
  totpDisableSchema,
  type TotpDisableInput,
  totpEnableSchema,
  type TotpEnableInput,
  type TotpSetupResponse,
  verifyEmailSchema,
  type VerifyEmailInput,
} from '@wacrm/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Meta, type RequestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import type { AuthContext } from '../tenancy/request-context';
import { SkipTenant } from '../tenancy/skip-tenant.decorator';
import { AuthService, type SessionTokens } from './auth.service';
import { CurrentAuth, Public } from './decorators';
import { MfaService } from './mfa.service';
import { SessionCookies } from './session-cookies';

@SkipTenant()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly cookies: SessionCookies,
  ) {}

  @Public()
  @Post('signup')
  async signup(
    @Body(zod(signupSchema)) body: SignupInput,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthTokensResponse> {
    return this.cookies.issue(reply, await this.auth.signup(body, meta));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(zod(loginSchema)) body: LoginInput,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResponse> {
    const result = await this.auth.login(body, meta);
    if ('mfaRequired' in result && result.mfaRequired) {
      return { mfaRequired: true, mfaToken: result.mfaToken };
    }
    return this.cookies.issue(reply, result as SessionTokens);
  }

  @Public()
  @Post('2fa/verify')
  @HttpCode(200)
  async verifyMfa(
    @Body(zod(mfaVerifySchema)) body: MfaVerifyInput,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthTokensResponse> {
    return this.cookies.issue(reply, await this.auth.verifyMfa(body.mfaToken, body.code, meta));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: FastifyRequest,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthTokensResponse> {
    this.cookies.assertSameOrigin(req);
    const raw = this.cookies.read(req);
    if (!raw) throw new AppError(ErrorCode.SESSION_INVALID, 'No session');
    try {
      return this.cookies.issue(reply, await this.auth.refresh(raw, meta));
    } catch (err) {
      this.cookies.clear(reply);
      throw err;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    this.cookies.assertSameOrigin(req);
    await this.auth.logout(this.cookies.read(req));
    this.cookies.clear(reply);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(204)
  async verifyEmail(@Body(zod(verifyEmailSchema)) body: VerifyEmailInput): Promise<void> {
    await this.auth.verifyEmail(body.token);
  }

  @Post('resend-verification')
  @HttpCode(204)
  async resendVerification(@CurrentAuth() auth: AuthContext): Promise<void> {
    await this.auth.resendVerification(auth.userId);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(204)
  async forgotPassword(
    @Body(zod(forgotPasswordSchema)) body: ForgotPasswordInput,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.auth.forgotPassword(body.email, meta);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(204)
  async resetPassword(
    @Body(zod(resetPasswordSchema)) body: ResetPasswordInput,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.auth.resetPassword(body, meta);
  }

  @Get('me')
  me(@CurrentAuth() auth: AuthContext): Promise<MeResponse> {
    return this.auth.me(auth.userId, auth.orgId);
  }

  @Post('switch-org')
  @HttpCode(200)
  switchOrg(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(switchOrgSchema)) body: SwitchOrgInput,
  ): Promise<AuthTokensResponse> {
    return this.auth.switchOrg(auth.userId, this.sessionOf(auth), body.orgId);
  }

  @Post('2fa/setup')
  @HttpCode(200)
  setupMfa(@CurrentAuth() auth: AuthContext): Promise<TotpSetupResponse> {
    return this.mfa.setup(auth.userId);
  }

  @Post('2fa/enable')
  @HttpCode(204)
  async enableMfa(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(totpEnableSchema)) body: TotpEnableInput,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.mfa.enable(auth.userId, body.code, meta);
  }

  @Post('2fa/disable')
  @HttpCode(204)
  async disableMfa(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(totpDisableSchema)) body: TotpDisableInput,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.mfa.disable(auth.userId, body.password, body.code, meta);
  }

  private sessionOf(auth: AuthContext): string {
    if (!auth.sessionId) throw new AppError(ErrorCode.UNAUTHENTICATED, 'No session');
    return auth.sessionId;
  }
}
