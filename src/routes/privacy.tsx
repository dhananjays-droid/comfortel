import { createFileRoute } from "@tanstack/react-router";

import { BrandMark } from "@/components/BrandMark";

/**
 * The privacy policy, and Meta's data-deletion instructions, on one page.
 *
 * Required to publish the Meta app — an unpublished app receives no production
 * webhooks at all, so this page is what stands between the WhatsApp number and
 * working. Meta wants a Privacy Policy URL and a data-deletion URL; both point
 * here, and the deletion section carries its own anchor so the second field can
 * be `/privacy#data-deletion`.
 *
 * Written from what the code actually does rather than from a template. Every
 * claim below is checkable: the HMAC in wa-session.server.ts, the 30-day expiry
 * in the sessions migration, the deliberate absence of any column holding a raw
 * photograph. If any of those change, this page has to change with them.
 */

const TITLE = "Privacy — Comfortel Assistant";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: TITLE },
      {
        name: "description",
        content:
          "How the Comfortel salon assistant handles your messages, photos and contact details.",
      },
    ],
  }),
  component: Privacy,
});

/** Kept beside the copy so the two cannot drift apart silently. */
const UPDATED = "3 September 2026";
const CONTACT = "dhananjay.s@quickads.ai";

function Section({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8" {...(id ? { id } : {})}>
      <h2 className="text-base font-semibold text-ink-1">{title}</h2>
      <div className="mt-2 space-y-3 text-sm leading-relaxed text-ink-2">{children}</div>
    </section>
  );
}

function Privacy() {
  return (
    <main className="mx-auto max-w-[68ch] px-6 pb-24 pt-12">
      <div className="flex items-center gap-2.5">
        <BrandMark className="h-6 w-6" />
        <span className="text-sm font-semibold text-ink-1">Comfortel</span>
      </div>

      <h1 className="mt-8 text-2xl font-semibold tracking-tight text-ink-1">Privacy policy</h1>
      <p className="mt-2 text-sm text-ink-3">Last updated {UPDATED}</p>

      <p className="mt-6 text-sm leading-relaxed text-ink-2">
        This covers the Comfortel salon furniture assistant, on our website and on WhatsApp. It
        describes what we hold, why, and for how long — in plain terms.
      </p>

      <Section title="What we collect">
        <p>
          <strong className="font-medium text-ink-1">Your messages.</strong> What you type to the
          assistant, and what it replies, so the conversation makes sense across turns.
        </p>
        <p>
          <strong className="font-medium text-ink-1">Photos of your space,</strong> when you choose
          to send one. Sending a photo is always optional — the assistant can build an example room
          instead.
        </p>
        <p>
          <strong className="font-medium text-ink-1">Your plan</strong> — the products you have
          shortlisted and how many of each.
        </p>
        <p>
          <strong className="font-medium text-ink-1">Contact details,</strong> only when you submit
          a quote request: your name, email, and optionally phone and business name.
        </p>
        <p>
          On WhatsApp, your phone number reaches us with every message. We do not store it. It is
          converted to an irreversible keyed hash and only that hash is saved, so our records cannot
          be turned back into a list of phone numbers.
        </p>
      </Section>

      <Section title="Why we hold it">
        <p>
          To answer you: to recommend products, work out what fits a room and a budget, render
          pieces into a photo of your space, and pass a quote request to the Comfortel team.
        </p>
        <p>We do not sell your data, and we do not use it for advertising.</p>
      </Section>

      <Section title="Who else sees it">
        <p>
          <strong className="font-medium text-ink-1">Anthropic</strong> processes your messages to
          generate the assistant&apos;s replies.
        </p>
        <p>
          <strong className="font-medium text-ink-1">kie.ai</strong> processes room photos to
          produce renders.
        </p>
        <p>
          <strong className="font-medium text-ink-1">Meta (WhatsApp)</strong> carries messages when
          you use the WhatsApp number, under their own privacy policy.
        </p>
        <p>
          <strong className="font-medium text-ink-1">Supabase</strong> hosts the database, and{" "}
          <strong className="font-medium text-ink-1">Vercel</strong> hosts the application.
        </p>
        <p>These are processors acting on our instructions, not parties we sell data to.</p>
      </Section>

      <Section title="How long we keep it">
        <p>
          Conversations and plans expire <strong className="font-medium text-ink-1">30 days</strong>{" "}
          after your last message, and are deleted.
        </p>
        <p>
          Room photos are not stored as part of your conversation. A render is produced from the
          photo and it is the render that is kept, not the original upload.
        </p>
        <p>
          Quote requests are kept while we deal with your enquiry and for our ordinary business
          records afterwards.
        </p>
      </Section>

      <Section id="data-deletion" title="Deleting your data">
        <p>
          Everything expires on its own after 30 days without you doing anything. On the website,
          starting a new chat also clears the conversation from your browser immediately.
        </p>
        <p>
          To have your data erased sooner — including any quote request — email{" "}
          <a className="underline underline-offset-2" href={`mailto:${CONTACT}`}>
            {CONTACT}
          </a>{" "}
          from the address you contacted us on, or tell us the WhatsApp number you used so we can
          match it to the hash we hold. We will confirm within 30 days.
        </p>
      </Section>

      <Section title="Your rights">
        <p>
          You can ask what we hold about you, ask us to correct it, or ask us to delete it. Use the
          contact address above.
        </p>
      </Section>

      <Section title="Children">
        <p>The assistant is for salon, barber and spa businesses, and is not aimed at children.</p>
      </Section>

      <Section title="Changes">
        <p>
          If this changes materially we will update the date at the top. Continuing to use the
          assistant after that means you accept the current version.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          <a className="underline underline-offset-2" href={`mailto:${CONTACT}`}>
            {CONTACT}
          </a>
        </p>
      </Section>
    </main>
  );
}
