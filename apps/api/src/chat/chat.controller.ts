import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { ChatService } from './chat.service';
import type { Conversation, ConversationListItem, MessageRecord } from './conversation.repository';

interface SendMessageBody {
  content?: unknown;
  fileIds?: unknown;
}

export interface MessageView {
  id: string;
  role: string;
  content: string;
  seq: number;
  fileIds: string[];
  createdAt: string;
}

// Internal surface for the BFF — never exposed through Caddy directly. The
// BFF injects the authenticated subject; see DECISIONS.md (slice 7).
@Controller('conversations')
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ChatController.name);
  }

  @Post()
  create(@Req() req: Request): Promise<Conversation> {
    return this.chat.createConversation(userSub(req));
  }

  @Get()
  index(@Req() req: Request): Promise<ConversationListItem[]> {
    return this.chat.listConversations(userSub(req));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id') id: string): Promise<void> {
    await this.chat.deleteConversation(userSub(req), id);
  }

  @Get(':id/messages')
  async list(@Req() req: Request, @Param('id') id: string): Promise<MessageView[]> {
    const messages = await this.chat.listMessages(userSub(req), id);
    return messages.map(toView);
  }

  @Post(':id/messages')
  async send(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: SendMessageBody,
    @Res() res: Response,
  ): Promise<void> {
    await this.pipeStream(res, this.chat.streamTurn(userSub(req), id, body.content, body.fileIds));
  }

  @Post(':id/messages/:messageId/edit')
  async edit(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body() body: SendMessageBody,
    @Res() res: Response,
  ): Promise<void> {
    await this.pipeStream(res, this.chat.streamEdit(userSub(req), id, messageId, body.content));
  }

  @Post(':id/welcome')
  async welcome(@Req() req: Request, @Param('id') id: string, @Res() res: Response): Promise<void> {
    await this.pipeStream(res, this.chat.streamWelcome(userSub(req), id));
  }

  private async pipeStream(res: Response, stream: AsyncGenerator<{ type: string }>): Promise<void> {
    // Validation/ownership failures happen before the first chunk — surface
    // them as plain HTTP errors, not as an SSE stream.
    let first: IteratorResult<unknown>;
    try {
      first = await stream.next();
    } catch (err) {
      if (err instanceof HttpException) {
        res.status(err.getStatus()).json(err.getResponse());
        return;
      }
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'chat turn failed before streaming',
      );
      res.status(502).json({ message: 'the model is unavailable, try again' });
      return;
    }

    res.status(200);
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();

    try {
      for (let result = first; !result.done; result = await stream.next()) {
        if (res.closed) {
          // Client went away: stop generating; the turn is not persisted.
          await stream.return(undefined);
          break;
        }
        const event = result.value as { type: string };
        writeEvent(res, event.type, event);
      }
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'chat stream failed mid-turn',
      );
      writeEvent(res, 'error', { message: 'the answer was interrupted, try again' });
    }
    res.end();
  }
}

function writeEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function userSub(req: Request): string {
  const sub = req.headers['x-user-sub'];
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new UnauthorizedException('missing user identity');
  }
  return sub;
}

function toView(message: MessageRecord): MessageView {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    seq: message.seq,
    fileIds: message.fileIds,
    createdAt: message.createdAt.toISOString(),
  };
}
