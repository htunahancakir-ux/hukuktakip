# Automatic conversation report

Original conversation notes remain complete. The read-only Raporla field and client debtor report Açıklama column share a summary of at most 300 Unicode characters. Client entitlement is removed from this report; paid and remaining balances stay visible.

By default, summaries use Vercel AI Gateway with the provider/model configured by the CEO in Ayarlar → Yapay Zeka. The CEO can select another gateway provider/model or use a direct OpenAI API key. Direct keys are encrypted with AES-256-GCM at rest and are never returned to a browser.

The selected provider receives the conversation history only to create its summary. The prompt treats note content as untrusted data, never as instructions. A provider outage falls back to the existing local extractive summary so saving a conversation is never blocked.

Saving a conversation immediately updates its summary. Existing histories are summarized when their form or report opens. A source fingerprint caches unchanged histories. Manual report text is ignored server-side, and raw notes are never shortened. New or deleted notes invalidate old summaries. CSV/PDF preparation processes all filtered pages.

`/api/ai/config` is CEO-only. Its public response contains no API key—only whether one has been saved. Changing the AI configuration clears cached summaries so new reports use the chosen provider.

For a custom OpenAI-compatible provider, the model field offers the provider's own model list. `POST /api/ai/models` (CEO-only, rate limited, nothing is saved) reads `GET {Base URL}/models` on the server and returns only the sorted model ids (at most 500). The page asks once typing in Base URL or API key stops, when a saved provider opens, or when "Modelleri getir" is pressed; a name that is not listed can still be typed. Most providers require the API key for this call, so the list appears after the key is typed (a saved provider uses its saved key). A saved key is only sent to the Base URL it was saved for; a changed address needs the key typed again. The address must be an HTTPS host name with a dot, no redirects are followed, the response is size-limited, and a provider's own 401 is reported as a 502 so it never looks like an expired session.

POST /api/documents/conversation-report accepts a document ID, checks permissions and staff assignment, and persists only the selected file.

Verify: node --test --test-concurrency=1 tests/conversation-report.test.cjs tests/ai-models.test.cjs
