import {
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
import { FileService, MAX_RAW_BYTES } from './file.service';
import type { FileView } from './file.service';

// Internal surface for the BFF — never exposed through Caddy directly.
@Controller('files')
export class FileController {
  constructor(private readonly files: FileService) {}

  @Post()
  // Multer's own limit answers oversized bodies before they buffer fully;
  // the service re-checks so the cap does not depend on transport details.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RAW_BYTES } }))
  async upload(
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<FileView> {
    if (!file) {
      throw new BadRequestException('no file in the request (field name: file)');
    }
    return this.files.upload(userSub(req), file.originalname, file.mimetype, file.buffer);
  }

  @Get()
  list(@Req() req: Request): Promise<FileView[]> {
    return this.files.list(userSub(req));
  }

  @Get(':id')
  async download(
    @Req() req: Request,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { meta, content } = await this.files.download(userSub(req), id);
    res.setHeader('content-type', meta.mime);
    res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(meta.name)}"`);
    res.send(content);
  }

  /** Ops endpoint: rotate the KEK and re-wrap every DEK. */
  @Post('rotate-kek')
  rotate(@Req() req: Request): Promise<{ rewrapped: number }> {
    userSub(req); // any authenticated caller via the BFF-internal network
    return this.files.rotateKek();
  }
}

function userSub(req: Request): string {
  const sub = req.headers['x-user-sub'];
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new UnauthorizedException('missing user identity');
  }
  return sub;
}
