-- Email + password sign-in, alongside passkeys. One login per user; the email
-- is stored normalized (trimmed, lowercased) and is unique across accounts.
-- Only a scrypt hash is stored, never the password. Like passkey_credentials,
-- this is an account table reached through account-level repository methods.

CREATE TABLE password_logins (
  user_id        text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email          text NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
