import { describe, expect, it, vi } from 'vitest';

import {
  exchangeT3PairingCode,
  exchangeT3PairingUrl,
  parseT3PairingUrl,
} from '../src/providers/t3/t3Auth.js';

describe('T3 pairing URL auth', () => {
  it('extracts the environment URL and one-time token from a T3 pair link', () => {
    expect(parseT3PairingUrl('http://127.0.0.1:3773/pair#token=one-time-token')).toEqual({
      baseUrl: 'http://127.0.0.1:3773',
      credential: 'one-time-token',
    });
  });

  it('preserves a reverse-proxy path prefix while stripping /pair', () => {
    expect(parseT3PairingUrl('https://t3.example/t3/pair#token=encoded%20token')).toEqual({
      baseUrl: 'https://t3.example/t3',
      credential: 'encoded token',
    });
  });

  it('rejects unsafe, incomplete, or non-pair URLs without echoing their secret', () => {
    const secretUrl = 'http://t3.example/pair#token=private-token';
    expect(() => parseT3PairingUrl(secretUrl)).toThrow(/HTTPS/);
    expect(() => parseT3PairingUrl('https://user:pass@t3.example/pair#token=secret')).toThrow(
      /embedded credentials/,
    );
    expect(() => parseT3PairingUrl('https://t3.example/pair')).toThrow(
      /missing its one-time token/,
    );
    expect(() => parseT3PairingUrl('https://t3.example/other#token=secret')).toThrow(
      /point to a \/pair page/,
    );
    try {
      parseT3PairingUrl(secretUrl);
    } catch (error) {
      expect(String(error)).not.toContain('private-token');
    }
  });

  it('exchanges the pairing token for exactly orchestration:read', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('content-type')).toBe(
        'application/x-www-form-urlencoded',
      );
      const form = new URLSearchParams(init?.body as URLSearchParams);
      expect(form.get('subject_token')).toBe('one-time-token');
      expect(form.get('scope')).toBe('orchestration:read');
      return new Response(
        JSON.stringify({
          access_token: 'read-only-token',
          token_type: 'Bearer',
          scope: 'orchestration:read',
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });

    await expect(
      exchangeT3PairingUrl('http://127.0.0.1:3773/pair#token=one-time-token', fetchImpl),
    ).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:3773',
      token: 'read-only-token',
      expiresAt: expect.any(Number),
    });
    const result = await exchangeT3PairingUrl(
      'http://127.0.0.1:3773/pair#token=one-time-token',
      vi.fn<typeof fetch>(async () =>
        Response.json({
          access_token: 'read-only-token',
          token_type: 'Bearer',
          scope: 'orchestration:read',
          expires_in: 3600,
        }),
      ),
    );
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:3773/oauth/token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('redeems a pairing code against a separately configured loopback URL', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      Response.json({
        access_token: 'read-only-token',
        token_type: 'Bearer',
        scope: 'orchestration:read',
        expires_in: 3600,
      }),
    );

    await expect(
      exchangeT3PairingCode('http://127.0.0.1:3773/', ' one-time-code ', fetchImpl),
    ).resolves.toMatchObject({
      baseUrl: 'http://127.0.0.1:3773',
      token: 'read-only-token',
      expiresAt: expect.any(Number),
    });
  });

  it('rejects unsuccessful exchanges without exposing the supplied token', async () => {
    const fetchImpl: typeof fetch = async () => new Response('unauthorized', { status: 401 });
    await expect(
      exchangeT3PairingUrl('http://127.0.0.1:3773/pair#token=private-token', fetchImpl),
    ).rejects.toThrow('T3 pairing token exchange failed (HTTP 401).');
  });

  it('rejects a response that grants more than the read-only scope', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          access_token: 'too-powerful-token',
          token_type: 'Bearer',
          scope: 'orchestration:read orchestration:operate',
          expires_in: 3600,
        }),
        { status: 200 },
      );
    await expect(
      exchangeT3PairingUrl('http://127.0.0.1:3773/pair#token=one-time-token', fetchImpl),
    ).rejects.toThrow(/orchestration:read bearer token/);
  });
});
