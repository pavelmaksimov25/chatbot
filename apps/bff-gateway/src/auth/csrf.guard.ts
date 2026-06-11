import { timingSafeEqual } from 'node:crypto';
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import './session.types';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global double-submit defense: every mutating request from a logged-in
 * session must carry the session-bound token in X-CSRF-Token. SameSite=Lax
 * already blocks most cross-site POSTs — this is defense in depth.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) {
      return true;
    }
    const sessionToken = req.session?.csrfToken;
    if (!req.session?.user || !sessionToken) {
      return true; // no session-backed privileges to forge
    }
    const header = req.headers['x-csrf-token'];
    if (typeof header === 'string' && safeEqual(header, sessionToken)) {
      return true;
    }
    throw new ForbiddenException('missing or invalid CSRF token');
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
