-- Utenti e credenziali client. Ogni dato della piattaforma sarà legato a users.id
-- (separazione dei dati tra utenti, criterio di successo n. 9).

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  text NOT NULL,
  locale        text NOT NULL DEFAULT 'it-IT',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Chiavi API per i client (app iOS, CLI). Si conserva solo l'hash SHA-256:
-- la chiave in chiaro viene mostrata una sola volta alla creazione.
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         text NOT NULL,
  key_hash      bytea NOT NULL UNIQUE,
  scopes        text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

CREATE INDEX api_keys_user_id_idx ON api_keys (user_id);
