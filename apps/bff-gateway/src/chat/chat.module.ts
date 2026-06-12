import { Module } from '@nestjs/common';
import { ChatProxyController } from './chat-proxy.controller';

@Module({
  controllers: [ChatProxyController],
})
export class ChatModule {}
