-- Inoltro email al second brain (fase B3): il webhook di Brevo arriva senza utente autenticato e deve risalire
-- dal token dell'indirizzo (`<token>@dominio`) all'utente. La tabella users ha la RLS: la ricerca passa da una
-- funzione SECURITY DEFINER limitata a un token esatto (e il mittente viene poi controllato con l'email della scheda).
CREATE FUNCTION brain_inbox_user(p_token text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM users WHERE settings->>'brainInboxToken' = lower(trim(p_token)) LIMIT 1
$$;
REVOKE ALL ON FUNCTION brain_inbox_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION brain_inbox_user(text) TO ernie_app;
