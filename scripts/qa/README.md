# Isolated WhatsApp customer QA

These scripts are outside the default unit-test glob. `findings.test.ts` now runs positive regression acceptance tests from the normal unit suite. Historical audit observations remain in `outputs/qa-2026-09-14/`. A green transport run alone is not an answer-quality score.

Run the free reproductions:

```sh
npx vitest run --config scripts/qa/qa.config.ts scripts/qa/findings.test.ts
```

The following runs spend existing service credits. Use only with explicit authorization. They read only the required service keys from `.env` and do not print them. Do not run against private customer images or use real customer contact details.

```sh
COMFORTEL_LIVE_QA=yes npx vitest run --config scripts/qa/qa.config.ts scripts/qa/customer.live.test.ts
COMFORTEL_IMAGE_QA=yes npx vitest run --config scripts/qa/qa.config.ts scripts/qa/images.live.test.ts
COMFORTEL_BUTTON_QA=yes npx vitest run --config scripts/qa/qa.config.ts scripts/qa/buttons.live.test.ts
node scripts/qa/export-results.mjs
```

- Customer run: real model, catalog, document and request routing; mock production database/network sends; in-memory requests/session serialization; never confirms a generation.
- Button run: one real curation request, actual package/role buttons, then dismisses image confirmation. No generation.
- Image run: restricted to THREE 1K cases (G05/G15/G17) against existing synthetic source rooms. No automatic paid retries. Reuses saved task IDs; completed/failed rows are skipped. Preserve `outputs/qa-2026-09-14-after/images.json`; deleting it and rerunning will buy new generations. `refresh-image-status.mjs` only checks existing task IDs and can retrieve late results without a new generation.
- Vision checks use the app's existing Anthropic inspectors. A returned OK is not enough: independently review results and inspect structured count/target coverage.
- Retest outputs are in `outputs/qa-2026-09-14-after/`. The question run overwrites its own retest transcript; the original audit is preserved. Set `COMFORTEL_QA_TARGETED=yes` with `COMFORTEL_LIVE_QA=yes` for only the 10 quote/comparison turns, saved separately in `outputs/qa-2026-09-14-final-documents/`.
- This does not test Meta delivery, production persistence, concurrent real webhooks, rate limits or live admin takeover. Those need a separate small authorized end-to-end smoke test after fixes.
