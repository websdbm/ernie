-- Estensioni richieste dalla piattaforma.
-- vector:   ricerca semantica (pgvector) per il Memory Engine.
-- pgcrypto: digest/cifratura lato database (hash chiavi API, campi sensibili).
-- pg_trgm:  ricerca fuzzy su nomi di tool, skill e memorie.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
