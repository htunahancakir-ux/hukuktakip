# Automatic conversation report

Original conversation notes remain complete. The read-only Raporla field and client debtor report Açıklama column share a summary of at most 300 Unicode characters. Client entitlement is removed from this report; paid and remaining balances stay visible.

Summaries are generated locally by selecting significant sentences from the entire chronological conversation history. Recent outcomes, payment promises, amounts, dates, refusals and follow-up steps receive priority. Selected excerpts retain their source dates and original wording. This is deterministic sentence selection, not a generative language model. Long unpunctuated text uses excerpts marked with ellipses. No external AI service, credential, subscription or per-request AI charge is involved.

Saving a conversation immediately updates its summary. Existing histories are summarized when their form or report opens. A source fingerprint caches unchanged histories. Manual report text is ignored server-side, and raw notes are never shortened. New or deleted notes invalidate old summaries. CSV/PDF preparation processes all filtered pages.

POST /api/documents/conversation-report accepts a document ID, checks permissions and staff assignment, and persists only the selected file.

Verify: node --test --test-concurrency=1 tests/conversation-report.test.cjs
