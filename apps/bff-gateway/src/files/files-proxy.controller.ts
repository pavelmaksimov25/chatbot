import {
  BadGatewayException,
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import '../auth/session.types';

const MAX_RAW_BYTES = 5 * 1024 * 1024;

/** Session-gated pass-through to the api's encrypted file surface. */
@Controller('files')
export class FilesProxyController {
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RAW_BYTES } }))
  async upload(
    @Req() req: Request,
    @Res() res: Response,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<void> {
    const sub = requireSub(req);
    if (!file) {
      throw new BadRequestException('no file in the request (field name: file)');
    }
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }),
      file.originalname,
    );
    const upstream = await this.api('/files', sub, { method: 'POST', body: form });
    res.status(upstream.status).json(await upstream.json());
  }

  @Get()
  async list(@Req() req: Request, @Res() res: Response): Promise<void> {
    const upstream = await this.api('/files', requireSub(req));
    res.status(upstream.status).json(await upstream.json());
  }

  @Get(':id')
  async download(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
  ): Promise<void> {
    const upstream = await this.api(`/files/${encodeURIComponent(id)}`, requireSub(req));
    if (!upstream.ok) {
      res.status(upstream.status).json(await upstream.json().catch(() => ({})));
      return;
    }
    res.status(200);
    for (const header of ['content-type', 'content-disposition']) {
      const value = upstream.headers.get(header);
      if (value) {
        res.setHeader(header, value);
      }
    }
    res.send(Buffer.from(await upstream.arrayBuffer()));
  }

  private async api(
    path: string,
    sub: string,
    init: RequestInit = {},
  ): Promise<globalThis.Response> {
    const base = process.env.API_URL ?? 'http://localhost:3001';
    try {
      return await fetch(`${base}${path}`, {
        ...init,
        headers: { ...init.headers, 'x-user-sub': sub },
      });
    } catch {
      throw new BadGatewayException('file service unavailable');
    }
  }
}

function requireSub(req: Request): string {
  if (!req.session.user) {
    throw new UnauthorizedException();
  }
  return req.session.user.sub;
}
