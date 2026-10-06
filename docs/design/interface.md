# Sign-in and collection design

Reference: collection-concept.png and signin-concept.png, generated with built-in Image Gen on October 2, 2026.

Direction: warm off-white (#f7f7f2), white surfaces, forest (#254637), charcoal (#242824), muted text (#6b716c), fine borders (#dfe3dc). Modern sans UI with an editorial Georgia serif headline on the sign-in panel. 8px control radii, 12px collection corners, 16px grid gaps. 240px sidebar, 48px main gutters, 3 columns on desktop, 2 on tablet, 1 on narrow phones. Restrained outline icons share 1.5–1.8px strokes.

Primary copy follows the concepts: Inventory; Welcome back.; Your collection is right where you left it.; Make room for what matters.; Your collection; A little more intention in the things you own.; Add item; Search your collection; Recently added; Price not recorded.

Implement functional variants in the same system: sign-up, confirmation notice, forgot/reset password, session loading, empty/error/filter states, pagination, grid/list, add-item dialog, and item-detail drawer. Use native dialog elements for focus containment and Escape behavior. Currency selection is offered before a new profile is created.

Necessary adaptations: real account/email and real records replace reference fixtures; generated sample data is never loaded into an actual account. Category line icons are reusable SVGs rather than photos of possessions we have not seen. The collection stays free of nonfunctional wishlist/subscription navigation. Groceries appears because it is a real seeded category. Unknown purchase dates remain unknown. Detail panels show exact recorded costs, not inferred valuations. Auth callback errors have a retry path.

Image prompts: full desktop collection and sign-in surfaces, warm neutral/forest palette, native-code UI controls, complete navigation/forms, and category artwork without product photos. No marketing metrics, unrelated navigation, or invented user possessions. These references are a design specification, not rendered application screenshots.
