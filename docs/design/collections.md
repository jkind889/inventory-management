# Collections styling spec and verification

The user accepted the Beats in Space-inspired direction: separate collection blocks with two recent purchases, plus Spending and Future Wants tabs. The built-in Image Gen tool produced [the desktop concept](collections-concept.png), which is a design reference rather than app content. Example names, counts, and prices in that image are fixture data.

## Design system

- Pale lavender canvas `#f7f4fc`, lavender artwork `#eeebf4`, black ink `#111`, hover accent `#744e96`, with white text on the accent.
- Arial/Helvetica for the app shell and grid. Desktop heading about 56px, collection titles 36px, navigation 18px, item names 16px, purchase metadata 14px. Responsive headings shrink deliberately. The compact collection list uses Menlo/Monaco monospace with uppercase text.
- Full-width header and three equal navigation tabs. Main content has 30px desktop insets and 12px gutters.
- Flat panels with 1px borders and square corners. Collection blocks and controls receive purple only on hover. Active tabs and selected controls use an underline; primary buttons, notices, and the Spending total stay neutral. Keyboard focus keeps its outline.
- Three columns above 1100px, two through tablet sizes, one at 650px and below. Each populated block has a paired purchase preview; a single purchase gets an Add Item slot.
- Footer actions: View collection and a category-specific Add Item button. Full collection browsing preserves search, sorting, filtering, grid/list views, and pagination.
- Groceries is hidden from the Collections overview and category filter. Existing records, entry forms, and spending data are preserved.
- List view follows the supplied list reference's compact rows without dividers or artwork and aligned item/collection/cost/date columns. The user's palette revision uses a white `#fff` surface and black `#000` text. Dates retain their year and missing prices/dates use an accessible dash. Rows open details and use the shared purple hover; keyboard focus follows the text color. At 650px and below, rows use two lines with name/cost above collection/date. Grid artwork is retained while the user evaluates the cover treatment.
- Spending retains its existing monthly behavior with the same visual tokens. Future Wants uses the same tab shell and supports saved entries, details, estimated prices, product links, notes, and priority.

## Intentional differences from the generated concept

The existing outline icon family is retained as category artwork. It identifies a category and does not claim to be an item photo. The generated filled monitor/palette/lamp imagery is not shipped as product imagery. Empty collections have no fabricated latest purchase date. A second-purchase slot has an Add Item symbol rather than the concept's misleading category-artwork caption. User/account information and collection counts come from the authenticated API, not the fixture text. The original reference's oversized background logo and audio-player UI are outside this app's scope.

## Verification record

Browser/IAB loaded the fresh local app at `http://localhost:3001`, confirming the actual sign-in screen. The prior server at port 3000 had missing CSS/JS chunks before this work. The Browser plugin/skill is not installed; authenticated layout and interactions were checked using the existing local Playwright/Chrome fixture workflow, avoiding changes to the user's account. No browser dependencies were installed.

The accepted concept and latest desktop render were both inspected with `view_image` at the native 1536×1024 concept size. Additional layout checks used 900×1000 and 390×844 viewports.

| Comparison point | Concept vs. render | Resolution |
| --- | --- | --- |
| Navigation/copy | My space; Collections, Spending, Future Wants; Your collections; Add item | Same labels and ordering; no new overview hero/metrics. |
| Layout | 3-column / 2-row editorial blocks | Same desktop structure, paired items and block footer; responsive 2/1 columns verified. |
| Typography | Large sans-serif title and collection names, compact metadata | Matched scale and weights; removed old heading bottom margin. |
| Palette | Lavender, black, hover-only purple | Exact flat token colors; removed inherited white table surface and green rounded spending icons. |
| Spacing/container | Narrow gutters, square panels, footer rules | Fixed header/grid spacing and single-item alignment; all six blocks fit the native desktop capture. |
| Artwork | Generated filled category symbols | Intentional existing outline-family substitution, with honest category-artwork labels. |
| Empty states | Zero/single-purchase blocks remain usable | No invented dates, single-purchase Add Item slot, collection counts remain accurate. |

Above-the-fold copy check: the concept's primary heading, subtitle, tabs, brand, and Add Item label are preserved. Fixture item/account content is illustrative. Empty-state dates/captions are intentionally corrected as listed above. No material layout mismatches remain relative to the accepted direction; outline artwork is the recorded design deviation. The implementation was faithfully verified against the accepted layout and token system.

| Check | Result |
| --- | --- |
| Page identity/nonblank | Inventory at the intended local origin; meaningful collections and tabs. |
| Framework overlay/console | No relevant runtime overlay, console warnings, or app errors in the fixture run. |
| Screenshot evidence | Desktop collection, Spending, Future Wants; mobile collection, Spending, and want form. |
| Interaction proof | Item details; collection drill-down/search; category-aware Add Item; month navigation; create/retry/reload a want; API-error recovery. |
| Responsive behavior | 1536px: 3 columns; 900px: 2 columns; 390px: 1 column. No horizontal page overflow. |
| Data/retry correctness | Local Postgres/Auth integration verifies full-data purchase ranking, exact totals, wishlist spending separation, account isolation, concurrent/sequential retries, conflicting keys, and rollback. |

Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:collection-ui`, and `npm run test:collection-home`. Browser tests target the local preview with `UI_TEST_BASE_URL` and the bundled `PLAYWRIGHT_MODULE_PATH`. Screenshot evidence is saved outside the repository in `/tmp/inventory-collection-home` and `/tmp/inventory-collection-search`.

Remaining scope: actual item photo uploads and wishlist-to-purchase conversion/editing/removal. No deployment or Git commit was made by this styling request.

The subsequent styling revision removes the persistent first-block/tab highlights and changes the hover accent to `#744e96`. Hover backgrounds use white text; category artwork retains its own neutral background and black symbols. Pointer hover is restricted to devices that support it.

Revision validation: lint and diff checks passed. Browser checks confirmed neutral resting backgrounds, exact purple hover backgrounds with white text, and clearing the highlight when the pointer leaves. The existing collection, Spending, wishlist, and responsive checks passed at 1536px, 900px, and 390px. Screenshots are in `/tmp/inventory-hover-update`.

The October 8 MySQL Workbench layout revision supersedes the active Collections overview/grid presentation. See [workbench.md](workbench.md) for the current layout, interaction contract, styling tokens, intentional reference adaptations, and verification results.
