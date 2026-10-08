# Inventory workbench design and verification

The current styling follows the user's MySQL Workbench screenshot and requested interaction: collections on the left, items in the bottom pane, and clicked items in the large black panel. This supersedes the collection overview/grid styling in `collections.md` for the active Collections screen.

The built-in ImageGen concept is [workbench-concept.png](workbench-concept.png). Its brief requested the complete dark desktop workspace, existing navigation, category tree, selected item information, bottom result rows, and the existing search/sort/add controls. Illustrative names and amounts in the concept are not application seed data.

## Implementation

- `collection-screen.tsx` retains authenticated loading, collection request/debounce state, sorting, pagination, item creation, submission retry keys, sign-out, Spending, and Future Wants. Collections now opens directly into the workbench.
- `collection-workbench.tsx` composes the collection sidebar, inline inspector, bottom item register, toolbar, and status bar. Optional overview counts do not block collection access when unavailable.
- `item-details.tsx` provides shared detail content for the inline collection inspector and the existing Spending/wishlist drawers. Switching items aborts obsolete requests; loading and retry errors stay in the inspector.
- `collection-list.tsx` provides accessible selectable rows containing item, collection, cost, and acquisition date. Missing values remain explicit in accessible labels.
- Dark styling is scoped to `workbench-shell`. Colors: black inspector `#151515`, canvas `#202123`, sidebar `#242528`, results `#29292c`, borders `#44454b`, selected rows `#3b485d`, and blue focus/selection accents. The sign-in screen retains its existing styling.
- UI chrome uses Arial/Helvetica; fields, the collection tree, and result rows use the system monospace stack. Panels scroll independently; no fabricated SQL controls are added.

## Fidelity ledger

The supplied screenshot and generated concept were compared directly with final Playwright screenshots using `view_image`. Desktop captures use the native concept viewport, 1536 × 1024. Additional checks use 900 × 1000, 1440 × 1000, and 390 × 844.

| Comparison | Reference and rendered evidence | Outcome |
| --- | --- | --- |
| Structure | Collection rail left, large black inspector above, item rows below | Implemented as a full-height desktop split workspace. |
| Palette | Charcoal chrome, black content, subtle blue-grey selected states | Exact flat tokens; repaired inherited lavender Spending headers and reversed-looking dark chart fill. |
| Typography | Sans-serif navigation and item title; monospace inventory fields and rows | Explicit sizes throughout; compact readable controls and metadata. |
| Information | Item details and purchase records replace the screenshot's SQL editor | Real API data; item description, transaction dates, original currency amounts, store, and transaction notes are displayed when available. |
| Controls and copy | Existing Collections, Spending, Future Wants, Sign out, Add item, search, and sorting | Labels retained. Existing Recently added, Name A–Z, and Purchase date sort meanings retained. |
| Selection | Clicked row highlighted and details appear in the black panel | Verified selection, replacement, close, failure/retry, and switching before an older response arrives. |
| Spacing | Narrow panel dividers, square/near-square controls, compact result rows | Corrected inherited status-count padding/border and adjusted result columns. |
| Mobile | Same information and controls within a narrow viewport | Sidebar becomes a category select at 500px and below; rows use two lines, inspector scrolls vertically; no horizontal page overflow. |

Intentional adaptations: the app keeps its existing SVG icon family, compact UI density, real category set, existing Add item flow, and actual API data. Category/state metadata is plain text rather than decorative badges. Cost appears under each purchase record rather than duplicating a total that might combine currencies. Empty details have a clear selection prompt. Phone layout uses a category selector instead of a permanently visible sidebar. The generated concept contains no production image assets; the UI is code-native. No material unresolved mismatch remains with the user's requested workbench layout and behavior.

Above-the-fold copy comparison: navigation and product labels match. Add item is preserved from the existing app even though ImageGen omitted it. Inventory-specific labels replace SQL actions. Counts, names, dates, amounts, stores, and notes come from the account; browser screenshots use isolated fixtures. No unrelated metrics or marketing content was added.

## QA report

Environment: `http://localhost:3000`. The Browser plugin/skill is absent. The available in-app browser opened the actual application and showed sign-in. Authenticated checks use the existing Playwright/Chrome fixture workflow, with all account/Auth/API requests mocked. Chrome requires execution outside the shell sandbox. No new browser dependencies were installed.

Flow: app opens → select collection → select item row → black panel renders the selected item's details and purchase information.

