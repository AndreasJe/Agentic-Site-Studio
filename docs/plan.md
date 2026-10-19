# AI Site Studio — Plan

Version 4.0 · 19 October 2026 (developer decisions folded in; see §26)
Owner: Andreas Jensen · Design workflow: Bjarke
Showcase for Bjarke: Monday 19 October 2026

---

## 1. Purpose

A web app where people without technical or design skills build static websites with AI: from brief and sitemap to layout, content and design, through to a live site. The AI does the work; people steer, comment and approve.

The first version is a showcase of Bjarke's design workflow (Brief Generator + Design Agent). It must protect his work, not replace it with something more complicated, and it must let several people work at the same time without overwriting each other.

Requirements:

- Works with any OpenAI-compatible model provider (cloud or local).
- Several users at once, without conflicts.
- Data stored locally on our own server, in a form the AI can read easily.
- Nothing is ever lost: people can test freely and go back.
- Static output, with room for radical design, not template-driven.
- UI in English, with Danish supported.

---

## 2. Principles

1. **The platform owns the state; the model is a replaceable worker.** What made the Claude Code canvas workflow good (persistent files, tools to see its own output, a human who approves) becomes the app's job, not the model's.
2. **Bjarke's workflow is the app's structure; the rules are data edited in the app.** Phases, sections with checklists, artboard roles and section-by-section approval are built into the app. The company's design rules, brief setup and design setup are defined once, in **Brand and rules**, apply to every project and can be changed there without a developer (§5). Bjarke's tooling (scripts, labels in the HTML, naming tricks) is not carried over; the app handles that itself.
3. **Rules are data.** Hard rules are enforced by code (schema, validator, permissions). Soft rules live in prompts and are judged by a critic model. If it can be measured, it's hard — except accessibility, which is advisory (see §7).
4. **Nothing is overwritten.** Every save is a new immutable version. Going back never destroys newer work.
5. **Design freely once, compose safely after.** The approved design becomes the site system; new pages start from it.
6. **Git is the release log, not the workspace.** Design work happens in the app's revision model; only approved revisions go to git.
7. **Restraint by default.** One direction per request. Extra variants and experiments only when someone asks for them (see §6.4).
8. **The AI drafts; it never decides.** Every aspect of its work is checked by code, by an AI review and by a person before anything goes live (§13.5). It has no tools with consequences: no git, no releases, no file system.

---

## 3. Phases

| Phase | Output | Gate |
|---|---|---|
| 1. Brief | Brief blocks, sitemap, page jobs | Project setting: Off / Optional / Required. Open questions never block. |
| 2. Design | Artboards per page, sections with checklists, a Lead per page | Section checklist (7 items) per section of the Lead |
| 3. Verification | Check report, accepted deviations, hand-off package | Automated checks + human approval |
| 4. Build | Static site (HTML/CSS/JS) in the built-in release log | Creator approves → check runner → staging → Creator requests publication → Admin approves from an email link with a passkey (§13) |

Environments:

- **Drafts:** each person edits in a private draft, autosaved and visible only to them (§11.1).
- **Experimental:** every saved revision gets its own preview URL on the preview address (`preview.internal`), a separate site from the app. No git, no pipeline.
- **Staging:** the newest revision a Creator has approved, served from the preview address. This is where the team tests. Preview, staging and production serve the same built package, byte for byte (§9).
- **Production:** locked behind Admin controls. Only the exact package already on staging, released with an Admin's passkey (§13.3).

---

## 4. Brief module

Based on Bjarke's "Content Site – Brief Generator v1" instructions and template.

### 4.1 Structure

