CREATE TABLE ssh_account_state (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0)
);
CREATE TABLE ssh_keys (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 private_secret jsonb, public_key text NOT NULL, fingerprint text NOT NULL,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE TABLE ssh_servers (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,id uuid NOT NULL,
 name text NOT NULL,host text NOT NULL,port integer NOT NULL CHECK(port BETWEEN 1 AND 65535),username text NOT NULL,
 provider text CHECK(provider IN ('vultr','contabo')),provider_instance_id text,
 fingerprint text,observed_fingerprint text,revision integer NOT NULL DEFAULT 1,
 last_checked_at timestamptz,last_status text,source text,source_id text,
 manual_fields text[] NOT NULL DEFAULT '{}', PRIMARY KEY(user_id,id),
 UNIQUE(user_id,source,source_id),CHECK((source IS NULL)=(source_id IS NULL))
);
CREATE TABLE ssh_sites (
 user_id uuid NOT NULL,id uuid NOT NULL,server_id uuid NOT NULL,name text NOT NULL,url text NOT NULL,
 path text NOT NULL DEFAULT '',container text NOT NULL DEFAULT '',revision integer NOT NULL DEFAULT 1,
 source text,source_id text,manual_fields text[] NOT NULL DEFAULT '{}',PRIMARY KEY(user_id,id),
 FOREIGN KEY(user_id,server_id) REFERENCES ssh_servers(user_id,id) ON DELETE CASCADE,
 UNIQUE(user_id,source,source_id),CHECK((source IS NULL)=(source_id IS NULL))
);
CREATE TABLE ssh_provider_credentials (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,provider text NOT NULL CHECK(provider IN ('vultr','contabo')),
 secret jsonb,version integer NOT NULL DEFAULT 1,connected boolean NOT NULL DEFAULT true,last_checked_at timestamptz,
 PRIMARY KEY(user_id,provider)
);
CREATE TABLE ssh_operations (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,id uuid NOT NULL,server_id uuid NOT NULL,
 plan jsonb NOT NULL,target_snapshot jsonb NOT NULL,generation integer NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','running','succeeded','failed','uncertain','rejected','expired')),
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,started_at timestamptz,finished_at timestamptz,output text,
 PRIMARY KEY(user_id,id),FOREIGN KEY(user_id,server_id) REFERENCES ssh_servers(user_id,id) ON DELETE CASCADE
);
CREATE INDEX ssh_pending_by_owner ON ssh_operations(user_id,status);
CREATE TABLE ssh_audit_events (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,id uuid NOT NULL DEFAULT gen_random_uuid(),
 action text NOT NULL,metadata jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ssh_account_state','ssh_keys','ssh_servers','ssh_sites','ssh_provider_credentials','ssh_operations','ssh_audit_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY %I ON %I USING(user_id=app_current_user_id()) WITH CHECK(user_id=app_current_user_id())',t||'_owner',t);
 END LOOP;
END $$;
CREATE FUNCTION ssh_immutable_plan() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.plan,NEW.target_snapshot,NEW.generation,NEW.user_id,NEW.id,NEW.server_id,NEW.created_at,NEW.expires_at)
   IS DISTINCT FROM (OLD.plan,OLD.target_snapshot,OLD.generation,OLD.user_id,OLD.id,OLD.server_id,OLD.created_at,OLD.expires_at) THEN
  RAISE EXCEPTION 'SSH plans are immutable';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER ssh_operation_immutable BEFORE UPDATE ON ssh_operations FOR EACH ROW EXECUTE FUNCTION ssh_immutable_plan();
REVOKE UPDATE,DELETE ON ssh_audit_events FROM ernie_app;
