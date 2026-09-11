-- Isolated staff controls: never overwrite salon session/plan state.
CREATE TABLE public.wa_staff_conversations (
  session_key text PRIMARY KEY,
  manual_mode boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wa_staff_conversations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wa_staff_conversations FROM anon, authenticated;
GRANT ALL ON public.wa_staff_conversations TO service_role;

-- Claim before contacting Meta. An ambiguous send is never automatically retried.
CREATE TABLE public.wa_staff_replies (
  id uuid PRIMARY KEY,
  request_reference text NOT NULL REFERENCES public.wa_requests(reference),
  session_key text NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  state text NOT NULL DEFAULT 'sending' CHECK (state IN ('sending','accepted','failed','unknown')),
  wa_message_id text UNIQUE,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wa_staff_replies_session ON public.wa_staff_replies(session_key,created_at DESC);
ALTER TABLE public.wa_staff_replies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wa_staff_replies FROM anon, authenticated;
GRANT ALL ON public.wa_staff_replies TO service_role;

CREATE FUNCTION public.set_wa_staff_mode(p_session_key text, p_manual_mode boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO wa_staff_conversations(session_key) VALUES(p_session_key) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM wa_staff_conversations WHERE session_key=p_session_key FOR UPDATE;
  IF NOT p_manual_mode AND EXISTS(SELECT 1 FROM wa_staff_replies WHERE session_key=p_session_key AND state='sending' AND created_at > now()-interval '2 minutes') THEN RETURN false; END IF;
  UPDATE wa_staff_conversations SET manual_mode=p_manual_mode,updated_at=now() WHERE session_key=p_session_key;
  RETURN true;
END; $$;

CREATE FUNCTION public.claim_wa_staff_reply(p_id uuid,p_reference text,p_session_key text,p_body text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE active boolean;
BEGIN
  SELECT manual_mode INTO active FROM wa_staff_conversations WHERE session_key=p_session_key FOR UPDATE;
  IF active IS DISTINCT FROM true THEN RETURN false; END IF;
  INSERT INTO wa_staff_replies(id,request_reference,session_key,body)
    VALUES(p_id,p_reference,p_session_key,p_body) ON CONFLICT(id) DO NOTHING;
  RETURN FOUND;
END; $$;
REVOKE ALL ON FUNCTION public.set_wa_staff_mode(text,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_wa_staff_reply(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_wa_staff_mode(text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_wa_staff_reply(uuid,text,text,text) TO service_role;
