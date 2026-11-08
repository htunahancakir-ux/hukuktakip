# Automatic conversation report

Original conversation notes remain complete. The read-only Raporla field and client debtor report Açıklama column share a summary of at most 300 Unicode characters. Client entitlement is removed from this report; paid and remaining balances stay visible.

By default, summaries use Vercel AI Gateway with the provider/model configured by the CEO in Ayarlar → Yapay Zeka. The CEO can select another gateway provider/model or use a direct OpenAI API key. Direct keys are encrypted with AES-256-GCM at rest and are never returned to a browser.

The selected provider receives the conversation history only to create its summary. The prompt treats note content as untrusted data, never as instructions. A provider outage falls back to the existing local extractive summary so saving a conversation is never blocked.

Saving a conversation immediately updates its summary. Existing histories are summarized when their form or report opens. A source fingerprint caches unchanged histories. Manual report text is ignored server-side, and raw notes are never shortened. New or deleted notes invalidate old summaries. CSV/PDF preparation processes all filtered pages.

`/api/ai/config` is CEO-only. Its public response contains no API key—only whether one has been saved. Changing the AI configuration clears cached summaries so new reports use the chosen provider.

POST /api/documents/conversation-report accepts a document ID, checks permissions and staff assignment, and persists only the selected file.

Verify: node --test --test-concurrency=1 tests/conversation-report.test.cjs
