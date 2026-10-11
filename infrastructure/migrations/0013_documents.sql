-- Skill «Documenti»: testo estratto sul telefono (OCR), prodotti da studio e schemi; l'originale non viene conservato. RLS per utente.
CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL,
  source        text NOT NULL CHECK (source IN ('scan','photo','pdf')),
  language      text,
  pages         int NOT NULL CHECK (pages BETWEEN 1 AND 500),
  chars         int NOT NULL,
  page_texts    jsonb NOT NULL,                                 -- array di stringhe, una per pagina
  body          text NOT NULL,                                  -- testo intero (pagine unite)
  products      jsonb,                                          -- { abstract, keyPoints, glossary, questions, suggestedSchema }
  schemas       jsonb NOT NULL DEFAULT '{}'::jsonb,             -- { mindmap: {...}, flow: {...}, timeline: {...} }
  status        text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','summarized','deleted')),
  search        tsvector GENERATED ALWAYS AS (to_tsvector('italian', coalesce(title,'') || ' ' || left(coalesce(body,''), 200000))) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_search_idx ON documents USING gin (search);
CREATE INDEX documents_user_idx ON documents (user_id, updated_at DESC);
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
CREATE POLICY documents_owner ON documents USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
