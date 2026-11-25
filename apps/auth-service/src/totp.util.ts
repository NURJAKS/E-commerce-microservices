import * as crypto from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

export function generateBase32Secret(numBytes = 20): string {
  return base32Encode(crypto.randomBytes(numBytes));
}

/**
 * Generates a 6-digit RFC 6238 TOTP code (30s step, HMAC-SHA1) compatible with Google Authenticator.
 */
export function generateTotpToken(
  base32Secret: string,
  stepOffset = 0,
  nowMs = Date.now(),
): string {
  const key = base32Decode(base32Secret);
  const counter = Math.floor(nowMs / 1000 / 30) + stepOffset;
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binary % 1_000_000).padStart(6, '0');
}

export function verifyTotpToken(
  base32Secret: string,
  rawCode: string,
  window = 1,
  nowMs = Date.now(),
): boolean {
  const code = (rawCode || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) {
    return false;
  }

  const candidateBuf = Buffer.from(code, 'utf8');
  for (let offset = -window; offset <= window; offset++) {
    const expected = generateTotpToken(base32Secret, offset, nowMs);
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (
      candidateBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(candidateBuf, expectedBuf)
    ) {
      return true;
    }
  }
  return false;
}

export function buildOtpAuthUri(
  email: string,
  secret: string,
  issuer = 'NovaShop',
): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const encodedIssuer = encodeURIComponent(issuer);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
}

const TOTP_CIPHER_PREFIX = 'enc:v1:';

function deriveTotpEncryptionKey(): Buffer {
  const rawKey =
    process.env.TOTP_ENCRYPTION_KEY?.trim() ||
    process.env.JWT_ACCESS_SECRET?.trim() ||
    'dev-totp-encryption-key-shop-2026';
  return crypto.createHash('sha256').update(rawKey).digest();
}

/**
 * Encrypts a Base32 TOTP secret at rest using AES-256-GCM.
 * Format: `enc:v1:<ivHex>:<authTagHex>:<cipherHex>`
 */
export function encryptTotpSecret(plainSecret: string): string {
  const key = deriveTotpEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainSecret, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${TOTP_CIPHER_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts an AES-256-GCM encrypted TOTP secret stored at rest.
 * Falls back transparently if an unencrypted legacy Base32 value is encountered.
 */
export function decryptTotpSecret(stored: string): string {
  if (!stored || !stored.startsWith(TOTP_CIPHER_PREFIX)) {
    return stored;
  }
  const body = stored.slice(TOTP_CIPHER_PREFIX.length);
  const parts = body.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted TOTP secret payload');
  }
  const [ivHex, tagHex, cipherHex] = parts;
  const key = deriveTotpEncryptionKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivHex, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipherHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function parseDeviceName(userAgent?: string): string {
  if (!userAgent) return 'Unknown Device';
  const ua = userAgent;

  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';
  else if (/curl/i.test(ua)) browser = 'cURL';

  let os = 'Unknown OS';
  if (/iPhone|iPad/i.test(ua)) os = 'iOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Linux/i.test(ua)) os = 'Linux';

  return `${browser} on ${os}`;
}
