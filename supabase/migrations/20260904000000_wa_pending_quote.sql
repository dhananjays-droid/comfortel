-- A tapped "Get a quote" button starts a two-field intake (name, email) that
-- submitEnquiry needs but a button tap can't carry — this holds which
-- product ids the quote is for while flow.awaiting = 'quote' collects them
-- over the next message. See wa-session.ts's SessionPendingQuote.
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS pending_quote jsonb;
