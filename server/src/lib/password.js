import { scrypt as scryptCb, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing with scrypt (built into Node, no native dependency).
 *
 * Stored format: `scrypt$N$r$p$salt$hash`, salt and hash base64url. The cost
 * parameters travel with the hash, so they can be raised later and old hashes
 * still verify.
 */
const scrypt = promisify(scryptCb);

const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LEN = 64;
// N=2^15, r=8 needs 32 MiB; Node's default maxmem is exactly 32 MiB, so give
// it headroom.
const MAX_MEM = 64 * 1024 * 1024;

export const PASSWORD_MIN = 12;
// Upper bound keeps a huge body from turning hashing into a CPU sink.
export const PASSWORD_MAX = 256;

/** Hash a password for storage. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const { N, r, p } = PARAMS;
  const hash = await scrypt(password, salt, KEY_LEN, { N, r, p, maxmem: MAX_MEM });
  return ['scrypt', N, r, p, salt.toString('base64url'), hash.toString('base64url')].join(
    '$',
  );
}

/** Constant-time check of a password against a stored hash. False on any malformed input. */
export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64url');
  let actual;
  try {
    actual = await scrypt(
      String(password),
      Buffer.from(saltB64, 'base64url'),
      expected.length,
      {
        N: Number(N),
        r: Number(r),
        p: Number(p),
        maxmem: MAX_MEM,
      },
    );
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A real hash of a random password, computed once. Sign-in checks unknown
 * emails against it so a wrong email takes as long as a wrong password and
 * response time doesn't reveal which emails have accounts.
 */
let dummyHash;
export async function dummyVerify(password) {
  dummyHash ||= hashPassword(randomBytes(24).toString('base64url'));
  await verifyPassword(password, await dummyHash);
  return false;
}

/** Lowercase + trim; null if it doesn't look like an email address. */
export function normalizeEmail(email) {
  const e = String(email ?? '')
    .trim()
    .toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

/** A reason the password is unacceptable, or null if it's fine. */
export function passwordProblem(password) {
  if (typeof password !== 'string') return 'password is required';
  if (password.length < PASSWORD_MIN)
    return `password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX)
    return `password must be at most ${PASSWORD_MAX} characters`;
  return null;
}
