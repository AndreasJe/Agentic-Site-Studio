# M3 · Structure and new pages

**Plan:** §4.7, §4.10, §10. **Screens:** `Structure.dc.html`, `NewPage.dc.html`.

## Build
Site tree with several roots (own addresses), placement (in the menu, hidden, own address), inheritance panel, navigation pattern, menus (main, footer, utility, per-address main menu) filled by drag and drop and by a keyboard alternative, labels per site language, AI proposals as before/after menus, the new-page flow with page types, placement cards, mini-brief and the "Will live at … · Preview only" chip, address requests.

## Done when
- [x] Hidden pages can't be added to any menu; pages on another address can't be added to this address's menus; menu limits come from the pattern and the designed sections.
  *Test:* `apps/studio/test/structure.test.ts` › menus (M3 Done when)
- [x] Moving a parent moves its children and creates redirects.
  *Test:* `apps/studio/test/structure.test.ts` › pages and addresses
- [x] Navigation checks (§10.2) run and report correctly on fixtures.
  *Test:* `apps/studio/test/structure.test.ts` › navigation checks on fixtures (M3 Done when); fixtures in `contracts/fixtures/structure/`

**Result (20 Oct):**
- Known gaps:
  - menu limits come from the pattern only; limits from designed sections arrive in M4;
  - the Think new pattern, per-language labels and outline/sitemap import are not built;
  - projects have no live address yet (placeholder example.com until M7).
