import { Module } from '@nestjs/common';
import { ProfileModule } from '../profile/profile.module';
import { AuthController } from './auth.controller';
import { OidcService } from './oidc.service';
import { SessionService } from './session.service';

@Module({
  imports: [ProfileModule],
  controllers: [AuthController],
  providers: [OidcService, SessionService],
  exports: [SessionService],
})
export class AuthModule {}
