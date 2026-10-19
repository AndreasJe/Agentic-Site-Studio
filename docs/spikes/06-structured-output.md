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
