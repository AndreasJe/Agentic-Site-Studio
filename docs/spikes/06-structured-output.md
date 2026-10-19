# Spike 6 · Structured output across providers

**Time box:** half a day. **Plan:** §14, §15; decisions #18, #20.

## Do
1. `llm()` against at least one cloud and one local OpenAI-compatible endpoint.
2. Capability flag per provider: `json_schema` / `json_object` / none.
3. Validate every response against its schema (Ajv or Zod); two retries that feed the validation error back; then a clear failure.
4. Request `stream_options.include_usage`; when missing, estimate with a tokenizer and mark the usage row `estimated`.

## Pass when
- Brief sorting (pasted notes → blocks with sources) passes schema validation on both endpoints.
- Usage rows are written for every call, including retries and failures.

## Result (partial, mock only)

Run against a mock OpenAI-compatible server (`spikes/06-structured-output/test/`), 12 tests passing.

- `llm()` streams with `stream_options.include_usage`, and works with all three capability flags (`json_schema` with a strict-mode-safe derived schema, `json_object`, `none` with the schema in the system message).
- Every reply is validated locally with Ajv 2020 and ajv-formats against the full contract (`contracts/brief-sort.schema.json`). Invalid then valid gives 2 usage rows. Always invalid gives `LlmSchemaError` after 3 attempts and 3 rows.
- A missing usage chunk is estimated (chars/4, `estimated = 1`). An HTTP 500 writes a failure row.
- No request carries `tools`, `tool_choice` or `functions`. The strict schema has no `allOf`, `if` or `then`. A prompt-injection fixture stays inside the quoted data message.

Not done: the real run against one cloud and one local endpoint waits for the endpoints, so the "passes on both endpoints" criterion is open.

Provisional: usage-row granularity (one row per HTTP attempt) and `outcome = 'pending'` depend on open questions B5 and B6.
