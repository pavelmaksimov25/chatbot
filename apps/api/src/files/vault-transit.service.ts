import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

const KEK_NAME = 'chatbot-kek';

export interface GeneratedDek {
  /** 32-byte AES key — exists only in memory, never persisted. */
  plaintext: Buffer;
  /** KEK-wrapped DEK blob (vault:vN:…) — the only form that touches disk. */
  wrapped: string;
}

/**
 * Thin client for Vault's Transit engine — the KMS-analog of this stack.
 * All KEY operations happen inside Vault (no DIY key management); the api
 * only ever holds a DEK transiently while encrypting/decrypting one request.
 */
@Injectable()
export class VaultTransitService implements OnModuleInit {
  /** Creates the KEK if it does not exist (idempotent). */
  async onModuleInit(): Promise<void> {
    if (!this.isConfigured()) {
      return; // surfaced as 503s at call time; readiness keeps its own probe
    }
    await this.request('POST', `/v1/transit/keys/${KEK_NAME}`, {}).catch(() => undefined);
  }

  isConfigured(): boolean {
    return Boolean(process.env.VAULT_ADDR && process.env.VAULT_TOKEN);
  }

  /** New DEK wrapped by the KEK — Vault's canonical envelope entry point. */
  async generateDek(): Promise<GeneratedDek> {
    const body = await this.request('POST', `/v1/transit/datakey/plaintext/${KEK_NAME}`, {});
    return {
      plaintext: Buffer.from(body.data.plaintext as string, 'base64'),
      wrapped: body.data.ciphertext as string,
    };
  }

  async unwrapDek(wrapped: string): Promise<Buffer> {
    const body = await this.request('POST', `/v1/transit/decrypt/${KEK_NAME}`, {
      ciphertext: wrapped,
    });
    return Buffer.from(body.data.plaintext as string, 'base64');
  }

  /** Re-wraps a DEK under the newest KEK version — no file bytes touched. */
  async rewrapDek(wrapped: string): Promise<string> {
    const body = await this.request('POST', `/v1/transit/rewrap/${KEK_NAME}`, {
      ciphertext: wrapped,
    });
    return body.data.ciphertext as string;
  }

  async rotateKek(): Promise<void> {
    await this.request('POST', `/v1/transit/keys/${KEK_NAME}/rotate`, {});
  }

  private async request(
    method: string,
    path: string,
    payload: Record<string, unknown>,
  ): Promise<{ data: Record<string, unknown> }> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('file encryption is not configured (Vault)');
    }
    const res = await fetch(`${process.env.VAULT_ADDR}${path}`, {
      method,
      headers: {
        'x-vault-token': process.env.VAULT_TOKEN!,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`vault ${path} answered ${res.status}: ${text.slice(0, 200)}`);
    }
    // Some Transit writes (key create, rotate) answer 204 with no body.
    if (res.status === 204) {
      return { data: {} };
    }
    return (await res.json()) as { data: Record<string, unknown> };
  }
}
