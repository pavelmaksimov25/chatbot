import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module';
import { UserServiceClientModule } from '../grpc/user-service-client.module';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

@Module({
  imports: [CacheModule, UserServiceClientModule],
  controllers: [ProfileController],
  providers: [ProfileService],
})
export class ProfileModule {}
