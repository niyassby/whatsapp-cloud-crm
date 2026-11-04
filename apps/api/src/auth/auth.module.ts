import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditService } from '../audit/audit.service';
import { AccessGuard } from './access.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import { SessionCookies } from './session-cookies';
import { TokenService } from './token.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [
    TokenService,
    PasswordService,
    AuthService,
    MfaService,
    SessionCookies,
    AuditService,
    // The only global guard: authentication -> tenant -> permissions.
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [TokenService, PasswordService, AuthService, SessionCookies, AuditService],
})
export class AuthModule {}
