-- Nonni (richiesta dell'utente, 15 ott 2026). Decisioni: «nonno» e «nonna» sono parentele distinte con le stesse
-- possibilità del figlio (account seguito con l'invito apposito), separate perché in futuro potranno divergere;
-- «nipote» serve al lato dei nonni. Le skill di chi viene seguito si scelgono persona per persona già nell'invito
-- (null = predefinite della tabella guardianships); chi accetta può correggere cosa è per lui chi lo invita.

ALTER TABLE family_links DROP CONSTRAINT family_links_relation_check;
ALTER TABLE family_links ADD CONSTRAINT family_links_relation_check
  CHECK (relation IN ('figlio','genitore','nonno','nonna','nipote','partner','altro'));
ALTER TABLE family_invites DROP CONSTRAINT family_invites_relation_check;
ALTER TABLE family_invites ADD CONSTRAINT family_invites_relation_check
  CHECK (relation IN ('figlio','genitore','nonno','nonna','nipote','partner','altro'));

ALTER TABLE family_invites ADD COLUMN allowed_skills text[];

-- Chi è la persona seguita per chi la segue: l'agente parla a un ragazzo in un modo e a un nonno in un altro.
ALTER TABLE guardianships ADD COLUMN relation text NOT NULL DEFAULT 'figlio'
  CHECK (relation IN ('figlio','nonno','nonna'));

-- Anteprima: come in 0030, più le skill che chi accetta potrà usare se l'account sarà seguito.
DROP FUNCTION family_invite_preview(text);
CREATE FUNCTION family_invite_preview(p_code text)
RETURNS TABLE (o_label text, o_my_label text, o_relation text, o_supervised boolean, o_allowed text[])
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT label, my_label, relation, supervised, allowed_skills FROM family_invites
   WHERE code = upper(trim(p_code)) AND used_at IS NULL AND expires_at > now()
     AND user_id <> app_current_user_id()
$$;
REVOKE ALL ON FUNCTION family_invite_preview(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION family_invite_preview(text) TO ernie_app;

-- Accettazione: la parentela inversa ha un valore predefinito (i nonni li invita di solito un figlio) che chi
-- accetta può cambiare; l'account seguito vale per figlio, nonno e nonna, con le skill scelte nell'invito.
DROP FUNCTION family_accept_invite(text, text);
CREATE FUNCTION family_accept_invite(p_code text, p_label text, p_relation text DEFAULT NULL)
RETURNS TABLE (o_id uuid, o_other uuid, o_label text, o_relation text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  me uuid := app_current_user_id();
  inv family_invites%ROWTYPE;
  inverse text;
  mine text;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'utente non impostato'; END IF;
  SELECT * INTO inv FROM family_invites
    WHERE code = upper(trim(p_code)) AND used_at IS NULL AND expires_at > now() FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF inv.user_id = me THEN RAISE EXCEPTION 'invito_proprio'; END IF;
  inverse := COALESCE(NULLIF(trim(p_relation), ''), CASE inv.relation
    WHEN 'figlio' THEN 'genitore' WHEN 'genitore' THEN 'figlio'
    WHEN 'nonno' THEN 'figlio' WHEN 'nonna' THEN 'figlio'
    WHEN 'partner' THEN 'partner' ELSE 'altro' END);
  mine := COALESCE(NULLIF(trim(p_label), ''), inv.my_label);
  INSERT INTO family_links (user_id, other_user_id, label, relation) VALUES (inv.user_id, me, inv.label, inv.relation)
    ON CONFLICT (user_id, other_user_id) DO UPDATE SET label = EXCLUDED.label, relation = EXCLUDED.relation;
  INSERT INTO family_links (user_id, other_user_id, label, relation) VALUES (me, inv.user_id, mine, inverse)
    ON CONFLICT (user_id, other_user_id) DO UPDATE SET label = EXCLUDED.label, relation = EXCLUDED.relation;
  IF inv.supervised AND inv.relation IN ('figlio','nonno','nonna') THEN
    IF inv.allowed_skills IS NULL THEN
      INSERT INTO guardianships (guardian_id, child_id, relation) VALUES (inv.user_id, me, inv.relation)
        ON CONFLICT DO NOTHING;
    ELSE
      INSERT INTO guardianships (guardian_id, child_id, relation, allowed_skills)
        VALUES (inv.user_id, me, inv.relation, inv.allowed_skills) ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  UPDATE family_invites SET used_by = me, used_at = now() WHERE code = inv.code;
  RETURN QUERY SELECT l.id, l.other_user_id, l.label, l.relation FROM family_links l WHERE l.user_id = me AND l.other_user_id = inv.user_id;
END
$$;
REVOKE ALL ON FUNCTION family_accept_invite(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION family_accept_invite(text, text, text) TO ernie_app;
