# M2 · Brief

**Plan:** §4 (all). **Screens:** `Brief.dc.html`. **Schema:** `contracts/brief.schema.json`.

## Build
Brief board with the ways in (guided questions, one prompt, material, import of the Markdown brief format, duplicate), blocks with sources, the block editor (guiding questions, AI actions with token ranges), structured calls to action, derived open questions and change log, export to the Markdown brief format, brief IDs per author (`alex2`).

## Done when
- [ ] A field without a source is rejected and becomes "Not set yet."
- [ ] Open questions never block approval, even when brief approval is Required.
- [ ] Import → export round-trips a Markdown brief unchanged.
- [ ] Pasted notes and documents are sent to the model as data, never as instructions (a prompt-injection fixture has no effect).
