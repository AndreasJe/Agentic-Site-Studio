# Design

- `prototype/` — the clickable prototype: one `.dc.html` file per screen and `canvas.json` (layout and titles). Each file is a self-contained "Design Component": the markup is inside `<x-dc>…</x-dc>`, the shared styles are in `<helmet><style>` (everything above `/* ===== end shared ===== */` is identical on every screen), and the screen's state and handlers are in the `<script type="text/x-dc">` block (`renderVals()`). `{{name}}` holes, `<sc-if>` and `<sc-for>` are the template syntax. The files need the design canvas's runtime to run, so read them as a precise reference for layout, copy, states and interactions, not as code to copy.
- `screens.md` — every screen with route, plan section, interactions and milestone.
- `tokens.css` — colours, type, spacing and motion from the prototype.
- `icons.svg` — the custom icon set as a sprite, plus the AI mark and the approval seal. No stock icon libraries.

Live canvas (owner access): "Site Studio – clickable prototype" in Claude, https://claude.ai/artifact/2JShrBEAiNcDGz72F8L5SG

## Rules the UI keeps
- Sentence case. Buttons say what happens. The consequence is written next to the action.
- One primary action per screen, bottom right in the decision bar; on cards, bottom right of the card footer.
- The AI's mark is the half-filled disc ("drafted, not decided"); a person's approval is the seal.
- The work being built is shown large on the grey mat; the app's chrome stays neutral.
- Unknown facts are placeholders in square brackets.
- WCAG AA for the app itself: 4.5:1 text, visible focus, keyboard reachable, 44px targets, reduced motion respected.
- Demo names (Alex, Rune, Andreas) and QualiWare content are sample data only.
