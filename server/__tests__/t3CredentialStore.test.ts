import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadT3Credential,
  saveT3Credential,
  t3CredentialFilePath,
} from '../src/providers/t3/t3CredentialStore.js';

const homes: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-t3-credentials-'));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('T3 credential store', () => {
  it('persists only the exchanged read-only token and reuses it for the same endpoint', () => {
    const home = makeHome();
    const expiresAt = Date.now() + 60_000;
    const credential = {
      baseUrl: 'http://127.0.0.1:3773/',
      token: 'read-only-bearer',
      expiresAt,
    };

    saveT3Credential(credential, home);

    const filePath = t3CredentialFilePath(home);
    const contents = fs.readFileSync(filePath, 'utf8');
    expect(JSON.parse(contents)).toEqual({ ...credential, scope: 'orchestration:read' });
    expect(loadT3Credential('http://127.0.0.1:3773', home)).toEqual(credential);
    expect(contents).not.toContain('pairing-code');
    if (process.platform !== 'win32') {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
    }

    const replacement = { ...credential, token: 'renewed-read-only-bearer' };
    saveT3Credential(replacement, home);
    expect(loadT3Credential('http://127.0.0.1:3773', home)).toEqual(replacement);
  });

  it('does not reuse a credential for another endpoint or after expiry', () => {
    const home = makeHome();
    saveT3Credential(
      {
        baseUrl: 'https://t3.example',
        token: 'read-only-bearer',
        expiresAt: 2000,
      },
      home,
      1000,
    );

    expect(loadT3Credential('https://other.example', home, 1500)).toBeNull();
    expect(loadT3Credential('https://t3.example', home, 2000)).toBeNull();
  });

  it('ignores malformed or non-read-only credential files', () => {
    const home = makeHome();
    const filePath = t3CredentialFilePath(home);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        baseUrl: 'https://t3.example',
        token: 'too-powerful',
        scope: 'orchestration:operate',
        expiresAt: Date.now() + 60_000,
      }),
    );

    expect(loadT3Credential('https://t3.example', home)).toBeNull();
    fs.writeFileSync(filePath, '{');
    expect(loadT3Credential('https://t3.example', home)).toBeNull();
  });
});
