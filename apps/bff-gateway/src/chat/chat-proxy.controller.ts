import {
  BadGatewayException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import '../auth/session.types';

/**
 * Thin pass-through to the api's conversation surface. The BFF's only jobs:
 * require a session, stamp the authenticated sub onto the internal request,
 * and pipe the SSE stream through WITHOUT buffering — chunks are forwarded
 * the moment they arrive or token streaming dies.
 */
@Controller('conversations')
export class ChatProxyController {
  @Post()
  async create(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sub = requireSub(req);
    const upstream = await this.api('/conversations', sub, { method: 'POST' });
    res.status(upstream.status).json(await upstream.json());
  }

  @Get()
  async list(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sub = requireSub(req);
    const upstream = await this.api('/conversations', sub);
    res.status(upstream.status).json(await upstream.json());
  }

  @Delete(':id')
  async remove(@Req() req: Request, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const sub = requireSub(req);
    const upstream = await this.api(`/conversations/${encodeURIComponent(id)}`, sub, {
      method: 'DELETE',
    });
    if (upstream.status === 204) {
      res.status(204).end();
      return;
    }
    res.status(upstream.status).json(await upstream.json().catch(() => ({})));
  }

  @Get(':id/messages')
  async messages(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
  ): Promise<void> {
    const sub = requireSub(req);
    const upstream = await this.api(`/conversations/${encodeURIComponent(id)}/messages`, sub);
    res.status(upstream.status).json(await upstream.json());
  }

  @Post(':id/messages')
  async send(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    const sub = requireSub(req);

    // Cancel the upstream generation when the browser goes away.
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const upstream = await this.api(`/conversations/${encodeURIComponent(id)}/messages`, sub, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: abort.signal,
    });

    if (!upstream.headers.get('content-type')?.includes('text/event-stream')) {
      res.status(upstream.status).json(await upstream.json().catch(() => ({})));
      return;
    }

    res.status(upstream.status);
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();

    try {
      for await (const chunk of upstream.body ?? []) {
        res.write(chunk);
      }
    } catch {
      // Upstream died or the client aborted — there is nothing meaningful
      // left to send on a half-finished event stream.
    }
    res.end();
  }

  private async api(path: string, sub: string, init: RequestInit = {}): Promise<globalThis.Response> {
    const base = process.env.API_URL ?? 'http://localhost:3001';
    try {
      return await fetch(`${base}${path}`, {
        ...init,
        headers: { ...init.headers, 'x-user-sub': sub },
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw err;
      }
      throw new BadGatewayException('chat service unavailable');
    }
  }
}

function requireSub(req: Request): string {
  if (!req.session.user) {
    throw new UnauthorizedException();
  }
  return req.session.user.sub;
}
