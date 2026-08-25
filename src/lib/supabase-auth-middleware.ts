import { createMiddleware } from "@tanstack/react-start";

/**
 * Guarded stand-in for the generated `attachSupabaseAuth`.
 *
 * That middleware is registered globally, so it runs on EVERY server-function
 * call made from the browser, and it does `supabase.auth.getSession()`. The
 * browser Supabase client is built from VITE_SUPABASE_URL and
 * VITE_SUPABASE_PUBLISHABLE_KEY, which Vite inlines at BUILD time — so a build
 * that ran without them ships a client that throws the moment it is touched,
 * and every click in the app fails before its request ever leaves the page.
 * That is exactly how the first deploy broke: the page rendered, then sending a
 * message threw "Missing Supabase environment variable(s)" client-side.
 *
 * This app has no sign-in and no per-user rows, so "no session" is a normal
 * state rather than an error: attach the bearer token when Supabase is
 * configured, and carry on unauthenticated when it isn't. Chat and renders then
 * work with no Supabase at all, and only quote requests — which genuinely need
 * the service role — degrade.
 *
 * Deliberately not a patch to auth-attacher.ts: that file is generated and
 * would be overwritten.
 */
export const attachSupabaseAuthIfConfigured = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    let token: string | undefined;
    try {
      const { supabase } = await import("@/integrations/supabase/client");
      const { data } = await supabase.auth.getSession();
      token = data.session?.access_token;
    } catch {
      // Supabase isn't configured in this build. Proceed unauthenticated.
    }
    return next({ headers: token ? { Authorization: `Bearer ${token}` } : {} });
  },
);
