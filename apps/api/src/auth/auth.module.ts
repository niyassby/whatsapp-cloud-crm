import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditService } from '../audit/audit.service';
import { AccessGuard } from './access.guard';
import { PlanFeatureGuard } from './plan-feature.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthenticatorService } from './authenticator.service';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import { SessionCookies } from './session-cookies';
import { TokenService } from './token.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [
    TokenService,
    AuthenticatorService,
    PasswordService,
    AuthService,
    MfaService,
    SessionCookies,
    AuditService,
    // The only global guard: authentication -> tenant -> permissions.
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_GUARD, useClass: PlanFeatureGuard },
  ],
  exports: [
    TokenService,
    AuthenticatorService,
    PasswordService,
    AuthService,
    SessionCookies,
    AuditService,
  ],
})
export class AuthModule {}
