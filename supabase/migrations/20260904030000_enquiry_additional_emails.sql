-- A quote request can name more than one recipient (a customer plus a
-- business partner, say) — `email` stays the primary/required one for
-- backward compatibility with the web app's existing enquiry form, and
-- this carries any others so the confirmation email can go to all of them.
ALTER TABLE public.enquiries
  ADD COLUMN IF NOT EXISTS additional_emails text[] NOT NULL DEFAULT '{}';
