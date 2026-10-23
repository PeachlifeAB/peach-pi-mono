/**
 * API-coverage reference. **Nothing here is registered.**
 *
 * These declarations exist to exercise every `thinkingFormat` value, every `Api`
 * value, and the legacy `oauth` callback surface, so the shapes stay visible and
 * keep typechecking against the installed `@earendil-works/*` declarations. They
 * describe a fictional gateway; registering them would put models pointing at
 * endpoints that do not exist into the user's model picker.
 *
 * They are typechecked but never imported by `index.ts`. If pi changes one of
 * these types, the typecheck gate breaks here — which is the point of keeping
 * them.
 *
 * This lives under `test/` rather than `src/` because it is a maintainer safety
 * net, not product code: it never executes, and shipping it would put fictional
 * gateway fixtures into every installed copy. The root `tsconfig.base.json`
 * covers `test/`, so the canary works identically here.
 *
 * Split by surface so each file stays under the harness line policy:
 *   compat.ts — request-shape and thinking-format compat flags
 *   models.ts — one model per `Api` value
 *   auth.ts   — legacy OAuth callback surface and static headers
 */

export { exampleHeaders, exampleOAuthConfig } from "./auth.ts";
export { exampleBaseCompat, exampleThinkingVariants } from "./compat.ts";
export { examplePerApiModels } from "./models.ts";
