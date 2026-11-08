# Automatic conversation report

The original conversation notes remain complete. The read-only **Raporla** field and the client debtor report's **Açıklama** column share one server-generated summary, limited to 300 Unicode characters. The client entitlement column is removed; paid and remaining client balances are retained.

The server summarizes the file's entire saved conversation history in chronological order. A new or deleted conversation invalidates the cached summary. Opening the conversation form or client report generates missing summaries. Repeated requests reuse the persisted summary when its source fingerprint is unchanged. CSV/PDF preparation includes all filtered pages and refuses to export pending summaries.

## Configuration

- `AI_GATEWAY_MODEL`: a current AI Gateway model ID, configured as `openai/gpt-4.1-mini` for this project.
- On Vercel, the function's platform OIDC token authenticates to AI Gateway. No provider key goes to the browser.
- Local development can use `AI_GATEWAY_API_KEY` or a locally pulled `VERCEL_OIDC_TOKEN` in an uncommitted environment file. Never commit these credentials.
- The Vercel team must have AI Gateway access and available credits. Missing configuration or provider failure displays an error and a retry button; it never overwrites the original notes or invents a replacement summary.

`POST /api/documents/conversation-report` accepts only a document ID. It checks account permissions and staff assignment, uses the saved history, and ignores client-supplied report text. Normal record patches cannot change the generated field. Generation is scoped to the selected file in the record store.

## Verification

`node --test --test-concurrency=1 tests/conversation-report.test.cjs`

`node scripts/check-conversation-ai.cjs` explicitly checks the real provider using synthetic notes only. It prints no credentials and never reads production application data.
