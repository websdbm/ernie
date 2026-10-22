-- Canonical private Todo snapshots; a view never creates a second task identity.
CREATE TABLE todo_lists (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  mode text NOT NULL CHECK(mode IN ('simple','scheduled')),
  day date,
  timezone text NOT NULL,
  revision integer NOT NULL CHECK(revision > 0),
  reminder_revision integer NOT NULL DEFAULT 0 CHECK(reminder_revision >= 0),
  items jsonb NOT NULL CHECK(jsonb_typeof(items)='array' AND jsonb_array_length(items)<=300),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,id),
  CHECK(mode <> 'scheduled' OR day IS NOT NULL)
);
CREATE UNIQUE INDEX todo_one_scheduled_day ON todo_lists(user_id,day) WHERE mode='scheduled';
ALTER TABLE todo_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE todo_lists FORCE ROW LEVEL SECURITY;
CREATE POLICY todo_lists_owner ON todo_lists USING(user_id=app_current_user_id()) WITH CHECK(user_id=app_current_user_id());

CREATE TABLE todo_list_revisions (
  user_id uuid NOT NULL,
  list_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision > 0),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,list_id,revision),
  FOREIGN KEY(user_id,list_id) REFERENCES todo_lists(user_id,id) ON DELETE CASCADE
);
ALTER TABLE todo_list_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE todo_list_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY todo_revisions_owner ON todo_list_revisions USING(user_id=app_current_user_id()) WITH CHECK(user_id=app_current_user_id());
-- Runtime can append history, never rewrite or remove revisions directly.
REVOKE UPDATE,DELETE ON todo_list_revisions FROM ernie_app;
GRANT SELECT,INSERT ON todo_list_revisions TO ernie_app;

-- Recovery scans disclose only IDs; root reconciles the latest owner-scoped snapshot.
CREATE FUNCTION todo_pending_reminders() RETURNS TABLE(user_id uuid,id uuid)
 LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT t.user_id,t.id FROM todo_lists t WHERE t.reminder_revision<t.revision
 ORDER BY t.updated_at,t.user_id,t.id LIMIT 100;
$$;
REVOKE ALL ON FUNCTION todo_pending_reminders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION todo_pending_reminders() TO ernie_app;
