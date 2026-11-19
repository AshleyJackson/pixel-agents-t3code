import { isRecord } from '../../../../core/src/isRecord.js';
import { t3ShellSnapshotUrl } from './t3ActivityBridge.js';

const TOKEN_EXCHANGE_TIMEOUT_MS = 5_000;

export interface T3PairingCredential {
  baseUrl: string;
  credential: string;
}

export interface T3ReadToken {
  baseUrl: string;
  token: string;
  expiresAt: number;
}

/** Parse the one-time URL produced by T3's /pair page without exposing its token. */
export function parseT3PairingUrl(input: string): T3PairingCredential {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('T3 pairing URL must be an absolute HTTP(S) URL.');
  }

  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1';
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search
  ) {
    throw new Error(
      'T3 pairing URL must use HTTPS, or HTTP on loopback, without embedded credentials.',
    );
  }

  const pairPath = url.pathname.replace(/\/+$/, '');
  if (!pairPath.endsWith('/pair')) {
    throw new Error('T3 pairing URL must point to a /pair page.');
  }

  const credential = new URLSearchParams(url.hash.slice(1)).get('token')?.trim();
  if (!credential) throw new Error('T3 pairing URL is missing its one-time token.');

  const basePath = pairPath.slice(0, -'/pair'.length);
  url.pathname = basePath || '/';
  url.hash = '';
  const baseUrl = url.toString().replace(/\/$/, '');
  // Reuse the observer's URL policy so a pairing link cannot bypass its
  // HTTPS/loopback and embedded-credential checks.
  t3ShellSnapshotUrl(baseUrl);
  return { baseUrl, credential };
}

/** Redeem a T3 pairing link once, requesting no capability beyond observation. */
export async function exchangeT3PairingUrl(
  pairingUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T3ReadToken> {
  const { baseUrl, credential } = parseT3PairingUrl(pairingUrl);
  return exchangeT3Credential(baseUrl, credential, fetchImpl);
}

/** Redeem a short pairing code when its T3 server URL is configured separately. */
export async function exchangeT3PairingCode(
  baseUrl: string,
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T3ReadToken> {
  const shellEndpoint = t3ShellSnapshotUrl(baseUrl);
  const normalizedBaseUrl = shellEndpoint.replace(/\/api\/orchestration\/shell$/, '');
  if (!credential.trim()) throw new Error('T3 pairing code is required.');
  return exchangeT3Credential(normalizedBaseUrl, credential.trim(), fetchImpl);
}

async function exchangeT3Credential(
  baseUrl: string,
  credential: string,
  fetchImpl: typeof fetch,
): Promise<T3ReadToken> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: credential,
        subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        scope: 'orchestration:read',
        client_label: 'Pixel Agents observer',
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });
  } catch {
    throw new Error('T3 pairing token exchange request failed.');
  }

  if (!response.ok) throw new Error(`T3 pairing token exchange failed (HTTP ${response.status}).`);

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error('T3 pairing token exchange returned invalid JSON.');
  }
  if (
    !isRecord(result) ||
    typeof result.access_token !== 'string' ||
    !result.access_token.trim() ||
    result.token_type !== 'Bearer' ||
    result.scope !== 'orchestration:read' ||
    typeof result.expires_in !== 'number' ||
    !Number.isSafeInteger(result.expires_in) ||
    result.expires_in <= 0
  ) {
    throw new Error('T3 did not issue an orchestration:read bearer token.');
  }

  return {
    baseUrl,
    token: result.access_token.trim(),
    expiresAt: Date.now() + result.expires_in * 1000,
  };
}