| Check | Result |
| --- | --- |
| Page identity | Inventory at the intended localhost origin. |
| Nonblank | Sidebar, inspector, toolbar, and item register render. |
| Framework overlay | No runtime-error overlay in browser checks. |
| Console health | No relevant browser errors/warnings; deliberate fixture HTTP 500s are expected recovery cases. |
| Screenshot evidence | Desktop, tablet, phone, Spending, and Future Wants captures reviewed. |
| Interaction proof | Collection search/filter; selected rows; inline replacement/close; item error retry; obsolete response handling; category-aware Add item; debounced search, edit/undo, stale response handling, sort, pagination, empty/error/retry; month navigation; wishlist save/retry/reload and pagination. |
| Responsive | 1536, 1440, 900, and 390px widths; no horizontal page overflow. |
| Code checks | TypeScript, ESLint, production build, and all 34 unit/integration tests pass. Both existing browser scripts pass after adapting their expectations to the new layout. |

Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:collection-home`, `npm run test:collection-ui`, and `git diff --check`. Browser scripts use `UI_TEST_BASE_URL=http://localhost:3000` and the bundled Playwright installation. Build and rendering were verified separately.

The requested layout and interactions were faithfully verified against the supplied screenshot and generated design direction. Remaining untested scope: a live authenticated account, browsers other than Chrome, and production deployment. This change adds no database or authentication behavior.

## Future Wants workbench extension

Future Wants now uses the same sidebar, inspector, pagination, dark panels, field typography, and selection styling as Collections. These repeated regions are shared in `workbench-panels.tsx`. The current shared brand and accent tokens are inherited by both screens.

Wishlist rows show item, collection, estimated price, and priority. Clicking a row highlights it and displays its estimate, priority, description, and product link in the black inspector. Unrecorded acquisition dates are omitted for wishlist entries. Existing categories, including Groceries, remain available to wants; owned collection counts are not shown as wishlist counts. On phones the sidebar becomes the same collection selector and each item occupies two lines.

Add want now defaults to the selected collection. Its request-key reuse and retry behavior are preserved. Search, collection filtering, and priority/newest/name sorting use validated `/wants` query parameters. The service applies filters to the entire account wishlist before counting, sorting, and pagination. Owner predicates, wishlist-only selection, archived-item exclusion, RLS transaction context, and the original default priority order are retained. No schema, grants, authentication, or creation behavior changed.

The existing Collections implementation served as the design reference; no new bitmap concept or production asset was needed to extend this design system. Final screenshots were inspected with `view_image` at 1536 × 1024, 900 × 1000, and 390 × 844. Comparison points: matching left rail and split-pane proportions, matching charcoal/black palette and current accent, matching control and field type scales, matching dividers/spacing, selected row → inline detail behavior, and phone category/row adaptation. The code-native labels are intentionally changed to Future Wants, estimated price, and priority. No material layout mismatch remains.

| QA check | Result |
| --- | --- |
| Environment | Local dev app `http://localhost:3000`; final production captures at temporary `http://localhost:3002`. Browser plugin/skill absent; authenticated Playwright fixtures used. The existing in-app browser displayed sign-in. |
| Page identity/content | Inventory at the intended local origin, one app header, visible wishlist workspace and item content. |
| Overlay/console | No framework error overlay or relevant console/page errors. The production capture also excludes development tools obscuring controls. |
| Interaction | Inline wishlist selection and close; estimate, priority, notes, product link; search finds a want beyond the first page; sidebar and phone category selection; sorting; category-defaulted Add want; save/lost-response retry; reload; pagination; empty result and error/retry recovery. |
| Responsive | Desktop, tablet, phone screenshots reviewed; no horizontal page overflow. |
| Database | Complete-set filtering/counting before paging; priority, name, and newest sorting; literal percent search; zero/missing estimates; account isolation. |
| Regression | Existing collection debounce, rapid edit/undo, pagination, sorting/filtering, stale-response handling, and error recovery browser suite passes. |
| Code | Production build, TypeScript, ESLint, all 36 unit/integration tests, both browser suites, and whitespace checks pass. |

Final screenshot evidence is retained outside the repository in the task's visualization directory as `future-wants-workbench-desktop.png` and `future-wants-workbench-mobile.png`. Commands are the same as the earlier QA record; the final browser runs target the temporary production preview. Remaining untested scope: live authenticated account data and other browser engines.
