# WhatsApp requests and policy knowledge

Reviewed: 11 September 2026. Scope: WhatsApp only; customer-facing web chat unchanged.

## What customers can do

- Type **help**, or tap **Ask a question**, to choose sales, support, order help, complaints, request status or FAQs.
- Ask naturally: “My chair arrived damaged”, “Where is my order?”, “Book a showroom visit”, “I want to complain”. Ordinary product browsing and salon design continue through the existing assistant.
- Provide details and photos, review the summary, and tap **Submit request**. The bot only confirms after the database write succeeds.
- Receive a CF reference. Type **request status** to see the latest request's internal status.
- Type **cancel request** while drafting to leave intake without changing the salon plan.

These are internal requests, **not** completed purchases, live order tracking, return authorizations, confirmed appointments or guarantees of a reply. No calendar, order-management, CRM or email integration has been added. Staff must monitor the inbox.

## Staff workflow

Open `/admin/logs` and select **Requests inbox**, using the existing admin access gate. Only submitted requests appear. Filter by type; open the conversation or customer photo; explicitly reveal the contact when needed. Mark requests open, in progress or resolved. These changes do not send customer messages or modify actual orders.

The inbox now includes conversation history, direct text replies, WhatsApp delivery updates, and explicit **Take over / Return to bot** controls. Take over before replying; new customer messages then stay in the inbox without starting a bot response. Status changes are internal only: send a reply when the customer needs an update. See [admin reply rollout and limits](whatsapp-admin-replies.md).

This remains an administrator-only interface using the existing shared admin credential—not a new multi-user helpdesk. Do not distribute the cron/admin secret broadly. Individual staff accounts, assignment, external notification routing and SLA enforcement remain future work.

## The knowledge file actually used by WhatsApp

`src/data/wa-knowledge.json` is the versioned source of truth. Each entry contains its answer, source URL, publication/review status and internal review note. The bot uses curated answers and the same data constrains its WhatsApp-only model fallback. Customer messages cannot mark a policy approved.

**Website-published is not owner-approved.** Clear published facts are attributed; conflicting or model-specific claims require staff confirmation. Snapshot review is due 11 October 2026. Once expired, the bot stops quoting static policy details and directs customers to the current official contact page.

### Customer wording

Customer replies use plain, friendly language: the request has been received, its reference, and the relevant next step. They do not expose the admin inbox, database states, internal policy audits or unrelated disclaimers. An order enquiry still needs team confirmation before any requested change takes effect; a visit time still needs confirmation. Nothing promises a response time or implies a person has been assigned.

Policy answers have short topic labels and source links. Uncertain details are described as something the team needs to confirm for the customer's purchase. The audit findings below remain available to the business, but are not included in the model's customer-answer data. Existing WhatsApp messages and replay records are not rewritten; revised wording applies to new replies.

### Sources and review findings

| Topic | Official source | How WhatsApp handles it |
| --- | --- | --- |
| Delivery | [Shipping & Delivery](https://comfortelfurniture.com/service-support/delivery-shipping/) | Estimates are labelled estimates; no live stock/arrival guarantees. Special destinations require confirmation. |
| Returns | [Returns & Refunds](https://comfortelfurniture.com/service-support/returns-refunds/) | RMA required. Conflicting timing and fee wording is flagged; no automatic approval, rejection or refund calculation. |
| Warranty | [US Warranty](https://comfortelfurniture.com/service-support/warranty/) | Cite the US page, not the Australian footer link. Individual eligibility requires review. |
| Orders/contact/damage | [General FAQ](https://comfortelfurniture.com/service-support/general-faq/) | Explain published process; record customer-specific enquiries. No live order lookup. |
| Showrooms | [Contact Us](https://comfortelfurniture.com/contact-us/) | Collect preferred location/time; staff must confirm availability. |
| Financing | [Finance](https://comfortelfurniture.com/finance/) | Refer to official provider route; no rate, eligibility or tax promises. |
| Conflicts | [Terms & Conditions](https://comfortelfurniture.com/service-support/terms-and-conditions/) | Legal interpretation and claims go to staff. |

### Business decisions still needed

1. Resolve purchase-date versus receipt-date return deadlines, fee combinations and cancellation wording.
2. Reconcile the US warranty page with warranty disclaimers in the terms.
3. Clarify damage-reporting time windows. The bot urges prompt contact and does not reject late reports.
4. Confirm Canada coverage and duties/taxes; US-only terms conflict with shipping-page regional coverage.
5. Approve model-specific cleaning chemicals, weight limits, installation requirements and certifications. The bot must not infer these from photos.
6. Choose a policy owner and update/reapprove the JSON before its review date. Do not just extend the date without checking the linked sources.

Promotional codes and transient sale prices were intentionally excluded from the policy bank. No entire external help site was blindly imported, and no Australian policy is silently applied to US customers.

## Deployment and safety

Apply `supabase/migrations/20260911020000_wa_requests.sql` before deploying the code. It adds one isolated RLS-protected table and indexes; existing sessions, plans and render jobs are not rewritten. Contacts are encrypted with the existing phone-encryption key. Request details/photos are customer data and are visible only through the authenticated admin API (photos use the existing media storage mechanism).

Drafts and submitted records have no automatic deletion job in this first release. Agree a retention policy before using this inbox at scale; request contents may include personal data. No payment/identity documents should be collected. The inbox displays the most recent 200 submitted records; older records remain in the database.

Natural-language routing currently uses deterministic English phrase recognition, with explicit menu choices as the fallback. It is not a claim of complete multilingual understanding. Uncaptioned photos outside a request retain the existing salon-photo behavior. Voice/video processing is unchanged and not supported by the request intake.

Regression checks cover intent separation, confirmation-before-submit, failed writes, replayed webhooks, stale/cross-customer buttons, photos, cancellation, and knowledge expiry. Existing salon/render tests must also pass before rollout.
