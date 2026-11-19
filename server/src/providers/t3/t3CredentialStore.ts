import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { isRecord } from '../../../../core/src/isRecord.js';
import { PIXEL_AGENTS_DIR } from '../../constants.js';
import { t3ShellSnapshotUrl } from './t3ActivityBridge.js';
import type { T3ReadToken } from './t3Auth.js';

const T3_CREDENTIAL_DIRECTORY = 't3';
const T3_CREDENTIAL_FILE = 'connection.json';
const T3_READ_SCOPE = 'orchestration:read';

export interface StoredT3Credential extends T3ReadToken {
  scope: typeof T3_READ_SCOPE;
}

export function t3CredentialFilePath(homeDir = os.homedir()): string {
  return path.join(homeDir, PIXEL_AGENTS_DIR, T3_CREDENTIAL_DIRECTORY, T3_CREDENTIAL_FILE);
}

/** Store only the exchanged bearer, never the five-minute pairing credential. */
export function saveT3Credential(
  credential: T3ReadToken,
  homeDir = os.homedir(),
  now = Date.now(),
): void {
  if (
    !credential.token.trim() ||
    !Number.isSafeInteger(credential.expiresAt) ||
    credential.expiresAt <= now
  ) {
    throw new Error('Cannot save an invalid or expired T3 credential.');
  }
  t3ShellSnapshotUrl(credential.baseUrl);

  const filePath = t3CredentialFilePath(homeDir);
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);

  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(
      fd,
      `${JSON.stringify({ ...credential, scope: T3_READ_SCOPE }, null, 2)}\n`,
      'utf8',
    );
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
    if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tempPath, { force: true });
  }
}

/** Load only a live read-only credential for the requested T3 endpoint. */
export function loadT3Credential(
  baseUrl: string,
  homeDir = os.homedir(),
  now = Date.now(),
): T3ReadToken | null {
  try {
    const saved: unknown = JSON.parse(fs.readFileSync(t3CredentialFilePath(homeDir), 'utf8'));
    if (
      !isRecord(saved) ||
      saved.scope !== T3_READ_SCOPE ||
      typeof saved.baseUrl !== 'string' ||
      typeof saved.token !== 'string' ||
      !saved.token.trim() ||
      typeof saved.expiresAt !== 'number' ||
      !Number.isSafeInteger(saved.expiresAt) ||
      saved.expiresAt <= now ||
      t3ShellSnapshotUrl(saved.baseUrl) !== t3ShellSnapshotUrl(baseUrl)
    ) {
      return null;
    }
    return {
      baseUrl: saved.baseUrl,
      token: saved.token,
      expiresAt: saved.expiresAt,
    };
  } catch {
    return null;
  }
}