- **Header (metadata):** Title, ID, Author, Scope, Status, template version.
- **Blocks** (Bjarke's template sections): Audience, Core message, How we'll know it works, Calls to action, Proof available, Left out on purpose. Plus structure, page jobs, ways in, sitemap and page order.
- **Derived, not hand-written:** Open questions (from blocks marked "Not set yet.") and Change log (from version history).

### 4.2 IDs and authors

- Brief ID: `<handle><n>`, e.g. `bjarke2`. Allocated by the database, one counter per author, never changed or reused, not even after deletion.
- Handle: letters a–z only, no hyphens (Anne-Marie → `annemarie`).
- Author comes from the login. Bjarke's "ask who the author is" rule disappears because each person has their own account.
- File name pattern (`<author>-<client>[-<topic>]-site-brief-<n>.md`) only matters on export.

### 4.3 Two ways in, one board

- **Guided:** one predefined question per block. Skippable; skipped blocks become "Not set yet." and an open question.
- **One prompt:** paste notes, an email or a description; the AI sorts it into blocks.
- Both land on the same board. Users can switch to guided mode for just the open blocks.
- **The question set** is drafted in §4.9. Admins and Creators edit it in Brand and rules › Brief setup (§5).

### 4.4 Blocks are editable

- Clicking a block opens it in the side panel: guiding questions, a large text field, AI actions (Ask me follow-ups, Tighten, Mark as not set yet), and the source.
- **Calls to action** are structured: button text, where it goes (page or external link), what the visitor gets, primary/secondary, add more.

### 4.5 "Don't invent" is a hard rule

Every filled field must have a source: the user or an existing brief. AI output is validated against a schema; a field without a source is rejected and becomes "Not set yet."

### 4.6 Open questions are advisory

A brief can always move on with open questions. Even when brief approval is "Required", open questions don't block approval.

### 4.7 Sitemap

- **Project-wide**, not tied to one phase. Seeded in the brief, editable at any time; the "Sitemap" button in the header opens the same tree from every screen.
- Add a page, make it a subpage, move it out a level, reorder. Numbering follows the tree (2, 2.1, …).
- Each page is marked **Decided**, **Proposed** (from the brief) or **Added later** (Bjarke's "Added here").
- Not moved to Build: design needs the page list to know what to design.
- The sitemap is every page; which pages appear in the menus is the navigation, a separate artifact the AI can reorganise. Both are edited in the Structure workspace (§10.2). Hidden pages are in the tree but not in any menu (§10.3).

### 4.8 Export

A brief can always be exported as the exact Markdown Bjarke uses today, so his existing Design Agent can read it unchanged during the transition.

### 4.9 Question set v1

Generic enough for most business sites, tuned for a B2B software company (enterprise architecture with an AI focus). One main question per block; the indented questions are the guiding questions in the block editor. Every question can be skipped.

1. **Scope:** What are we making, and why now?
   - Is it a whole site, a section or one page?
   - What triggered it: a launch, a new offering, outdated content, a campaign?
2. **Audience:** Who is the main visitor?
   - What is their role (e.g. CIO, enterprise architect, transformation lead, process owner, compliance)?
   - What do they already know about us, about enterprise architecture and about AI?
   - What problem are they trying to solve when they arrive?
3. **Core message:** What is the one thing a visitor should remember?
   - Why should they believe it?
   - Is AI the headline of the story, or the support for it?
4. **Calls to action:** What should the visitor do next?
   - What is the primary action, and is there a secondary one (book a demo, start a trial, download a report, contact sales)?
   - What does the visitor get, and what happens after they click?
5. **Proof available:** What can we show to back it up?
   - Customer stories, analyst reports or awards, certifications?
   - Which results or numbers can we stand behind?
6. **Ways in:** How do visitors find this?
   - Search, campaigns, LinkedIn, partners, sales emails, events?
   - What do they expect to see first when they land?
7. **Pages and their jobs:** Which pages do we need, and what is each page's job?
   - Which are decided, and which are proposals? (Seeds the sitemap.)
8. **How we'll know it works:** What should change after launch?
   - Which signal matters most: demo requests, trials, downloads, time on page?
   - Is there a target, or just a direction?
9. **Tone and feel:** How should it feel?
   - Three words for the tone.
   - How alive should it be: calm and still, or expressive with motion and 3D?
   - A site you admire, and what you admire about it.
10. **Left out on purpose:** What are we deliberately not saying or showing?
    - Products, audiences or claims to leave out (e.g. AI claims we can't back yet).

"Tone and feel" is not in Bjarke's template today. It feeds the Motion axis (§6.7) and the mini-brief for new pages (§10).

---

### 4.10 Ways to build and edit a brief

A brief can be built in several ways, and they can be mixed. Whatever the route, everything lands in the same blocks, each with its source.

| Way | What happens |
|---|---|
| **Guided questions** | One question per block (§4.9). Skipped blocks become open questions. |
| **One prompt** | Paste notes, an email or a description; the AI sorts it into the blocks. |
| **Material** | Drop in documents (PDF, Word, slides); the AI fills blocks from them, with the document as the source. |
| **Edit blocks directly** | Click a block: guiding questions, a large text field, structured fields for calls to action, and AI actions (ask me follow-ups, tighten, mark as not set). |
| **Import** | An existing brief in Bjarke's Markdown format comes in with its ID kept. |
| **Duplicate** | Start from an earlier project's brief and change what's different. |
| **Mini-brief** | New pages inherit from the site brief and only ask what's new (§10.1). |

**The site tree is part of the brief.** The block "Pages and their jobs" (§4.9, question 7) is the same tree as the Structure workspace (§10.2): editing one edits the other. The tree can be built in four ways, also mixable:

- **The AI drafts it from the brief:** "Draft structure" proposes pages, parents, jobs and placements from the audience, page jobs, ways in and calls to action. Everything it adds is marked **Proposed** until a person accepts it.
- **By hand:** add pages, drag them under parents, set placement and address.
- **From an outline:** paste an indented list, or upload an existing `sitemap.xml`, and it becomes a tree.
- **Fill the gaps:** "Suggest missing pages" checks the brief against the tree, e.g. a call to action "Book a demo" with no page for it.

## 5. Brand and rules (defined once, edited in the app)

### 5.1 What is built in and what is editable

- **Built into the app (Bjarke's architecture):** the four phases, what each phase reads and writes, its actions, sections with a checklist, artboard roles, one Lead per page, section-by-section approval, revisions. This is not configured; it is how the app is built.
- **Editable in Brand and rules:** the company's design rules, brand assets and fixed elements (§5.5), the brief setup, the design setup, and (advanced) the AI instructions per phase. Admins and Creators can edit it.
- **Organisation level:** the app is universal, so Brand and rules belongs to the organisation and applies to all its projects. QualiWare's guide is the first one; another company would define its own.
- **Starting point:** we import the design guide Bjarke shared, so the editors open with QualiWare's rules instead of empty.

### 5.2 The editors (Brand and rules, in the main menu)

Everything is edited interactively, never in files:

- **Typography:** upload fonts, choose the dominant font, preview each font in use. Only fonts listed here can be used.
- **Colours:** the palette with roles: primary, secondary, highlight only, destructive only.
- **Derived colours:** pick one or two guide colours and drag a slider; the app shows the exact recipe and hex immediately and saves it with a role (e.g. borders, hover). New hues can't be created here, only tints, shades and mixes. Colours are mixed in OKLab, clipped to the sRGB gamut and rounded to 8-bit hex, by one shared module used by both the editor and the validator (§26, decision 14).
- **Contrast:** the WCAG table is calculated from the colours, so it is always up to date (advisory, §7).
- **Motion:** durations, easing and distances, with a small live animation for each value (§6.7).
- **Brand assets:** logos and other fixed brand elements (§5.5). Other images live in the media library (§6.8).
- **Brief setup:** blocks and questions (add, reword, reorder, guiding questions) and which brief is the reference for tone of voice (§4.9).
- **Design setup:** the checklist items, page types and their defaults (§10), and the variation axes (§6.4).
- **AI instructions per phase (advanced):** the prompt text for each phase, versioned.

### 5.3 Under the hood

The editors save everything as data. The app generates two things from it:

- `guide.json` for the validators:

```json
{
  "fonts": ["PT Sans", "PT Sans Narrow", "PT Sans Caption",
            "PT Serif", "PT Serif Caption", "PT Mono"],
  "dominant": "PT Sans",
  "colors": {
    "dark-green": { "hex": "#2b675b", "role": "primary" },
    "alert-red":  { "hex": "#b1263d", "role": "destructive-only" },
    "qw-green":   { "hex": "#00ff00", "role": "highlight-only" }
  },
  "derived": [
    { "hex": "#e3f1ee", "recipe": "62% ice-blue + white", "use": "borders" }
  ]
}
```

- The guide prose the model reads, so the AI and the validators always use the same rules as the editor shows.

Validators:

- **Fonts (hard):** every computed `font-family` must be on the list.
- **Colours (hard):** every colour must be a guide colour or a registered derived colour. The validator recomputes each recipe (OKLab) and rejects a hex that doesn't match exactly. Existing derived colours are imported as golden test vectors; any that differ under OKLab go on a list for design sign-off, and each either takes the OKLab value or is pinned as an explicit hex override.
- **Scope:** validators cover text in the page and colours and fonts defined in CSS. Canvas/WebGL, raster images and video are out of scope and go on a manual review checklist. Text over images gets a warning-only heuristic (§26, decision 13).
- **Contrast (advisory, §7).**
- **Soft rules for the critic:** full-strength guide colours dominate; derived colours used sparingly; creative font use.

### 5.4 Changes are versions

- Every change to Brand and rules is a new version, with an overview of what changed.
- New work follows the new version. The app shows which projects are affected.
- Accepted "Propose to the guide" deviations (§6.6) become a new version in the same way.
- Existing briefs are migrated when the brief setup changes (as when Deadline was removed from Bjarke's template).
- Every change is in the audit log and can be rolled back. Admins can be notified when Brand and rules changes, without it needing their approval.

### 5.5 Brand assets and fixed elements

Fixed elements are defined once and used everywhere. Pages can't change them; they are changed in one place.

- **Logos must be SVG.** A logo is accepted only as a clean vector SVG: paths and fills, no embedded raster images, no scripts, no external references. That is what makes colour changes possible.
- **Logo studio** (in Brand assets): a person makes the variants from the master SVG:
  - **Recolour** each part of the logo, limited to guide colours and registered derived colours. The app reads the SVG's fills, shows each part, and saves the variant as a recipe (which colour on which part), like derived colours.
  - **Ready-made variants:** for light backgrounds, for dark backgrounds, single-colour and inverted, each checked for contrast against the backgrounds it is meant for.
  - **Lockups:** the logo with a product or sub-brand name in PT Sans (e.g. "QualiWare GO"), with fixed spacing.
  - **Clear space and minimum size** set once, shown as a guide in the preview.
  - **Exports:** favicon, app icons and social share image generated from the variants in the right sizes.
  - New logos from scratch are out of scope. The studio works from the company's existing logo.
- **Automatic variant on pages:** the app picks the variant that stays visible on the background behind it (Bjarke's logo check, automated). The AI never draws, alters or recolours a logo on a page; it can only place a variant made in the logo studio.
- **Logo check in verification:** the logo comes from Brand assets, the variant matches the background, the proportions aren't distorted, and the clear space is kept.
- **Brand icons and graphic elements:** icons, arrows, watermarks and patterns (Bjarke's `brand/` and `icons/` folders).
- **Favicon, app icons and social share image** for each site, generated by the logo studio.
- **Fixed site elements:** header, footer, contact details and legal text. These are the partials from §9: edited once, picked up by every page at the next export.
- Fonts live under Typography (§5.2).

---

## 6. Design module

### 6.1 Screens

- **Design overview:** artboards per page at a readable size, with role, short description, section progress, and the same actions in the same place on every card ("Open in editor" bottom right, secondary actions to its left).
- **Design editor:** outline (whole page + sections with status) · the page at full size with clickable section labels · device switch (desktop/tablet/mobile) · hide labels · inspector (layout variants, content fields, checklist) · prompt bar where scope follows the selection.

### 6.2 Roles and sections (from Bjarke's Design Agent)

- Roles: **Lead** (built), **Alternative**, **Reference** (parked), **State** (child: drawn state or mobile version).
- **One Lead per page** is a database constraint. Changing the Lead asks in the same action what the old Lead becomes.
- **Section checklist:** Copy, Media, Interactions, Mobile, Motion, Translated, Tested. Status is derived (In development n/7 or Approved), never set by hand.
- **Approved sections are locked.** Unlocking is deliberate and turns the affected checklist items off.
- **Whole-page changes create a new Alternative**; they never change a Lead with approved sections.
- **Copied sections keep their progress:** the app compares text and media with the source and only turns off the items the change touches.
- **Interaction check:** the app finds every link, button and form in a section and opens a question for each element without a destination. Interactions can only be switched on when none are open.
- **Mobile** can only be switched on when a mobile variant exists.

### 6.3 Annotations are UI, not design

Section labels, role chips, checklist toggles and click-to-copy live in an overlay in the app. They are never part of the design HTML, so there's nothing to strip, no contrast exemptions, and no "don't build this" notes.

The one exception is a neutral `data-section="<stable-id>"` attribute on each section. It ships to production, is unique per page (validator rule) and is what the review shell, the visual comparison and the section clicks use. On screen, sections are named by their plain name (Hero, Proof…); the position number (s1, s2…) is not shown. One context line on every review screen says what is being reviewed: page · revision · Lead · how many sections changed.

### 6.4 Variants and experiments (decision 18 Oct)

- **Default is one direction per request.** Always generating three full pages costs too much and dilutes attention.
- **More only on request, along a named axis** ("Show another take on…"). The user first picks a group, then an axis:
  - **Form**
    - **Layout:** how the section is arranged.
    - **Density:** the amount of content and whitespace.
    - **Depth:** flat (everything shown directly) or layered (details behind tabs, accordions, hovers or popups). Layered adds states to draw and items to the interaction check, so it takes longer to approve; the UI says so when it's chosen.
    - **Navigation:** the navigation pattern (site level, chosen in the Structure workspace, §10.2).
    - **Media:** text-led, balanced or visual-led. Visual-led needs real images, video or 3D in the asset library; otherwise it ends up with placeholders.
  - **Feel**
    - **Tone:** the voice of the copy.
    - **Colour rhythm:** which guide colours carry the bands.
    - **Motion:** how alive it feels, from still to animated to 3D (§6.7).
- **The user can describe the direction.** After picking an axis, an optional text field asks what they want, e.g. "warmer and more personal", "calmer, less movement", "more like a technical spec sheet". A few quick choices per axis (e.g. Motion: calmer · more alive · go 3D) help people who don't know what to write. The text steers only the chosen axis: if it asks for something outside it, the impact preview shows that before anything is applied.
- Variations are made at section level by default, one per request. Whole-page variations only for layout.
- **Visual style is a site-level choice, not an axis.** Minimal and clean, bold and editorial, soft and rounded, or technical, dark and data-driven: it is picked when the site's first direction is made, or when someone asks for a new direction for a whole page. After that it is part of the site system and can only change inside a section with "Explore" or "Think new".
- **A section's job comes from the brief, not from a variation.** Each section has a job from the brief's page jobs: inform, prove or convert. A variation never changes it. If the AI thinks a section should have another job, it proposes a change to the brief instead.
- **Experiments only through the "Think new" toggle** (§6.5).
- A token estimate is shown before generating.

### 6.5 Creative freedom

Three rule layers: **brand guide** (company) → **site system** (this site's components, derived colours and patterns, built up as sections are approved) → **page**.

| Level | May go outside | Default for |
|---|---|---|
| Follow the site | nothing | core pages, customer stories, every prompt |
| Explore | the site system, within the guide (new components need an OK) | landing pages, campaigns |
| Think new | the guide | never a default; switched on with a toggle |

**"Think new" is a toggle, not a prompt word.** It sits next to the prompt bar, is off by default and is styled as a warning: amber, with one line saying what it allows and what follows (the result becomes an experiment that can't be Lead until its deviations are settled). It switches back off after each generation, so it is never left on by accident. Creators can use it; Admins can restrict it in the Governance tab (§16.4).

Keeping simple prompts small:

- **Scope follows the selection.** A selected section is the only thing that changes.
- **Reuse first.** The AI picks from the site's existing components; new ones must be proposed, not slipped in.
- **Impact preview.** Anything new (component, colour, deviation) is shown and confirmed before it's applied.
- **The critic sees the whole site,** not just the guide, so "legal but alien" is caught.

### 6.6 Deviations

Everything from "Think new" is marked on the canvas and listed with the validator's reason. Each deviation has three outcomes:

1. **Fix it:** the AI brings it back within the guide, keeping the idea.
2. **Keep as experiment:** stays on the artboard; the artboard can't be Lead.
3. **Propose to the guide:** the proposal goes to Brand and rules with the example. An Admin or a Creator can accept it → new guide version, allowed for everyone.

### 6.7 Motion and 3D

The sites should feel alive. Motion and 3D are part of the design from the start, not decoration added at the end.

- **Motion levels** (used by the Motion axis and the "Tone and feel" answer): Still · Subtle (hover, focus, reveal on scroll) · Expressive (choreographed transitions, animated illustrations, scroll-driven scenes) · Immersive (real-time 3D).
- **Tech within the no-framework rule:** CSS animations and transitions, view transitions, scroll-driven animations and the Web Animations API. For 3D, a WebGL library such as three.js, shipped as a file with the site and loaded with a script tag. 3D models as glTF/GLB in the asset library.
- **Motion tokens in the guide:** durations, easing curves and distances become part of `guide.json`, so motion is consistent across the site the way colours are.
- **Fallbacks by default:** every 3D scene has a poster image, and `prefers-reduced-motion` and low-power devices get the still version. This costs little and doesn't limit the design.
- **Performance must stay good:** page weight and the speed tests run in the check runner (§8.1). Pages with 3D or heavy animation get the 3D and heavy-animation profile instead of frame-rate tests, which a headless browser can't measure reliably.
- **Interactive 3D exposes DOM controls:** every action in a 3D scene also has a real button or link, so the interaction check can test it.
- **CSP:** decoders for Draco/KTX2 need `'wasm-unsafe-eval'` and `worker-src blob:`, which the site policy allows (§21.1). Library builds without `eval` are preferred (e.g. Lottie light).
- **Checklist:** the existing Motion item covers it (states, durations, easing, reduced motion), plus the poster fallback for 3D.
- **Change to Bjarke's rules:** his Design Agent requires static artboards with no script-drawn content. That has to change: artboards may run scripts, and the editor shows them live with a pause control.

---

### 6.8 Media library

Images live in the app, not on people's computers. They are stored in the same blob store as everything else, are versioned and included in backups.

- **Two levels:** the organisation's library, shared by all projects (brand images, product images, employees, customer logos; like Bjarke's `images/` folder), and each project's own library for images that belong to one site or article.
- **Upload in three places:** "Media" in the main menu, the media field of a section in the editor, and the brief's "Proof available" block (customer stories and quotes).
- **On upload:** optimised, metadata such as GPS removed, file type and size checked (§21.3).
- **Each image carries:** title and alt text (the AI suggests, a person confirms); category (free use, or restricted: customer logos, customer stories, employees, partners, awards, certifications, events); subject (which customer or employee it shows); rights (source, photographer or licence); and where it may be used (page and section types). Consent for photos of people comes later (§21.5).
- **Example, customer images for an article:** upload to "Customer stories › Coop" and mark as customer story with Coop as subject. On a "Customer story" page about Coop, the AI only suggests Coop's images (Bjarke's rule that the image must match the actual subject, enforced by the app). On other pages the AI doesn't see them at all.
- **Used in:** each image shows which pages, revisions and published sites use it.
- **Replace:** a new version of an image is picked up everywhere at the next export.
- **Block an image:** an image can be blocked; verification flags every page that uses it, and they need a new image before the next release. If it is urgent, an Admin can do a quick release without it.
- **Expiry:** the app warns before a licence runs out.
- **Deleting is archiving.** An image used in a released revision can't be removed for good until it is taken off those pages, so old revisions can always be restored.
- **Generate an image (next round, not in the first build):** a guided prompt builder under Media. Four steps (where it goes, what it shows with AI follow-up questions, feel with brand colours, what to leave out), a readable and editable prompt, four variants, one picked into the project library labelled AI-generated with the model and prompt saved. No text, logos or look-alikes of real people; generated people never stand in for employees, customers or partners. Needs its own model role and endpoint (image generation is not uniform across OpenAI-compatible providers); usage is counted per image. Brand colours can't be validated in pixels, so a person judges the match. Check provider terms and EU AI Act labelling with legal. Estimate: 1–2 weeks for one developer, more if the image model is self-hosted.

### 6.9 Adding material when prompting

Files added while prompting always land in the project's media library; the user never has to think about where they go.

- **In the mini-brief for a new page:** a drop zone for material. Documents (PDF, Word, slides, notes) are read and the AI fills the brief's blocks from them, with the document as the source of each field, so "don't invent" still holds. Their content is sent to the model as data, never as instructions. Images, video and 3D models go into the media library; the AI suggests alt text, category and subject, and the user confirms.
- **In the editor's prompt bar:** a paperclip button, or drag a file straight onto a section. The scope is then set to that section, e.g. "use this video as the hero background".
- **Video on upload:** converted to web formats in several sizes, with a poster image (shown before playback and with reduced motion). Length and file size are shown, so the cost in loading time is visible. A subtitle file (.vtt) can be added; recommended, not required (§7).
- **Short loops** (muted, under about 10 seconds) ship in the site package; the AI uses them when the Media axis is "visual-led".
- **Long videos** with sound and controls are heavy to ship. An Admin can approve one video platform as an exception (Livid, livid.com, is the intended one); it is then added to the allowed domains in the CSP and the validators (§21.1). Otherwise long videos are self-hosted in the package.
- **Video counts towards page weight;** verification warns when a page gets too heavy, without blocking (§8.1).

---

## 7. Accessibility (decision 18 Oct)

WCAG 2.1 AA should be met, but must not be overdone or stop designs from finding new directions or breaking web conventions.

- Contrast and other WCAG findings are **warnings** on the element while designing: they never block generating, experimenting or choosing a Lead.
- **At the check runner** (approval → staging) the accessibility scan blocks by default, like every check (§16.5). A finding is cleared by fixing it, or by accepting it with a reason, so a deliberate break never stops the work.
- A deliberate break is **accepted with a short reason**. The reason travels to verification and hand-off, so the build knows it was intentional (Bjarke's own rule: say deliberate failures out loud).
- Semantics stay good practice by default: real links and buttons, labelled fields, focus styles, heading order, alt text, 44 px touch targets, reduced-motion support.

---

## 8. Verification (the "validation agent")

Bjarke's instructions leave the validation agent undefined. It is the verification phase:

- All sections on the Lead approved (checklist).
- Guide validation green (fonts, colours, recipes).
- WCAG findings fixed or accepted with a reason.
- No open interaction questions.
- Logo check passed (logos recognisable, visible on their background, treatment documented).
- No restricted images outside allowed section types.

The hand-off package is an export of the approved Lead with States, fonts, colour tokens and image paths, locked as a version.

### 8.1 Performance testing

Bjarke's instructions cover layout, contrast, label and logo checks, but no performance budgets or speed tests. The app adds them:

- **Lab tests in the check runner on every approved revision,** against a private copy served by the app before it reaches staging:
  - **sitespeed.io** as the main tool: open source and self-hosted, so nothing leaves the building. It runs Lighthouse inside, records visual metrics and a filmstrip, and checks budgets.
  - Core Web Vitals in the lab (LCP, CLS, and Total Blocking Time as the lab stand-in for INP), page weight split by type (images, video, 3D, fonts, scripts).
- **3D and heavy-animation profile** instead of frame-rate tests (a GPU can't be throttled in browser automation, and headless WebGL renders in software). Used only for pages with a canvas/WebGL scene or 3D model, an animation library, scroll-linked animation or more than a set number of animated elements. It checks what can be measured reliably: model and texture size limits, Draco/KTX2 compression, a lazy-loaded scene, a poster fallback, that the largest element isn't the canvas, reduced-motion support, a device-pixel-ratio cap, and DOM controls for 3D actions.
- **Every page must score "good" in every speed test** (Core Web Vitals and the Lighthouse performance score; 3D pages also pass their profile). By default anything below "good" **blocks**; the Checks tab can lower it to a warning (§16.5). Budgets per page type (set in Brand and rules › Design setup) let a 3D campaign page weigh more than a customer story, as long as it still scores good. Thresholds can be adjusted later if needed.
- **Results in the app:** a Performance tab per release with scores, Core Web Vitals, weight breakdown, and a comparison with the previous release.
- **PageSpeed Insights** only for the public production site, once it has traffic, to get field data from real Chrome users. It can't test the internal staging site. Lab results are the gate; missing field data shows as "no field data yet", never as a failure. Optional later: `web-vitals` reporting to our own collector.
- **The check runner is a separate worker** (container or VM) on Node and Playwright, not inside the app: budget 2–3 GB disk for browsers and 2–4 GB RAM per concurrent check, run from a queue with concurrency 1–2.
- **Paid monitoring** (e.g. DebugBear or SpeedCurve) is optional later, for continuous monitoring of production. Not needed for the concept.
- **Load test** once before go-live (e.g. with k6) against the site servers. Static files behind a web server handle a lot, so this is a sanity check, not a routine.

---

## 9. Output and build

- **Plain HTML, CSS and JavaScript. No framework, no build step.** (Astro was considered and dropped: it overcomplicated the strategy.)
- **Built once, byte-identical:** each saved revision is built once into one package with one SHA-256 hash. Preview, staging and production serve that exact package, with no rebuilds and no injection. The hash is shown in review, staging and production and verified by the check runner at each step.
- **Shared header/footer:** partials assembled by the app on export (`{{header}}` placeholders). A header change is one new version that every page picks up.
- **Consistency:** one `tokens.css` (colours, type, spacing) linked by every page; it is the design artifact from the design phase.
- **Images:** optimised on upload, so the artifact is already final. The same step removes metadata such as GPS position (§21.3).
- **Modern CSS** (grid, container queries, custom properties, view transitions) covers radical design without a framework.
- **Libraries only where needed** (e.g. three.js for 3D), shipped with the site as files rather than loaded from a CDN, so production never depends on a third-party host.

### 9.1 Packaging for staging and production

- **Minify in the check runner's packaging step,** not while designing. The release log keeps readable files so diffs between releases stay easy to review; the package is minified.
- **Tools:** esbuild for JS and CSS (one small binary), plus an HTML minifier in the same step.
- **Checks run on the minified package,** so staging tests exactly the bytes production gets ("build once").
- **Compression matters more than minifying:** zstd/gzip turned on in Caddy on both servers.
- **The big wins, especially with 3D and motion:** 3D models compressed (Draco or meshopt for GLB), PT fonts subset to the characters used, images optimised at upload, hashed file names so browsers can cache files for a long time.

---

## 10. New pages: placement, addresses and navigation

### 10.1 The new-page flow

1. **Page type**, each with its own defaults:

| Type | Creative freedom | Default placement | Expires | Restricted images |
|---|---|---|---|---|
| Core page | Follow the site | In the site, in the menu | No | Not used |
| Landing page | Explore | In the site, hidden | Optional | Not used |
| Campaign | Explore | In the site, hidden | Required | Events |
| Customer story | Follow the site | In the site, under Customers | No | Customer stories |

2. **Where it lives** (placement, §10.3). The default comes from the page type; the Creator can change it.
3. **Mini-brief:** inherits Audience, Core message and Tone from the site brief; asks only what's new (goal, what the visitor should do, expiry date for campaigns). Has a drop zone for material: documents, images, video, 3D models (§6.9).

The site's approved design is always the starting point. A campaign that ran "Think new" and worked can propose its deviations to the guide and lift the whole site.

### 10.2 The Structure workspace

How visitors move through the site is designed on purpose, not left to emerge. The Structure workspace is a first step of the design phase, and a panel that stays available afterwards. **Creators and Admins both use it.**

**The site tree**

- One tree per project, holding every page and every address. Each node shows its page type, placement (in the menu, hidden, own address), status (planned, in design, live) and URL.
- **Separate addresses are roots of their own.** The main site is one root; `go.example.com` or a campaign domain is another, with its own children (e.g. `go.example.com/faq`). Subdomains and separate domains are part of the structure, not exceptions.
- **Hidden pages** sit wherever they belong in the tree, marked with an icon and with "Copy link".

**Inheritance: what a child takes from its parent** (shown on each page)

| What | A child inherits | Can it differ? |
|---|---|---|
| Address | Parent's path + its own slug (`/products/go`) | Yes, with an override slug. Moving a parent moves its children, with redirects. |
| Visibility | A hidden parent makes its children hidden | A visible parent can have hidden children (link-only sublinks) |
| Menu | Appears as a submenu under its parent, if the navigation pattern has depth | If not, it appears as section navigation on the parent page and in breadcrumbs |
| Design | Page type defaults, and the site's header and footer | Roots on their own address get a standalone header variant |
| Breadcrumbs | Generated from the tree | — |

**The navigation model and menus**

- **The navigation pattern** is chosen here: top bar, mega menu, sidebar, full-screen overlay, one-page scroll story, or something new with "Think new". Navigation is a variation axis (§6.4), so the AI can show alternatives.
- **The chosen pattern is designed in the editor** as real sections (header, footer, mobile menu), with Bjarke's checklist, and locked like any approved section. This is where navigation conventions are broken, deliberately and with approval.
- **Menus** (main, footer, utility, mobile, and each extra address's own main menu) are filled by dragging pages from the tree onto any menu, or by picking a menu for the selected page, and giving them labels. The pattern decides how deep and long each menu may be; the footer and utility menus have their own limits from their designed sections. With more than one site language, every menu item has a label per language.
- The navigation works on the preview address, so it can be clicked through before anything is live.

**The AI's part**

- Drafts the first tree and menus from the brief (§4.10).
- **Proposes where each new page goes,** shown as before and after menus with a one-line reason from the brief.
- **Keeps menus within the pattern;** if a menu would outgrow it, proposes a reorganisation (e.g. grouping). A menu that needs a new pattern goes back to the editor as a change to the header.
- **"Reorganise"** asks for a whole-site proposal at any time.

**Who decides**

- **Creators edit the structure freely,** like design work. Structure changes are part of the revision: tested on staging, and shown on the Admin's review page as their own panel when publication is requested (§13.3).
- **Admins** have the same workspace, can edit before approving, and approve together with the publication.
- **Stricter installs** can switch on "Admin approves structure changes before staging" (Governance, §16.3; on in the Locked down preset).

**Checks** (check runner, §13.5): every menu item points to a published page, hidden pages stay out of menus, no visible page is unreachable, menus fit the pattern, redirects exist for moved pages.

### 10.3 Placement: where a page lives

When a page is created, the placement step shows three cards, each with a small picture and one line about what it means. The default comes from the page type.

| Placement | What it means | Address | Who decides |
|---|---|---|---|
| **In the site, in the menu** | Part of the site's structure. The AI suggests where it goes. | A path, e.g. `example.com/products/go` | The Creator, in the Structure workspace; reviewed with the publication |
| **In the site, hidden** | Not in the menu, the `sitemap.xml` or search engines. Reachable only by its link, e.g. from a newsletter. | A path, e.g. `example.com/go-launch` | The Creator |
| **Own subdomain or domain** | A new root in the tree, with a standalone header that links back to the main site, and its own children if needed. | e.g. `go.example.com` | An Admin approves the address (§10.4) |

- **"Hidden" is a toggle** on every in-site page ("Show in menu / Hidden, link only"). A hidden page gets `noindex` by default; a second toggle can allow search engines. "Copy link" gives the address for a newsletter.
- **Placement can change until the page is published.** After that, a change is a new revision, and moving the page offers a redirect from the old address.
- **While working, every page lives on the preview address,** whatever its placement. A chip in the editor always says where the page will live and that it isn't live yet, e.g. "Will live at go.example.com · Preview only".

### 10.4 Address requests (subdomains and domains)

- Only when the Creator chooses **Own subdomain or domain.** They suggest a name (e.g. `go`), and the app checks that it's free.
- The request goes to the Admins' inbox as an **address request**, with the page, the name and the Creator's note. It can be sent early, to reserve the name, or together with the publication request.
- **An Admin approves** (with a passkey, since addresses are a production change, §13.7), suggests another name, or turns it down with a comment.
- The approved address is reserved in the Deployment tab and goes live with the first release. Subdomains are covered by the wildcard certificate, issued before go-live; a new domain shows "Waiting for DNS" until its record is in place, and its certificate is public in CT logs once issued (§13.11).

### 10.5 Explaining it to the user

- **The Structure workspace** shows the tree on the left, the menus on the right, and the selected page's inheritance (address, visibility, menu, design) below, so cause and effect are visible.
- **Placement cards** with a picture each: a menu with the page in it, a page with a link icon and no menu, a separate small site with its own address.
- **One chip in the editor** that always answers "where will this live, and is it live yet?"
- **Proposals look like changes:** menus before and after, an address request as a card with the suggested address.
- **One inbox for Admins,** grouped: publication requests, address requests, structure changes (if the stricter rule is on).

---

## 11. Versioning and naming

### 11.1 Two levels

- **Drafts:** each person edits in a private draft (the sandboxes table), autosaved and visible only to its owner. There are no locks. The Design editor and Revisions show who else has a draft open on the same design.
- **Versions:** saved automatically on every change inside a draft.
- **Revisions:** a draft becomes a numbered revision only when it is saved. Revisions are snapshots of the whole project; what people resume from.

### 11.2 Names (stable IDs)

- **Project ID:** slug of the name the user types: lower-case letters and digits, no hyphens ("QualiWare GO" → `qualiwarego`). Locked at creation; the title can change, the ID can't. On collision the app suggests another slug (`qualiwarego2`) before creating.
- **Revision:** `<project>-r<n>`, e.g. `qualiwarego-r4`. Allocated by the app, never reused.
- **Artboard:** `<project>-<letter>`, never reused or shifted. The same artboard keeps its name in every revision.
- **Sections:** a stable internal ID; the visible `s1, s2…` is computed from position. Comments and decisions point at the internal ID, so old references always resolve to the current name. No rename record needed.

### 11.3 Files

```
<DATA_DIR>/qualiwarego/
  project.json
  revisions/qualiwarego-r1.json …
  blobs/sha256/9f/2c…
```

`project.json` (index, rebuildable from `revisions/`):

```json
{
  "id": "qualiwarego",
  "name": "QualiWare GO",
  "home": "qw-office",
  "next": { "revision": 5, "artboard": "e" },
  "approved": "qualiwarego-r3",
  "revisions": [
    { "id": "qualiwarego-r1", "parent": null, "by": "bjarke", "msg": "Brief completed" },
    { "id": "qualiwarego-r2", "parent": "qualiwarego-r1", "by": "rune", "msg": "Design directions" },
    { "id": "qualiwarego-r3", "parent": "qualiwarego-r2", "by": "bjarke", "msg": "Lead chosen: qualiwarego-c" },
    { "id": "qualiwarego-r4", "parent": "qualiwarego-r2", "by": "rune", "msg": "Continued from r2" }
  ]
}
```

A revision file lists which file hashes made up the project at that point:

```json
{
  "id": "qualiwarego-r3",
  "parent": "qualiwarego-r2",
  "by": "bjarke",
  "at": "2026-10-17T14:03:00Z",
  "phase": "design",
  "files": {
    "brief.json": "sha256:9f2c…",
    "guide.json": "sha256:41ab…",
    "artboards/qualiwarego-c.html": "sha256:c07e…"
  }
}
```

- Content lives in `blobs/`, named by hash. A revision only points to files; unchanged files are shared and stored once.
- Revision files are the truth; `project.json` is only an index.
- Writes are atomic: write to a temp file, then rename. `project.json` is updated last.

### 11.4 When revisions are made

- Manually ("Save revision" with a short message).
- Automatically when a phase is completed.
- Automatically just before going back to earlier work.

### 11.5 Going back

- **Open read-only:** browse an old revision.
- **Continue from here:** creates a new revision with the old one as parent; newer revisions stay. The timeline becomes a tree.
- **Bring from:** pull one artboard or section from another revision into your draft. This is the merge tool; there is no "Replace".
- **Promoting to staging** requires being based on the current staging revision.
- **Archive:** revisions are never deleted, only hidden.

### 11.6 Sharing between instances

Revisions and blobs never change, so syncing is copying missing files. Each project has one **home instance** that alone allocates numbers and moves `approved`. Other instances import a project as a fork with a new slug if they want to work independently.

---

## 12. Storage and backups

### 12.1 Storage

- One data root on the server, set with `DATA_DIR`. Each project in `<DATA_DIR>/<slug>/`.
- Users see projects, never folders. No folder picker and no per-project storage location (it's hosted anyway).
- **Download project** as a zip (showcase). **Import project** later: as itself if the slug is free, otherwise as a fork. The zip is for moving and sharing, not a backup.

### 12.2 Project backups (admin settings)

- **Target:** a folder on the server or a network share, or cloud storage (Azure Blob or anything S3-compatible). Credentials are entered once in the admin panel and stored on the server, never in the browser.
- **Content:** each project's folder (`project.json`, `revisions/`, `blobs/`), i.e. the whole project with its full history. Never tokens or keys.
- **Schedule:** daily, weekly or after every saved revision, plus "Back up now".
- **Scope:** all projects or selected ones.
- **Retention:** keep the last N backups or the last N days.
- **Encryption:** on by default for cloud targets. The key is kept outside the app, e.g. in a password manager.
- **Status per project:** last backup, size and result. Failed backups notify Admins.
- **Restore:** as a new copy with a new slug by default, so it can be checked first. Replacing the original is Admin-only with a typed confirmation.
- **Cheap by design:** revisions and blobs never change, so after the first full copy each run only uploads new files.
- **Engine:** the app drives rclone (local folders, network shares, Azure Blob, S3, OneDrive, built-in encryption) instead of a client per storage type.
- **App database:** SQLite (users, roles, usage, approvals, comments) is backed up in the same job with SQLite's own backup command, never by copying the live file.

### 12.3 Infrastructure baseline

- **Release log and release packages:** inside `DATA_DIR`, so they are covered by the backups above. Packages are kept forever, so rollback always works. Optionally mirrored to an external git (e.g. a local Forgejo).
- **Servers** (the app, and the production host if separate): nightly whole-machine snapshots, for fast restores (e.g. Proxmox Backup Server in TAPPaaS).
- **3-2-1:** three copies, two kinds of storage, one off-site copy that the servers can't delete (immutable storage). Two server rooms in the same building count as one site.
- **Not backed up:** the staging and production servers (rebuilt from a release package plus config in git) and tokens (reissued after a restore).
- **Restore order:** app data (with the release log) → app → production agent, if production runs on a separate host. A restore drill into the staging environment every quarter, and once before real use.

---

## 13. Releases and deployment (one install)

Everything ships as **one package**. Someone who installs it gets the whole workflow, previews, a staging site and a production site, all controlled from the app. The AI drafts; production is locked behind Admin controls.

### 13.1 What the package contains

- **The app:** the workflow, AI, media, Brand and rules, and the admin panel with the Deployment tab (§13.6) and mail settings (§13.7).
- **A built-in release log:** a git repository inside `DATA_DIR`. Every release is a commit with `release.json` and trailers, so releases, compare and rollback work as git ("maintenance as an extension of git").
- **A built-in check runner:** runs the pipeline checks (§13.5) on a clean copy of each approved revision, so a fault in the editor can't slip through.
- **A web server** for previews, staging and (optionally) production, with automatic HTTPS. Previews are served on their own address, separate from the app's, so generated code can't reach the app's session (§21.1).
- **A headless browser** for the check runner (Playwright, sitespeed.io, axe). The app itself is light; this is the one heavy part: a browser download of a few hundred MB, and roughly 1–2 GB of memory while checks run. All browser checks share one browser and only run on approved revisions, not on every save.
- **Which checks run is chosen in the Checks tab** (§16.5).
- **A small production agent** for running production on a separate host (§13.4).
- **External git is optional.** The release log can be mirrored to e.g. a local Forgejo for history, but nothing depends on it.

```json
{
  "project": "qualiwarego",
  "revision": "qualiwarego-r7",
  "revisionHash": "sha256:5be1…",
  "approvedBy": "bjarke",
  "checks": "passed",
  "adminSignature": "…"
}
```

Commit trailers: `Revision: qualiwarego-r7`, `Approved-by: bjarke`.

### 13.2 Environments

- **Previews:** every revision has its own preview URL (§13.2a).
- **Staging lives inside the app.** The app serves the newest approved revision itself, on the **preview address** (never on the app's own address, because staging runs generated code; §13.11). There is no staging server and nothing is deployed for staging. Approval for staging: a Creator (or an Admin, §16.4), after every section checklist is done and the hard checks pass.
- **Production targets publish to any URL.** A site can be published to any domain or subdomain, and moved to another URL later, without affecting anyone's passkey (§13.8). Every target is locked behind Admin controls (§13.3).
- **Extra targets if you want more stages.** An Admin can add more named targets, e.g. "Pre-production" next to "Production". Each behaves exactly like production (passkey, signature checks, smoke test). Organisations that want a further test step can publish there first and move on afterwards.

### 13.2a Previews and review mode

**The preview itself**

- Every revision gets a preview URL on a **separate preview address that is a different site from the app** (e.g. the app on `studio.internal`, previews on `preview.internal`), never a subdomain of the app's (§13.11). The URL matches the revision and artboard IDs.
- It shows exactly the files that would ship and never changes; a new revision gets a new URL. Internal only; the app adds a short-lived access token when it loads one.

**Review mode: Bjarke's section checklist**

Review mode is where the section checkmarks are done. A review shell on the preview origin (`preview.internal/__review/`) loads the package in a same-origin iframe and draws the section overlays from the `data-section` markers, outside the site's files. Clicks go to the app by postMessage and are treated as untrusted. Accepted risk: generated code shares an origin with the shell and could fake overlays, so the approval itself happens in the app, which shows the section list and package hash from its own data. The review panel:

- **Every section of the Lead** is listed with its seven checkmarks: Copy, Media, Interactions, Mobile, Motion, Translated, Tested. The person ticks them off by hand while looking at the preview; the AI may suggest that an item looks ready, but only a person switches it on.
- **Status follows the checkmarks:** "In development · n/7" or "Approved", never set by hand. Switching one off again returns the section to In development.
- **Interactions** can only be ticked when the interaction check has no open questions; **Mobile** only when a mobile version exists; **Tested** is done right here, by clicking through the section in the preview on desktop and mobile.
- **Approved sections are locked.** Changing one later means unlocking it on purpose, which switches the affected checkmarks off again.
- Clicking a section in the preview selects it in the panel; **"Revise"** opens that section in the design editor with the scope already set.
- **The page is ready when every section of its Lead is approved.** Then **"Approve revision"** becomes available and sends it to the check runner and on to staging (§13.3).

**Why the functions aren't inside the preview:** the preview runs code the AI wrote. Keeping it on a different site from the app means that code can never press the approve buttons or reach the app's session. Previews get `connect-src 'self'` and are never given cookies; the app still checks the Origin header and a CSRF token on every request that changes something.

**Sharing:** "Share preview" makes a read-only link to the preview alone, without the review panel, valid for a limited time (e.g. 7 days) and only on the internal network.

### 13.3 From approval to production

1. **A Creator approves a revision** they're happy with (or an Admin, if Creators may not approve for staging, §16.4). Approval needs every section checklist on the Leads done.
2. **The check runner** checks and packages it (§13.5). If the hard checks pass, **it goes to staging.**
3. **The team tests on staging.** Issues go back to the design editor; the next approved revision replaces the one on staging. This loop can run as many times as needed, with no Admin involved.
4. **The Creator requests publication** when staging is right, with a short note ("ready for launch", what changed). Requesting is a separate, deliberate step, so Admins aren't emailed for every staging round.
5. **Admins are notified** in the app's inbox, and by email if mail is set up, with a link to the review page for that revision (§13.7).
6. **The review page** shows: the revision ID and who requested it, the Creator's note, a link to staging, what changed compared with production (visual comparison per section), the check results, and any warnings waiting for acknowledgement.
7. **The Admin approves with their passkey** (Windows Hello, Touch ID, a phone or a security key), or **sends it back** with a comment, which goes to the Creator by email.
8. **Production** checks the Admin's signature and the package hash before it switches, then runs the smoke test (§13.5). The result is emailed to the Creator and the Admins.

Rules around it:

- **The email link grants nothing by itself.** It only opens the review page; the Admin must be signed in, and only the passkey approves. The link expires, and is tied to that exact revision and package hash.
- **A newer request replaces an older one.** If the Creator requests publication of a newer revision, the older request is closed, so nobody approves something that's out of date.
- **No typed revision ID.** The review page shows the ID and what changes; the passkey is the confirmation.
- The passkey signs the release's hash, and the signature is stored with the release in the release log. A release without a valid Admin signature is refused. The app, the AI and Creator accounts can't make that signature without an Admin's device.
- **One or two Admins per approval (a setting, §13.9).** With "one Admin", any Admin can approve a release alone. With "two Admins", a release needs a passkey signature from two different Admins: the review page shows the first approval and waits for the second, and both are notified. Production checks the number of signatures itself.
- At least two Admins with registered passkeys is recommended either way, so a release never waits on one person being away.
- **Release numbers and rollback.** Production verifies the origin, the user-verification flag and the passkey signature over the release hash plus a release number. The number must be higher than any accepted before, so an old bundle can't be replayed; it decides which bundles are accepted, not which one is active. A rollback is a new signed release with a higher number pointing to an older content hash, approved with an Admin's passkey. Production keeps the last N releases on disk, so it switches instantly. The signature counter is ignored when it is 0 (synced passkeys).
- **Automatic switch back:** if the smoke test fails right after a deploy, production returns to the previous release on its own, without a new signature, and reports it in its outbox. That release was already signed by an Admin, so this adds no new trust, and nobody has to rush to click anything.
- **Urgent fixes** go the same way: new revision → staging → request → approval, just done quickly. Nobody edits files on a server by hand.

### 13.4 Where production runs (a setting in the Deployment tab)

- **Separate host (chosen for the concept):** production ships to its own server. The package includes a small **production agent** (web server plus agent) that runs there. Production never connects to the app; the app connects to production over SFTP with its own key, into two chrooted folders:
  - **Inbox** (the app writes, production reads): signed release bundles, certificates and signed command files (freeze, unfreeze, activate). Each command has a sequence number and an expiry, so it can't be replayed. Freeze needs only the app's signature, because it is the safe direction and must work fast; unfreeze needs an Admin passkey.
  - **Outbox** (production writes, the app reads): heartbeat with timestamp, disk use, active release, smoke-test results, logs and certificate requests. Agent health comes from how fresh the heartbeat is; a stale one shows as "Unreachable". The app sends the smoke-test emails after reading the results.
  - Production verifies the signature and release hash, unpacks into a new release directory and switches over atomically with a symlink. Its egress rule is unchanged, and the app itself never faces the internet.
  - **In our setup** the production server is a separate VM (TAPPaaS). A stronger container runtime such as gVisor is worth trying there (noted for TAPPaaS).
  - **Anyone else** hosts it themselves, on a VPS or their own machine. Installing it is one command, shown in the Deployment tab.
  - Inside its server, the agent runs locked down: read-only filesystem, an unprivileged user without extra Linux capabilities, no shell, only the released files mounted, and outgoing traffic only to the certificate authority.
- **Built-in (an option for other installs):** the same install serves production, with the internet-facing part in its own sandboxed container on the same machine. Simpler, but a known risk (§21.6); not used in our concept.
- **Pairing:** the app shows its SSH public key and signing public key, and the Admin installs both on production. The app pins production's host key. Fingerprints are compared by hand (trust on first use), and the Admin confirms the pairing with a passkey.
- **The agent trusts Admin keys in a chain.** The first Admin keys arrive in the inbox at pairing. After that, a new Admin key is only accepted if it is signed by one existing Admin, or two with the two-person rule (§13.9), so a compromised app can't slip in a key of its own.
- One production server can serve any number of domains, subdomains and paths, and a site can be moved to a new URL at any time from the Deployment tab.

### 13.5 How we check the AI's work

The pipelines are framed around one idea: **we validate specific aspects of what the AI produces, with security first.** The "How we check the AI's work" diagram shows it as a matrix. Each row is an aspect (code safety, secrets and integrity, brand rules, approved work, facts, accessibility, speed and motion, the live site) with what could go wrong. Each column is a checkpoint: in the app, the check runner, staging, the Admin gate, production, scheduled. Every aspect is covered at least twice, by different means.

Principle: each check runs at the cheapest point where it catches the problem. The one deliberate repeat is that the check runner reruns the hard gates on a clean copy, so a fault in the editor can't reach staging. **Hard gates** block; **advisory** checks warn and need an Admin's acknowledgement before production.

**1. In the app, while working (instant feedback)**
- Guide validators (fonts, colours, recipes), code validators, contrast warnings, interaction check, section checklist, upload checks.

**2. Check runner on every approved revision (before staging)**
- Hard gates:
  - HTML validation.
  - Code validators and guide validators, rerun on a clean copy.
  - All internal links and referenced files exist.
  - CSP compatibility: nothing the site's CSP would block.
  - Secret scan: no tokens or keys in the package (e.g. gitleaks).
  - Shipped libraries (three.js and others) match their pinned versions and checksums.
  - SVG files clean (no scripts, embedded images or external references).
- Advisory:
  - AI code review (§21.1).
  - Accessibility scan (axe-core).
  - Speed: sitespeed.io with Lighthouse against the page-type budgets (§8.1).
  - 3D and heavy-animation profile, only for pages that need it (§8.1).
  - No CSP violations in the browser console on any page (catches `eval` in libraries automatically).
  - **Visual comparison with the previous release:** screenshots at three breakpoints, diffed per section. It catches changes to approved sections that nobody meant to make. Before each capture: reduced motion emulated, animations and transitions disabled, videos paused at frame 0, a fixed seed for random and 3D content, canvases masked.
  - Navigation checks: menu items point to published pages, hidden pages stay out of menus, no unreachable visible pages, menus fit the navigation pattern (§10.2).
  - SEO basics: titles and descriptions. (No hreflang; see §26, decision 9.)
- Build: minify, hash file names, generate `sitemap.xml` and `robots.txt`, package with a sha256.
- To stay fast on large sites, speed and visual tests run on changed pages plus one page per page type, not on every page every time.

**3. Staging (automatic, then a smoke test)**
- Staging only takes a package whose hash matches the checked one.
- Every page answers, the security headers are present, there are no console errors, and the pages make **no requests to outside domains** (except an approved video platform). This tests the server set-up, not just the files.

**4. Before production (the gate in the Deployment tab)**
- All hard gates green.
- Advisory warnings and AI review flags acknowledged by an Admin, with a reason.
- First release only: the go-live checklist of security controls (§21).
- The Creator has requested publication, and an Admin approves on the review page with a passkey (§13.3).

**5. After the production deploy**
- Production checks the Admin signature and the hash before switching.
- The same smoke test against production. If it fails right after a deploy, production switches back to the previous signed release by itself, and Admins get an email (§13.7). Any other rollback needs an Admin's passkey.

**6. Scheduled**
- Weekly: link check including external links (e.g. lychee), PageSpeed Insights field data for production (§8.1).
- Daily: certificate and token expiry, licence expiry in the media library, campaign pages past their expiry date.
- Monthly or quarterly: restore test of a backup (§12.3).

**Self-healing: failure analysis**

When a run fails in the check runner, on staging or right after a production deploy, the failure goes to analyst review. The analyst is a model role of its own, pointed at a larger model. It reads the failure as quoted data (logs, check output, the diff since the last passing revision, `guide.json`, the section's job), with secrets and personal data redacted first. It sorts each issue by cause, severity and confidence, shows the evidence for every claim, and answers in a fixed schema: a diagnosis and a proposed patch. It recommends one of three outcomes: **let through** (advisory findings only, accepted by an Admin with a reason and passkey), **fix and rerun** (the fix becomes a new revision that goes through review mode and the check runner like any other) or **hold for a person**. It never recommends letting a security-floor failure through, never applies, approves or releases anything, never makes a check pass by loosening the check (CSP, budgets, tests), and never changes an approved section quietly. Cost is capped per analysis; after two failed fixes a person takes over. A flaky test may get one rerun of the same package with no changes. Results land in "Waiting for you" as "Failed runs · analysis ready". The setting in the Checks tab is Off, Analyse only, or Analyse and propose a fix (default).

**The app's own pipeline (separate repo, for developers)**
- Lint, type check, unit tests.
- **Permission tests:** e.g. a Creator can't publish, production refuses a release without an Admin signature, the AI has no release tools. The security controls that can be automated (§21) become tests that run on every change, not just once before go-live.
- Dependency audit and secret scan.
- One signed package per version; installs get it first on a test install, then in real use ("build once, promote").

**Deliberately left out**
- Load tests: once before go-live (§8.1).
- PageSpeed Insights on staging: it can't reach it.
- Paid monitoring: optional later.

### 13.6 The Deployment tab (admin panel)

One place for everything about deployment:

- **Targets:** Production, plus any extra named targets (§13.2). Adding a target is a short wizard:
  1. Name the target and choose its server type (separate host, or built-in for other installs).
  2. Install the agent on the server (a TAPPaaS VM, a VPS or your own machine) and give it the app's SSH public key and signing public key.
  3. The app connects over SFTP, finds the inbox and outbox, reads the first heartbeat and shows production's host key; the Admin compares it with the server's screen and the app pins it.
  4. An Admin confirms the pairing with their passkey; the trusted Admin keys go to the inbox as a signed file.
- **Server settings per target,** all from the tab: compression and caching, redirects (old URL → new), the 404 page, the maintenance page shown while frozen, and optional access limits for test targets (IP list or a password, e.g. for "Pre-production").
- **Agent health:** read from production's outbox: heartbeat age (stale = "Unreachable"), version, disk use, active release, last smoke test, recent log lines.
- **Agent updates:** a new agent version is offered in the tab and installed after an Admin confirms with a passkey; the agent only accepts signed updates.
- **Sites and hostnames:** any domain, subdomain or path per target, changeable at any time; the main domain, subdomains and paths. Subdomains are covered by a wildcard certificate issued before go-live.
- **Environments:** which revision runs where, preview links, smoke test results, and the status of a separate production host.
- **Releases:** publish, history, compare, rollback.
- **Certificates:** issued before go-live, never on first visit. Production generates the private key and writes a certificate signing request to its outbox; the app completes ACME with a DNS-01 check and drops the finished (public) certificate in the inbox, outside any release. Production checks the app's signature and that the certificate matches its key and domain, installs it and reloads. Renewal around day 60 of 90 is automatic and needs no passkey. The private key never leaves production, so it never appears in the release log, backups or secret scans. Fallback if CSR issuance isn't possible: the app generates the key, encrypts it to production's public key and sends it on the certificate channel. One wildcard per environment; separate campaign domains are public in CT logs, and users are told so.
- **Security headers:** allowed domains in the CSP per site (e.g. an approved video platform). Changes need an Admin's passkey.
- **Keys:** the registered Admin passkeys. Adding or removing one needs another Admin's approval.
- **Kill switch:** freeze production, end all sessions, read-only mode. **Freezing needs only the app's signature** (a signed command in the inbox), because it is the safe direction and must work fast in an emergency; **unfreezing needs an Admin's passkey.** Ending sessions and read-only mode need a passkey. Every use notifies all Admins and is logged. Urgent breakage after a deploy doesn't depend on it, because production switches back by itself (§13.3).
- **Checks:** the go-live checklist, and warnings waiting for an Admin's acknowledgement.

### 13.7 Notifications and mail settings (admin panel)

- **Email is optional.** Without a mail server, everything works through an **in-app inbox**: publication requests with a link to the review page, "sent back" comments, failed smoke tests and backups, and security events. Admins see a badge when they sign in and can turn on browser notifications.
- When mail settings are filled in, the same notifications also go out by email, under the rules below.


- **What is sent:** invitations (new users, the one-time link for an Admin to register a passkey), publication requests to Admins with a link to the review page, approvals and "sent back" comments to the Creator, production releases (published, smoke test failed), warnings waiting for acknowledgement, failed backups, changes to Brand and rules, certificate, licence and token expiry, and use of the kill switch.
- **Recipients per type of notification:** individual addresses or a shared mailbox.
- **Mail server:** SMTP host, port, encryption (STARTTLS or TLS), user name and password, sender address and name, and a "Send test email" button.
- **Microsoft 365 / Exchange Online:** sign in with OAuth instead of a password. Basic authentication for SMTP is being switched off by default in Exchange Online, so OAuth is the safe choice there.
- **Credentials** are stored encrypted on the server and never shown again after saving.
- **Email security:**
  - **No email link performs an action.** Links only open a page in the app. Approving, sending back, rolling back, freezing and every other action happens on that page, after signing in. There are no "approve" or "roll back" buttons in emails.
  - **Every action that changes production needs a passkey:** approving a release, rollback, freezing and unfreezing, changing hostnames or allowed domains, adding or removing Admin keys, and changing the mail settings or recipients.
  - **Links carry no secrets.** They contain a page and a revision, not a token that signs anyone in. A forwarded email gives nobody access. There are no "magic link" logins.
  - **Phishing-resistant by design.** A passkey only works on the app's own domain, so a fake page in a phishing email can't get a valid signature. All links point to the app's configured address.
  - **No user-written HTML in emails.** The Creator's note is sent as plain text, with links in it not clickable, so a note can't be used to slip in a convincing fake link.
  - **Mail settings are protected.** Only Admins can change them, with a passkey, and every Admin is notified at their current and previous address. Otherwise someone could redirect publication requests or invitations.
  - **Sender authentication:** the sending domain has SPF, DKIM and DMARC set up, so others can't send convincing mail in the app's name. Use a dedicated sending mailbox with send-only rights.
  - **Invitations are single-use,** expire after a short time, and are tied to the invited address. A new Admin key also needs an existing Admin's approval (§13.4), so an intercepted invitation can't create an Admin.
  - **Security events go to every Admin:** a new Admin key, changed mail settings, a rollback, use of the kill switch.
  - **Every email sent and every link opened** is in the audit log.
- **Passkeys are never sent by email.** Email only carries the one-time registration link; the passkey is created on the Admin's own device. If an Admin loses their device, another Admin approves registering a new passkey; email alone can't do it.

### 13.8 Accounts and sign-in

**Concept scope**

- **`APP_URL`: the app's own address.** Passkeys are bound to the URL people open the app at, set once as `APP_URL` in the env file (e.g. `https://studio.internal`). It has **nothing to do with where sites are published**: designs can be published to, and moved between, any URLs without touching anyone's passkey. The server behind `APP_URL` can also move freely.
- **Changing `APP_URL` later is a guided move,** not a reset: while the old address still works, each Admin registers a passkey on the new address, signed off with their old one, and production is told the new address by a release signed with the old keys. Then the old address is switched off.
- The app must run on HTTPS with a certificate the browsers trust, also on an internal network.
- **Bind passkeys to the app's own hostname, never to the company's main domain.** If they were bound to `example.com`, a generated page on `go.example.com` could ask an Admin's passkey to sign something. Using `studio.internal` keeps the published sites out of it.
- **Admins sign in with a passkey only,** with no password, so there is nothing to phish or leak. The passkey must be unlocked with a fingerprint, face or PIN ("user verification"), which makes it two factors on its own.
- **Production actions ask for the same passkey again** for that specific action: approving a release, rollback, freezing and unfreezing, keys, hostnames, mail settings. A stolen session can browse, but it can't change production.
- **Nobody receives a passkey.** Each Admin creates their own on their device or in their password manager (1Password, Bitwarden, iCloud Keychain, Google Password Manager). The app only gets the public part.
- **First Admin:** the install prints a one-time setup code. The person who installed it uses it to create the first Admin and passkey. It works once and expires.
- **Other Admins:** an existing Admin creates an invitation in the admin panel, shown once, single-use and expiring (e.g. after 24 hours), sent by any channel. The new Admin creates their passkey; **an existing Admin then approves the key** (or two Admins, with the two-person rule, §13.9) with their own passkey before it can be used for production actions. Approved keys join the chain the production agent trusts (§13.4).
- **Recovery codes,** shown once when a passkey is registered, kept in the password manager. A recovery code only signs the Admin in to register a new passkey, with another Admin's approval. It can never approve anything.
- **Extra devices:** an Admin can add a second passkey (e.g. a phone as backup), approved like the first. Synced passkeys in a password manager follow the Admin to their other devices.
- **Machine tokens** (the production agent's read-only token, later integrations) are generated in the Deployment tab and shown once.
- **Creators** use the test accounts (§14).

**Production scope (not in the first concept)**

- **MFA for Creators** with Microsoft Authenticator, or any other authenticator app: scan a QR code once, then enter the six-digit code when signing in.
- **Authenticator code for Admins at the sensitive moments without a passkey:** signing in with a recovery code, and registering a new passkey.
- **Admin settings:** require MFA for all users or Admins only; only an Admin can reset someone's MFA, with their passkey, logged in the audit log.
- **SSO through Entra ID:** Entra then handles MFA with Microsoft Authenticator (push and number matching) under your own Conditional Access rules. Production actions still need the Admin's passkey; Entra decides who can sign in, the passkey signature is what production checks for itself.

### 13.9 The two-person rule (optional)

Whether one Admin can act alone, or two Admins must agree, is set in the **Governance tab** of the admin panel (§16). It can be set separately for:

| Action | One Admin | Two Admins |
|---|---|---|
| Publish a release to production | Any Admin approves alone | Two different Admins each approve with their passkey |
| Add a new Admin key (new Admin, extra device, lost device) | One existing Admin approves | Two existing Admins approve |
| Change allowed domains, hostnames, mail settings | One Admin | Two Admins |

- **Rollback and freezing always need only one Admin,** so a problem can be handled quickly.
- **Production enforces the rule itself.** The setting is signed into the key chain (§13.4), so production knows how many signatures to require. The app can't quietly lower it.
- **Lowering the rule needs the current rule.** Going from two Admins to one needs two Admins' approval; going from one to two needs one.
- **Default: one Admin for every action, also when there are two or more Admins.** Having two Admins is then about cover, not control: if one is on holiday or sick leave, the other can approve and publish alone.
- **Two Admins is opt-in,** for organisations that want four eyes on every release. It can also be switched on for new Admin keys only, which adds protection without slowing down everyday releases. With two Admins required, work waits when one of them is away.
- **Watch out with one Admin:** a recovery code then gives one person full access to production again, so recovery codes must be kept as carefully as the passkey itself.

### 13.10 Env files and what stays outside the app

- **One `.env` in the app root:** `APP_URL` (the app's own address, §13.8), `DATA_DIR`, the model provider key, and an `APP_SECRET` used to encrypt settings stored in the app (mail and backup credentials).
- **The production server** has its own small env file, written by the pairing (§13.6): the read-only token for fetching releases and the trusted Admin keys.
- **Set up once, outside the app:** see the after-install checklist in §22.

### 13.11 Domains and addresses

**One rule:** code the AI wrote never runs on the app's own address. Everything else follows from that, and it gives three addresses:

| Address | Example | What's there | Who can reach it |
|---|---|---|---|
| **The app** (`APP_URL`) | `studio.internal` | The app itself: briefs, design, admin. Passkeys are bound here. | Internal network / VPN |
| **The preview address** | `preview.internal` | Everything not live yet: previews (`/r/<revision>/…`), the review shell (`/__review/`) and staging (`/staging/<site>/`) | Internal network / VPN |
| **Your live sites** | `example.com`, `go.example.com`, `example.com/campaigns/go-launch` | What's published | Everyone |

- The app and the preview address are **different sites**, not subdomains of one domain: browsers treat sibling subdomains such as `studio.example.com` and `studio-preview.example.com` as the same site, so SameSite cookies would not protect the app. Different ports on one host are not enough either. That's what stops generated code from reaching the app's cookies or asking for an Admin's passkey.
- Both are internal names, pointing to the app's server (in our setup, on the internal DNS).
- The app's cookies are bound to its exact hostname, never to `example.com`.

**Publishing live sites (Deployment tab)**

- **Paths** under an existing domain need nothing new: they go live with the next release.
- **Subdomains:** one wildcard DNS record (`*.example.com` → the production server), set up once, and one wildcard certificate per environment. After that, new subdomains are added in the tab and go live with the next signed release.
- **A new domain** (e.g. a campaign on its own `.com`): the tab shows the DNS record to create, and shows "Waiting for DNS" until it's in place.
- **Moving a site** to a new address: change it in the tab; it offers redirects from the old one.
- **One address, one site:** the tab won't give the same hostname or path to two sites.
- Extra targets (§13.2) are optional and only for installs that want another stage; they're just one more live address, e.g. with a password in front.

**Outside the app:** the DNS records, and internal certificates for the two internal names.

### 13.12 Separation

- The app's own code is a separate repo with its own pipeline. Sites and the app never ship in the same pipeline.
- App data, including the release log, is covered by the backups in §12.

---

## 14. Tech stack

- **Bun + Hono** as the API (thin: keeps keys out of the browser, streams LLM responses, versions, logs usage). Bun's built-in SQLite; one process, one database file plus the data root.
- **Svelte SPA** as the client (streaming, previews, side-by-side, dashboards with little code). Served by the same process.
- **The API is the product; the web app is one client.** Bjarke's canvases or Claude Code can talk to the same API later (e.g. through an MCP layer).
- **LLM calls:** one `llm()` function using `fetch` against `/chat/completions`, configured by three variables: base URL, key, model. No gateway (LiteLLM dropped). Works with any OpenAI-compatible endpoint, including local models.
- **Accounts and roles:** the app is universal, not QualiWare-specific. Two roles, Admin and Creator (§16).
- **Test accounts for the concept, created at install:** 2 Admins (both can be kept in 1Password) and 20 Creators, with simple passwords matching the user name. Admins sign in with a passkey instead (§13.8). No MFA for Creators in the concept. Concept only: the app stays on the internal network while these accounts exist, and they are replaced by SSO (Entra ID) before production (§21.5).
- **Small database tables:** projects, briefs, blocks, artifacts, versions, sandboxes, revisions, approvals, comments, usage, models (prices), members.

---

## 15. Usage statistics (decision 18 Oct: no money budget)

The cost manager is reduced to token statistics. The goal is to see where tokens go, so we can decide which model each kind of task needs. The app works with any OpenAI-compatible endpoint; a self-hosted model is simply another endpoint.

Every LLM call goes through `llm()` and writes one row:

```
usage: project, phase, action, task_class, user, revision,
       provider, endpoint, model, model_role,
       input_tokens, output_tokens, cached_tokens,
       latency_ms, retries, valid_first_try, outcome,
       estimated
```

- **provider, endpoint, model:** which API answered, e.g. one provider's API or another's. This is the attribution per API.
- **model_role:** the role the action asked for (planner, writer, designer, builder, critic, utility, analyst).
- **task_class:** small structured task, writing, design generation, code generation or critique.
- **outcome:** kept, discarded or reverted, so we can see tokens spent on work nobody kept.
- **valid_first_try, retries:** whether the answer passed schema validation without a retry.
- **estimated:** set when the endpoint didn't return usage and tokens were counted locally (usage via `stream_options` isn't guaranteed on every server).

Views:

- Tokens per provider and model, split into input, output and cached.
- Tokens per phase, action and task class.
- Tokens per project and per user.
- **Tokens to approval:** all tokens behind each approved section and page, including discarded attempts.
- **Discard share:** tokens spent on work that wasn't kept.
- **Model comparison view:** for each action, its tokens, average context size, first-try validity and keep rate, per model. Actions with small contexts, structured output and high validity are marked as candidates for a smaller, cheaper model, with the share of total tokens they represent.

Routing:

- Each action has a model role, and each role points to an endpoint. Admins change the mapping in settings, so moving an action to another model or endpoint needs no code.
- Later: **shadow runs.** For chosen actions, another model runs on the same input in the background, and its validity and keep rate are compared before switching.

In the flow: a token estimate on buttons before running, shown as a low–high range calibrated from past runs of the same action, and a live token counter and stop button while streaming.

Structured output: each provider has a capability flag (`json_schema` / `json_object` / none). All output is validated against its schema, with up to two retries that feed the validation error back, then a clear failure. Usage is requested with `stream_options.include_usage`; when a server doesn't return it, a tokenizer estimates it and the row is marked "estimated". Per-person usage is visible only to that person and Admins, and is aggregated and deleted after a fixed period (e.g. 90 days); usage per site and project is the default view. Prices can be added later as an optional layer; they are not part of the first build.

---

## 16. Roles and governance

### 16.1 The admin panel's tabs

- **Deployment:** sites and hostnames, environments, releases and rollback, certificates, production target, kill switch (§13.6).
- **Governance:** the rules for who may do what, in one place: Creator rights and presets (§16.4), the rules in the table below, and the two-person rule (§13.9). Changing a governance rule needs an Admin's passkey; lowering the two-person rule needs the current rule (§13.9).
- **Users and keys:** users and roles, invitations, Admin passkeys and approval of new keys, and later MFA (§13.8).
- **Notifications and mail:** the in-app inbox settings, mail server and recipients (§13.7).
- **Backups:** project backups (§12.2).
- **Models:** the model provider, the state of its key, and which model role each action uses (§15).
- **Checks:** every check, what it guards, and whether it's off, warns or blocks (§16.5).
- **Usage statistics:** tokens per API, model, action and project (§15).
- **Site settings › Languages:** which languages each site is published in, off by default (§26, decision 9).
- **Setup checklist:** the in-app items from §22.2, shown on first start.
- **Personal data:** later, for production (§21.5).

### 16.2 Roles

Two roles:

- **Admin:** everything. Only Admins can: publish to production (with a passkey), use the Deployment tab, manage backups, mail settings, users and roles, use the kill switch, and change the model provider.
- **Creator:** by default (the "Small team" preset, §16.4), everything to do with design and content: briefs, sitemap, design, revisions, media, and Brand and rules (design guide, brand assets, brief and design setup). Approves revisions for staging and requests publication. Up to "Explore" by default, plus the "Think new" toggle unless an Admin restricts it.

### 16.3 Governance tab

| Setting | Options / value |
|---|---|
| Brief approval | Off · Optional (default) · Required. Open questions never block. |
| "Think new" toggle | Available to Creators (default) · Admins only |
| Default creative freedom | Per page type (§10) |
| Change Brand and rules, accept guide proposals | Admin, and Creators if their rights allow it (§16.4). Versioned, audit-logged, can be rolled back |
| Section checklist before verification | Always required |
| Staging | The newest revision a Creator has approved, after the hard checks |
| Request publication | Creator; Admins are notified in the inbox (and by email if set up) with a link to the review page |
| Publish to production | Admin, on the review page, confirming with a passkey. At least two Admins with passkeys recommended. |
| Two-person rule | Per action: one Admin or two (releases, new Admin keys, domains and mail settings). Default one Admin, so a second Admin can stand in during holidays or sick leave (§13.9) |
| Usage statistics | Admins see everything; Creators see their own |
| Site languages | Set in Site settings › Languages, off by default. Subpaths per language (`/da/…`), no hreflang. The Translated checkmark is a completeness check only. |
| Interface language | Each person chooses EN or DA |

The production target lives in the Deployment tab, mail in Notifications and mail, and backups in Backups (§16.1).

### 16.4 Creator rights and presets

Each install decides how much Creators may do. Admins always have every right.

**Creator rights (toggles)**

- Edit briefs and the sitemap
- Edit Brand and rules (design guide, brand assets, brief and design setup)
- Accept proposals to change the guide
- Upload to the organisation's media library (not just the project's)
- Create new projects and pages, optionally limited to chosen page types
- Highest creative freedom, and the "Think new" toggle
- Edit the structure and menus (on by default; reviewed with the publication). With "Admin approves structure changes before staging" on, Creators propose and an Admin approves first.
- Request a subdomain or domain (an Admin always approves the address)
- Approve revisions for staging (if off, an Admin approves before staging)
- Request publication
- See usage statistics (their own, or everyone's)
- Invite other Creators

**Presets**

| Preset | Who it's for | What it sets |
|---|---|---|
| One-person studio | One person who does everything | One Admin, two-person rule off, Creator role not needed. Production still needs the passkey. |
| Small team (default) | The setup in this plan | Creators can do everything about design and content; one Admin approves releases |
| Locked down | Organisations with strict brand control | Creators can't edit Brand and rules or approve for staging; structure changes need an Admin before staging; creative freedom up to "Explore"; two Admins for releases and new keys |

A preset only fills in the toggles; each install can adjust from there, and the tab shows "Custom" once something differs.

**The security floor (can't be switched off)**

- Production always needs an Admin's passkey.
- The AI never gets tools that touch git, releases or files.
- The hard checks always run before staging.
- The audit log is always on.
- Lowering a rule needs the current rule (§13.9).

Every change in the Governance tab needs an Admin's passkey and goes in the audit log. Fully custom roles can come later; two roles with configurable Creator rights are enough for now.


### 16.6 Projects overview and project settings

- **Admins see every project** on the Projects page: its status, its live addresses, and what's waiting (publication requests, address requests, navigation changes). Creators see the projects they're members of.
- **An Admin can enter any project** and work in it with Admin rights.
- **Inside a project, Admins get Project settings:**
  - **Members:** who works on the project, and which Creator rights they have here (starting from the install's preset, §16.4).
  - **Addresses:** the project's live domain, subdomains and paths (the project's part of the Deployment tab).
  - **Structure:** the Structure workspace for this project (§10.2), and whether structure changes need an Admin before staging here.
  - **Rules for this project:** the two-person rule and checks can be made **stricter** than the install's defaults (e.g. two Admins for the main site), never looser than the security floor.
  - **Backups** for this project, and archiving the project.
- **"Waiting for you"** on the Admin's start page lists everything that needs an Admin across all projects.

### 16.5 Checks tab

All checks from §13.5 in one list, so each install can choose and see what it is protected against.

- **For each check:** what it guards against (code safety, brand rules, accessibility, speed …), where it runs (in the app, check runner, staging, production, scheduled), the result of the last run, and a setting: **Off**, **Warn** or **Block**.
- **The security floor is locked on:** the code validators, guide validators, secret scan, pinned libraries, SVG cleaning, HTML and link checks, the signature and hash checks in production, and the smoke test. They are shown with a lock and always block.
- **Everything else is the install's choice:** e.g. AI code review, accessibility, speed and motion tests, visual comparison, SEO basics. A strict organisation can raise accessibility to Block; a one-person studio can switch the speed tests off.
- **Changes need an Admin's passkey** and go in the audit log. Lowering a check from Block to Warn or Off follows the two-person rule if it's switched on (§13.9).
- **The tab mirrors the "How we check the AI's work" diagram,** so it also works as an overview of what the app checks.
- **Default: every check starts on Block.** Each one can then be lowered to Warn or Off per install, except the security floor, which stays locked on Block.
- **A block outside the security floor is cleared** by fixing the problem, or by an Admin accepting it with a reason (logged). A Creator can accept accessibility and visual-comparison findings with a reason if their rights allow it (§16.4).
- Scheduled checks (links, certificates, expiry, restore test) are on by default.

---

## 17. Bjarke's rules → the app

**Disappear (the app owns the state):**
- Asking which brief at session start (you're always inside a project).
- Red section labels, role chips, Tweaks toggles, click-to-copy in the HTML → UI overlay.
- `roles.py`, `names.py`, `progress.py`, `tracker_sync.py`, `layout.py`, `backup.py`, `labelfit.py` → the data model.
- "Re-read before editing, never republish an older copy" → optimistic locking.
- Previews as separate artboards → device switch.
- Relettering and the rename record → stable IDs.
- Author question → login.

**Become hard rules in the database:**
- One Lead per page. Derived section status. Approved sections locked. Restricted images only for allowed section types.

**Become derived views (no sync step):**
- Tracker, site map, log, open questions, change log.

**Become automated:**
- Copied progress, interaction check, mobile check, artboard names from the project ID.

**Stay as Bjarke wrote them:**
- Brief template and voice reference, design guide, section checklist, artboard roles, restricted-image rules, logo check, deliberate WCAG breaks stated out loud.

**Change:**
- Static artboards with no script-drawn content. Artboards may now run scripts, for motion and 3D (§6.7).

---

## 18. UX features

**In the showcase:**
- Phase bar with status.
- Brief board: guided / one prompt, block editor, structured CTAs, sitemap tree, derived open questions, change log.
- Design overview with roles and consistent actions.
- Design editor: outline, full-size page, section selection, device switch, inspector, checklist, prompt bar with scope and creative freedom.
- Deviations with three outcomes.
- New page flow with page types and sitemap placement.
- Revisions tree with Continue from here / Bring from.
- Project settings (governance).
- Brand and rules: typography, colours with the derived-colour builder, contrast table, motion, brand assets with the logo studio, fixed elements, brief setup, design setup.
- Media library: organisation and project libraries, categories, "Used in".
- Material in prompts: drop zone in the mini-brief, paperclip and drag-onto-section in the editor (§6.9).
- Performance tab per release (§8.1).
- The Structure workspace (tree, inheritance, navigation pattern, menus) and the brief's ways in (§4.10, §10.2).
- New page with the placement step, the address request, the navigation proposal (before/after), and the Admin's Projects page with "Waiting for you" and Project settings (§10, §16.6).
- Review mode with the section checklist (§13.2a) and the review page for publication (§13.3).
- Admin panel: Governance tab with Creator rights and presets, Checks tab, Deployment tab (sites and hostnames, environments, releases, rollback, certificates, keys, kill switch), mail settings, project backups.
- "Think new" toggle styled as a warning.
- Token estimate on buttons, usage statistics with the orchestration view.
- EN/DA switch.

**Next round:**
- Run the same action with two models; compare quality and price.
- Approver inbox (price, checks, changes in one place).
- Shareable preview links for stakeholders without login.
- Prompt chips per phase, edited in Brand and rules.
- Command palette (⌘K), CSV export of spend.
- Presence: who has a sandbox open on what.
- Import project.
- Generate an image under Media (guided prompt builder, §6.8).

---

## 19. Plan

**Monday 19 Oct — showcase with Bjarke (clickable design, not code):**
- Walk through the screens; collect his input on the question set, variation axes, checklist, and governance defaults.

**Build week (after the showcase):**
- Day 1: walk through how his workflow maps onto the app's phases with him. Import QualiWare's design guide into Brand and rules. Review question set v1 (§4.9). Import his existing briefs.
- Day 2: data model, phase runner, `llm()` with usage logging, preview.
- Day 3: sandboxes, revisions, propose/approve, version history and side-by-side.
- Day 4: UI polish, cost dashboard, a demo project with real content.
- Day 5: buffer and dry run with Bjarke.

**Deliberately out of scope for the first build:** production publishing and the separate production host, real-time collaboration, Bjarke's custom canvases, importing designs and whole projects. Only briefs are imported; designs are recreated in the app to test it.

---

## 20. Decisions on the open items (18 Oct)

1. **Brief questions:** generic question set v1 drafted (§4.9). We clear them up ourselves.
2. **Variation axes:** two groups. Form: Layout, Density, Depth, Media. Feel: Tone, Colour rhythm, Motion. Users can add a short text describing the direction they want. Visual style is chosen at site level, and a section's job comes from the brief (§6.4). Motion and 3D are a priority (§6.7).
3. **Roles:** Admin and Creator. The app is universal; we create accounts that represent each role (§16).
4. **Creative freedom:** defaults per page type as in §10. "Think new" is a warning-styled toggle, not a prompt word (§6.5).
5. **Budget:** replaced by token usage statistics with attribution per API and model, and a model comparison view per action (§15).
6. **Languages:** Danish and English to begin with.
7. **Import:** only briefs. Designs are recreated in the app, to test it.
8. **Workflow and rules:** Bjarke's workflow is built into the app's structure. The company's design rules, brief setup and design setup are defined once in Brand and rules and edited interactively (§5).
9. **Roles widened:** Admins can do everything; Creators can do everything to do with design and content, including Brand and rules (§16).
10. **Media:** a media library with categories and "Used in" from the start, and logos and fixed elements as brand assets (§5.5, §6.8). Personal data, including consent, is noted for later (§21.5).
11. **Logos:** SVG required, so colours can be changed. A logo studio in Brand assets makes recoloured variants, lockups and icon exports (§5.5).
12. **Material:** files are added in the mini-brief or the editor's prompt bar and land in the media library; video is converted on upload, with an optional approved video platform for long videos (§6.9).
13. **Performance:** sitespeed.io (with Lighthouse) and Playwright motion tests in the check runner, every page must score "good" (below that blocks by default), PageSpeed Insights only for production field data (§8.1).
14. **Pipelines:** as much as is useful in the pipelines, each check at the cheapest point that catches the problem; hard gates block, advisory checks need an Admin's acknowledgement (§13.5).
15. **One install:** everything in one package with a built-in release log, check runner and web server. Production is locked behind an Admin's passkey and runs built-in or on a separate host (§13).
16. **Notifications and mail:** an in-app inbox by default; email optional, with mail server settings, recipients per notification and OAuth for Microsoft 365 (§13.7).
17. **Publication flow:** a Creator approves a revision, it goes to staging for testing, issues are revised in the editor, and when it's right the Creator requests publication. Admins get an email with a link to a review page and approve with a passkey, or send it back with a comment (§13.3).
18. **Accounts:** Admins sign in with a passkey only and confirm production actions with it; setup code, invitations, recovery codes and machine tokens are shown once. MFA for Creators (Microsoft Authenticator) is production scope, not the concept (§13.8).
19. **Two-person rule:** optional, per action. One Admin can approve alone, or two Admins must each approve with their passkey; production enforces it itself (§13.9).
20. **Creator rights:** configurable per install in the Governance tab, with three presets (one-person studio, small team, locked down) and a security floor that can't be switched off (§16.4).
21. **Staging inside the app:** no staging server; sites publish to any URL through production targets; extra named targets for more stages (§13.2).
22. **APP_URL:** the app's own address in the env file; passkeys are bound to it, never to where sites are published; it can be moved with a guided move (§13.8).
23. **Review mode** is where Bjarke's section checklist is ticked off by hand, section by section, before a revision can be approved (§13.2a).
24. **Checks tab:** every check starts on Block and can be lowered to Warn or Off per install, except the security floor (§16.5).
25. **Production ships to its own server:** a TAPPaaS VM in our setup, a VPS or own machine for others. It's paired and configured from the Deployment tab; built-in stays an option for other installs (§13.4, §13.6).
26. **Pages and navigation:** a new page lives in the site (in the menu or hidden, link only) or on its own subdomain, which an Admin approves. The AI proposes navigation changes as before/after menus within the header design; an Admin approves. Admins see all projects and have per-project settings (§10, §16.6).
27. **Structure workspace:** the site tree (with separate addresses as their own roots and hidden pages in place), inheritance rules, the navigation pattern as a designed and approved section, and menus. Creators edit it; changes are reviewed with the publication; stricter installs can require an Admin first (§10.2). The tree can be drafted by the AI, built by hand, pasted as an outline or imported (§4.10).

Still open:

- Whether "Tone and feel" becomes a block in Bjarke's brief template.

---

## 21. Security and sovereignty

Every control below is drawn in the "Security controls" diagram and **must be tested on staging and signed off by an Admin before the first production release.** The checklist lives in the admin panel and is run again after every change to the release chain.

### 21.1 Generated code

The AI writes JavaScript (3D, motion) that ends up on a public site. That is the main risk, so it has two layers of checks:

- **Code validators (hard).** Run in the app before preview and again in the check runner on every approved revision. They reject scripts or resources from domains outside an approved list, forms that post to unknown addresses, `eval`, and inline event handlers.
- **AI review (advisory).** A second check in the check runner by the chosen model endpoint: a structured yes/no check with a reason ("does this code load anything from outside, send data anywhere, or do something the brief doesn't ask for?"). It will miss things and raise false alarms, so it never replaces the validators. A flag requires an Admin to acknowledge it before publishing to production. Nothing in the app can publish to production without an Admin's passkey.
- **Measured, not assumed.** A set of known-bad samples is run through both layers, so we know what each catches.
- **CSP and security headers** on the published sites, HSTS, Referrer-Policy, Permissions-Policy. The CSP is a contract for the validators:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
worker-src 'self' blob:; connect-src 'self'; font-src 'self';
media-src 'self'; frame-src <approved video platform host>;
object-src 'none'; base-uri 'self'; form-action 'self';
frame-ancestors 'none'
```

  One approved video platform per site (Livid): its player host goes in `frame-src`, and in `img-src` if thumbnails load from it. Generated code uses external scripts only; inline scripts and inline event handlers are rejected; inline styles are allowed. The check runner fails any page with CSP violations in the console.
- **Preview isolation.** Previews run in a sandboxed iframe on their own domain, so generated code can't read the user's session in the app.

### 21.2 Prompt injection

- Pasted text, uploaded documents and imported briefs are sent to the model marked as data, never as instructions.
- The AI has no tools with consequences: no git, no releases, no file system access.
- The code checks in §21.1 catch whatever slips through.

### 21.3 Uploads (light version)

Little extra work, because images are already processed on upload:

- An allowed list of file types and a size limit.
- Metadata removed on upload: `exiftool -all=` for images and PDFs, `ffmpeg -map_metadata -1` for video.
- SVG files always cleaned of scripts, embedded images and external references. Required for logos (§5.5).
- 3D models (GLB): type and size check only.

### 21.4 Sovereignty

Drawn in its own diagram ("Where data lives").

- **Stays in-house:** app and project data, Brand and rules, the release log with every release and its package, the audit log, and all keys.
- **Leaves the building, on purpose:** prompts and context to the chosen model endpoint (any OpenAI-compatible API) for every AI step, including the code review in the check runner; encrypted off-site backups (the key stays in-house); the published site (released files only); and notification emails, through your own mail server.
- **Admin setting "Model endpoints":** decides which OpenAI-compatible endpoint each model role uses. A self-hosted model is just another endpoint.
- **Nothing else leaves:** no analytics, no third-party scripts, no CDN on the generated sites.

### 21.5 Access, audit and the kill switch

- **Logins:** Admin passkeys from the start; test accounts for Creators in the concept (§14). Creator MFA and SSO come with production scope (§13.8).
- **Audit log of all changes:** content, Brand and rules, roles, approvals, releases, settings and backups, stored where the app itself can't delete it.
- **Kill switch (admin panel):** end all sessions, freeze all releases, revoke tokens, and put the app in read-only mode. Each one on its own and all at once, with a short incident runbook.
- **Passkey-signed releases and rollbacks:** production refuses any release or rollback without a valid Admin signature, or with a hash that doesn't match (§13.3).
- **Email hardened:** no actions from email links, no secrets in links, passkey for every production change (§13.7).
- **No call limits:** deliberately left out for the concept. Token use is still measured (§15).
- **Usage tracking and Danish rules:** token use per person may count as a control measure (kontrolforanstaltning), which typically needs advance notice to employees and discussion in the cooperation committee (SU). Check with HR before rollout.
- **Personal data (noted, not part of the concept):** consent for photos of people (given or not, by whom, expiry, blocking an image when consent is withdrawn), how long prompts are kept, and telling users that token use is logged per person. Collected on its own page in the admin panel when the app moves towards production. The media library's "Used in" makes it easy to add later.

---

### 21.6 Known risks, accepted for now

- **Built-in production, if another install chooses it.** Reduced by the sandboxed container (§13.4), but a container escape or a compromised machine would reach the app too. Our concept uses a separate host instead.
- **Pairing a new production server** is the moment trust is set up. It needs the shown-once pairing code and an Admin's passkey, and the agent shows the app's address and key fingerprint so the Admin can check they match.
- **Test accounts with simple passwords** for the concept (§14). **Action:** keep the app on the internal network while they exist; replace them before production.

---

## 22. After install: what's left to do

The app does as much as it can, but some things need a person with access to systems outside the app. This list is the hand-over: what is left once the install is finished, and what can't be done by whoever builds the app (including Claude while writing the code). The in-app items also appear as a **setup checklist in the admin panel** on first start, ticked off as they're done.

### 22.1 Outside the app (IT, once)

- [ ] **Servers:** a machine or VM for the app, with room for the headless browser checks (and one for production, if it runs on a separate host). Firewall open only for the web ports; the app's admin pages on the internal network or VPN while the test accounts exist.
- [ ] **Install the package** on the app's server, and **pair the production server** (a TAPPaaS VM in our setup) from the Deployment tab: run the shown command there and confirm the pairing with an Admin passkey (§13.6).
- [ ] **`.env` in the app root:** `DATA_DIR`, the model provider key, and a newly generated `APP_SECRET`. Keep a copy of `APP_SECRET` in the password manager; without it, the encrypted settings can't be read after a restore.
- [ ] **Model endpoint:** any OpenAI-compatible API, with its data region and retention settings chosen, and a key for the app.
- [ ] **DNS:** two internal names that are different sites, the app (`studio.internal`) and the preview address (`preview.internal`), plus the wildcard and domains for the live sites (§13.11). A DNS API for the app's DNS-01 certificate requests. Set `APP_URL` before any Admin registers a passkey; it can be moved later with the guided move (§13.8).
- [ ] **Certificates for internal addresses:** passkeys need HTTPS with a certificate browsers trust, also for the app and staging on the internal network (e.g. an internal certificate authority, or certificates through DNS).
- [ ] **Custom domains** outside the wildcard, if a campaign needs its own domain.
- [ ] **Mail (optional):** only if notifications should also go out by email. A dedicated sending mailbox with send-only rights. For Microsoft 365, an app registration for OAuth. **SPF, DKIM and DMARC** for the sending domain.
- [ ] **Backup target:** a folder, network share or cloud storage for project backups, with an off-site copy that the servers can't delete (§12).
- [ ] **Whole-machine snapshots** of the app server (and the production host).
- [ ] **Patching** of the servers' operating systems, on a schedule.

### 22.2 In the app (first start, Admin)

- [ ] **The two test Admins** created at install sign in with the setup codes, each creates a **passkey** and keeps the recovery codes in the password manager (e.g. 1Password), and they approve each other's keys. For real use, further Admins are invited (§13.8).
- [ ] **Mail settings** (optional): recipients per notification and a test email. Otherwise the in-app inbox is used.
- [ ] **Model provider** setting.
- [ ] **Brand and rules:** import the design guide, check fonts and colours, upload the logo as SVG and make the variants in the logo studio, set up the fixed elements (header, footer, contact details).
- [ ] **Brief and design setup:** review question set v1 (§4.9), checklist, page types and their defaults, variation axes.
- [ ] **Performance budgets** per page type (§8.1).
- [ ] **Deployment tab:** sites and hostnames, production target (built-in or separate host), allowed domains (e.g. a video platform).
- [ ] **Project backups:** target, schedule, retention and encryption (§12.2).
- [ ] **Users:** the test accounts for the concept (§14), or real users.

### 22.3 Before the first production release

- [ ] **Go-live checklist:** every control in the "Security controls" diagram tested on staging and signed off by an Admin (§21).
- [ ] **Test accounts replaced** by real accounts or SSO (Entra ID), with **MFA for Creators** (e.g. Microsoft Authenticator) (§13.8).
- [ ] **A restore drill:** restore a project and the app into a clean environment (§12.3).
- [ ] **A load test** against the production site, once (§8.1).
- [ ] **Smoke test and automatic switch back** tried on purpose with a broken release.
- [ ] **Personal data** page filled in (§21.5), if the site uses photos of people or customer quotes.

### 22.4 Still to be decided

- [ ] Whether "Tone and feel" becomes a block in Bjarke's brief template.
- [ ] The app's name ("Site Studio" is a placeholder).

---

### 22.5 Pitfalls found in the final review

How the plan handles each one:

- **Built-in production** would put an internet-facing service on the same machine as the app. → Our concept ships production to its own server; built-in stays an option for other installs, sandboxed and marked as a known risk (§13.4, §21.6).
- **Passkeys are bound to the app's own address (`APP_URL`),** not to where sites are published. → Sites can go to any URL freely; moving `APP_URL` itself is a guided move (§13.8).
- **Passkeys need trusted HTTPS,** also on the internal network, where public certificates can't always be issued automatically. → Internal certificates are on the setup checklist (§22.1).
- **Previews on the app's own address** would let generated code reach the app's session. → Previews get their own address (§13.1, §21.1).
- **The check runner is the one heavy part** (a headless browser; the app itself is light). → Not a concern for our servers; each check can be switched in the Checks tab (§16.5).
- **One Admin means one person can do everything,** including recovering access with a recovery code. → Recommended: at least two Admins; recovery codes kept like the passkey itself (§13.9).
- **Two Admins required for new keys, and one is away:** a lost device can't be replaced until they're back. → A known trade-off of the "Locked down" preset; "Small team" keeps one Admin (§16.4).
- **Freezing could be misused** to take a site down. → Freezing needs an Admin's passkey like every other kill switch action, and every use notifies all Admins (§13.6).
- **For the build:** production must check a passkey (WebAuthn) signature over the release's hash, which means the challenge the passkey signs must be that hash, and production must know the app's address. This is the least ordinary part of the design, so it gets a **spike**: a short, time-boxed experiment (half a day to a day) early in the build week that proves it works, built-in and on a separate host, before the rest is built on it.
- **Passkeys bound to the main domain** would let a generated page on a subdomain ask an Admin to sign. → Bind them to the app's own hostname (§13.8).
- **Previews or staging under the app's hostname** (e.g. `preview.studio.example.com`) would put generated code under the passkey's address. Found in the final review of domains; staging was also on the app's own address. → Both now live on the preview address, side by side with the app, never under it (§13.11).
- **Creators that may not approve for staging** (Locked down) need an Admin for every staging round. → Expected in that preset; the default lets Creators approve (§16.4).

### 22.6 Spikes for the build week

Short, time-boxed experiments (half a day to a day each) that prove the unusual parts before anything is built on top of them. Done first, in this order:

1. **Passkey-signed releases.** An Admin's passkey signs a release's hash (the hash is the WebAuthn challenge), and production verifies the signature against `APP_URL` and the trusted keys, on the paired production server (and built-in, as an option). Includes the pairing and the key chain: a new key accepted only with an existing Admin's signature.
2. **Moving `APP_URL`.** The guided move from §13.8 works without locking anyone out.
3. **Preview sandbox.** The preview on its own address, inside a sandboxed frame, reports clicked sections to the review panel and can't reach anything else in the app.
4. **Certificates through the outbox.** Production writes a CSR to its outbox, the app completes ACME with DNS-01 and drops the certificate in the inbox; renewal runs without a passkey.
5. **The check runner.** A separate worker on Node and Playwright running the browser checks on an approved revision, with the Off / Warn / Block settings from the Checks tab.
6. **The inbox and outbox.** SFTP push of a signed bundle, an app-signed freeze command, and a heartbeat read back from the outbox.

If a spike fails, the plan is adjusted before the build continues.

---

## 23. For Bjarke: what changed in his workflow, and what's new

A summary for the hand-off. His workflow is the app's structure; most of his rules are kept, some are now enforced by the app, a few are changed, and several things are new.

### 23.1 Kept as he wrote them

- The four steps: brief → design → verification → build.
- The brief template and the reference brief for tone of voice; briefs can still be exported as his Markdown.
- The design guide's rules: fonts, colours, derived colours with exact recipes, contrast pairings.
- Section-by-section approval with the seven checkmarks: Copy, Media, Interactions, Mobile, Motion, Translated, Tested. Only a person switches them on; the AI may only suggest.
- Artboard roles (Lead, Alternative, Reference, State) and one Lead per page.
- Approved sections are locked; restricted images only where the page calls for them; the logo check.

### 23.2 Changed in his Brief Generator

- **Brief IDs** (`bjarke2`) come from the app and never change; the file-name pattern only matters on export.
- **The author is the person signed in,** so the "ask who the author is" rule is gone.
- **Open questions and the change log are generated** from the blocks and the history, not written by hand. Open questions are guidance and never block anything.
- **"Don't invent" is enforced:** every filled field needs a source (the user or an existing brief).
- **Deleting a brief** is a soft delete in the version history; nothing moves between folders.
- **The template is edited in the app** (Brand and rules › Brief setup), not in a skill file.
- **Question set v1** for the guided mode is drafted generically (§4.9); we clean it up.
- **New block: "Tone and feel"** (three words, how alive it should be, a site you admire). It feeds the Motion axis and new pages. *For Bjarke to confirm.*

### 23.3 Changed in his Design Agent

- **No brief question at session start:** you are always inside a project.
- **Annotations move out of the HTML:** red section labels, role chips, Tweaks toggles and click-to-copy are an overlay in the app, so nothing has to be stripped before hand-off.
- **His scripts are replaced by the app:** `roles.py`, `names.py`, `progress.py`, `tracker_sync.py`, `layout.py`, `backup.py`, `labelfit.py`. Tracker, site map and log are generated views, never synced.
- **Stable names:** artboard letters are never reused or shifted when one is deleted, and sections have stable internal IDs, so the rename record is no longer needed. *For Bjarke to confirm.*
- **The checkmarks are ticked in review mode** (§13.2a); Interactions and Mobile can only be ticked when their conditions are met, and copied sections keep their progress automatically.
- **Previews** are a device switch and review mode, not separate artboards.
- **Static artboards:** artboards may now run scripts, for motion and 3D. *For Bjarke to confirm.*
- **The validation agent is defined:** it's the verification step plus the check runner (§8, §13.5).
- **WCAG is guidance, not a block:** findings are warnings; a deliberate break is accepted with a reason.
- **Hand-off is an export** of the approved Lead, locked as a version, instead of a folder of files.

### 23.4 Changed in the design guide

- **It becomes "Brand and rules"** in the app: edited with forms, versioned, and turned into `guide.json` for the validators automatically.
- **Derived colours** get a builder (pick colours, drag a slider, get the exact recipe); the contrast table is calculated, never written by hand.
- **Logos must be SVG,** with a logo studio for colour variants, lockups and icons.
- **Motion tokens** (durations, easing, distances) are added next to colours and fonts.

### 23.5 New

- **Motion and 3D** as part of the design: four motion levels, fallbacks for reduced motion, three.js for 3D (§6.7).
- **Variations on request** along named axes, Form (Layout, Density, Depth, Media) and Feel (Tone, Colour rhythm, Motion), one direction by default, with a short text to describe the direction (§6.4).
- **"Think new"** as a warning-styled toggle, with deviations that are fixed, kept as experiments or proposed to the guide (§6.5, §6.6).
- **Visual style** chosen once per site; a section's job comes from the brief (§6.4).
- **Page types and a new-page flow:** core page, landing page, campaign, customer story, with a shared sitemap tree (§4.7, §10).
- **Media library** with categories and "Used in", and material added straight into prompts, including video (§6.8, §6.9).
- **Performance:** every page must score "good" in the speed tests (§8.1).
- **Publication:** staging inside the app, then a publication request and an Admin's approval with a passkey (§13).
- **Roles:** Admin and Creator, with configurable Creator rights (§16).

### 23.6 For Bjarke to confirm

1. "Tone and feel" as a new block in the brief template.
2. Stable artboard letters instead of letters that shift.
3. Artboards that run scripts, for motion and 3D.
4. Question set v1 as a starting point.

---

## 24. Design mockup status

- Canvas (current): "Site Studio – clickable prototype", Gallery direction, Creator and Admin paths with a prototype role switch, 31 screens plus the mood board.
- Earlier draft: https://claude.ai/artifact/966tpnuRRUy43yL51uCiYZ ("AI Site Studio – UX draft"), kept for reference only.
- Architecture diagrams: https://claude.ai/artifact/4nKfvcTDXkX3gNrTNXu3NJ ("AI Site Studio – Stack and structure": stack, release flow, security controls, where data lives, how we check the AI's work, accounts and passkeys, pages, addresses and navigation).
- Screens: Brief board, Design overview, Design editor, New page, Revisions, Project settings.
- Known issues to fix in the next round:
  - The Brief board did not render correctly after the last redesign; a detached copy of part of it sits on the canvas as a separate piece.
  - "Open in editor" sits in different places on the overview cards; make it consistent.
  - The overview still shows three directions per page; change it to one direction by default, with "Show another take on…" by axis (§6.4).
- Next round: **don't repair the old canvas; rebuild in a fresh canvas**, as complete and interactive as possible, for the Monday showcase. Avoid the three issues above from the start, so nothing is done twice.

---

## 25. Prompt for the design

The full prompt for Claude Design is in **`design-prompt.md`**. Attach this plan to the new chat and paste the prompt.

In short, it asks for:

- A clickable prototype of the whole app, designed around the workflow **Brief → Structure → Design → Review → Staging → Publication**, with a Creator path and an Admin path and a prototype switch between them.
- **Clear in wording, friendly by nature, neutral by design:** neutral app chrome, so the user's work (QualiWare's brand in the demo) is the most colourful thing on screen.
- A **mood board first,** with three directions on one screen (Workbench, Studio table, Gallery), then everything built in Workbench, borrowing Gallery's idea that the work is the hero.
- **No "made by AI" look:** no stock icon sets, no sparkles, no purple gradients, glass or emoji, no Inter; a custom icon set and text labels.
- **Motion only where it explains something,** short and with reduced motion respected.
- A fresh canvas, avoiding the earlier draft's known issues (§24).

---

## 26. Developer decisions (19 Oct)

The developers' answers to the feasibility review. The sections above are updated to match; this list is the reference.

**Infrastructure / DevOps**

1. **Release flow.** Production never connects to the app. The app connects over SFTP with its own key to two chrooted folders: an **inbox** (signed bundles, certificates, signed commands with sequence number and expiry) and an **outbox** (heartbeat, disk use, active release, smoke-test results, logs, certificate requests). Freeze needs only the app's signature; unfreeze needs an Admin passkey. Health comes from the heartbeat's age. Pairing installs the app's SSH and signing public keys on production and pins production's host key (trust on first use).
2. **Check runner sizing.** A separate worker on Node and Playwright; 2–3 GB disk for browsers, 2–4 GB RAM per concurrent check; a queue with concurrency 1–2.
3. **Certificates.** Issued before go-live. Production makes its own key and writes a CSR to the outbox; the app runs ACME with DNS-01 and drops the certificate in the inbox, outside any release. Renewal around day 60 of 90, no passkey. Fallback: key encrypted to production's public key. One wildcard per environment; campaign domains are public in CT logs.

**Security and identity**

4. **Preview isolation.** App and previews on different sites (`studio.internal`, `preview.internal`), not sibling subdomains or ports. Origin check and CSRF token on every state-changing request; previews get `connect-src 'self'` and no cookies.
5. **CSP contract** as in §21.1, with one approved video platform per site in `frame-src`, external scripts only, and a check-runner rule: zero CSP violations in the console.
6. **Passkey-signed releases.** Signature over release hash plus an ever-increasing release number (guards acceptance, not the active release). Automatic switch-back without a new signature; Admin rollback is a new signed release pointing to old content. Origin and user verification checked; a signature counter of 0 is ignored.

**Frontend and the design engine**

7. **Section markers.** `data-section="<stable-id>"` in shipped HTML, unique per page, kept in production.
8. **Byte-identical package.** Built once, one SHA-256; preview, staging and production serve it unchanged. Review shell on the preview origin with overlays from the markers; approval in the app from the app's own data. Accepted risk: the shell shares an origin with generated code.
9. **Multilingual, no SEO.** Site settings › Languages, off by default; subpaths per language; no hreflang, per-language metadata or sitemaps; menu labels per language; Translated is a completeness check only.
10. **Concurrent editing.** Private drafts, autosaved; a numbered revision only on save; Bring from as the merge tool; presence shown in the Design editor and Revisions; no locks, no Replace.

**Validators and checks**

11. **Throttled GPU motion test:** removed.
12. **3D and heavy-animation profile** (§8.1).
13. **Validator scope:** DOM text and CSS colours and fonts; canvas/WebGL, images and video on a manual checklist; text over images as a warning-only heuristic.
14. **Derived colours in OKLab** with one shared module and golden test vectors; mismatches signed off by design (accept or pin the old hex).
15. **Screenshot comparisons** with reduced motion, animations off, videos at frame 0, fixed seeds and masked canvases; generated code must honour reduced motion (validator rule).
16. **3D interactions** expose DOM controls, which the interaction check tests.
17. **Field speed data** is optional; lab results are the gate.

**AI and models**

18. **Structured output:** capability flag per provider, schema validation with two retries, usage via `stream_options.include_usage` or a marked estimate.
19. **Critic on large sites:** a generated site digest plus the full content of only the pages under review.
20. **Token estimates** as calibrated low–high ranges, with actuals after.
21. **Self-healing** as in §13.5: untrusted, redacted logs; no tools; fixed output schema; cost cap; at most two attempts.

**Compliance**

22. **Personal data:** usage per site and project by default; per-person usage only for that person and Admins, aggregated and deleted after a fixed period; check the Danish rules on control measures with HR; metadata stripped from images, PDFs and video.

**Priority.** Before the build starts: 4, 7, 8, 10, 14, 18, and the written policy in 5 (enforcement later). Production stage: 1, 3, 6, 12, 17, 21, 22.
