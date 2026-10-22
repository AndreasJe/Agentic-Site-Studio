# M2 · Brief

**Plan:** §4 (all). **Screens:** `Brief.dc.html`. **Schema:** `contracts/brief.schema.json`.

## Build
Brief board with the ways in (guided questions, one prompt, material, import of the Markdown brief format, duplicate), blocks with sources, the block editor (guiding questions, AI actions with token ranges), structured calls to action, derived open questions and change log, export to the Markdown brief format, brief IDs per author (`alex2`).

## Done when
- [x] A field without a source is rejected and becomes "Not set yet."
  *Test:* `apps/studio/test/brief.test.ts` › a field without a source is rejected and becomes "Not set yet."; `apps/studio/test/brief-ai.test.ts` › a block the model returns without a source is dropped and stays "Not set yet."
- [x] Open questions never block approval, even when brief approval is Required.
  *Test:* `apps/studio/test/brief.test.ts` › open questions never block approval, even when approval is Required; › approval follows the install setting, and open questions never block it
- [ ] Import → export round-trips a Markdown brief unchanged. *Pending: Bjarke's Markdown template and sample briefs in `contracts/fixtures/briefs/`.*
- [x] Pasted notes and documents are sent to the model as data, never as instructions (a prompt-injection fixture has no effect).
  *Test:* `apps/studio/test/brief-ai.test.ts` › pasted notes go to the model as data in their own message, never as instructions; › a prompt-injection fixture has no effect
