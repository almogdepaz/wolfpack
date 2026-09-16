/** Stable authoring entry point published as wolfpack-bridge/extensions. */
export { EXTENSION_LIFECYCLE_RULES_VERSION, MAX_RETAINED_CONTEXT_VIEWS_PER_SCOPE } from "./sdk.ts";
export type { ContextViewController, ContextViewContribution, ExtensionRegistration, ExtensionRegistrationHost, ExtensionViewContext, } from "./sdk.ts";
export { LAYOUT_CONTRACT_VERSION, MAX_LAYOUT_PANES, MAX_LAYOUT_TRACKS, LayoutValidationError, equalGridLayout, leadStackLayout, validateTerminalLayout, verticalStackLayout, } from "./layout-contract.ts";
export type { LayoutContext, LayoutTrack, PanePlacement, TerminalLayout, TerminalLayoutContribution, TerminalPaneReference, } from "./layout-contract.ts";
