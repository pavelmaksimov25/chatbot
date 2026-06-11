import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { OidcService } from './oidc.service';
import { SessionService } from './session.service';

@Module({
  controllers: [AuthController],
  providers: [OidcService, SessionService],
  exports: [SessionService],
})
export class AuthModule {}
