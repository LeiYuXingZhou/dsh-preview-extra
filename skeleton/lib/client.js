/**
 * Hand-written DSH client bundle (no bundler, no network).
 *
 * Contract this file implements, as reverse-engineered from DSH 0.2.0-rc.2:
 *
 *  - It is a CLASSIC script: `window.__ModuleLoader__.load({ id, factory })`.
 *    Executing it only REGISTERS the factory; no module body runs yet
 *    (dsh-client-modules/lib/client.js:569-581).
 *  - `id` is the browser module identity and MUST equal package.json `name`
 *    (the host composes graph rows keyed by manifest name and the browser
 *    rejects a script that registers nothing: dsh-client-modules/lib/index.js:883-890,
 *    dsh-client-modules/lib/client.js:624-640).
 *  - `factory(require)` returns the module exports object. The Loader hands the
 *    exports to Cordis as a plugin object (same shape as the shipped bundle
 *    dsh-client-ui-brand-official/lib/client.js:42-44); Cordis applies
 *    `apply(ctx)` and waits on the service names in `inject`
 *    (cordis/src/registry.ts:9, 71-88, 318-330).
 *  - `require(...)` resolves only the frozen platform table plus modules
 *    declared in `dsh.client.external`; `require.async("./client.<name>.js")`
 *    is the only chunk mechanism and is optional (single file is fine).
 *
 * The skeleton deliberately depends on nothing but the platform seed word
 * "react/jsx-runtime", so it is safe to mount next to any composition.
 */
window.__ModuleLoader__.load({
	id: "dsh-preview-extra-skeleton",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var jsxRuntime = require("react/jsx-runtime");

		/**
		 * Keyed body slot id. A real preview plugin must use here the SAME id it
		 * passed to `ctx.documentPreviews.register({ id })`; the skeleton registers
		 * no preview, so this key never matches a file and the component never
		 * renders (the registration stays as a harmless live example).
		 */
		const SAMPLE_PREVIEW_ID = "dsh-preview-extra-skeleton/demo";
		const SERVICE_NAME = "previewExtra";
		const VERSION = "0.0.1";

		/** Minimal body component: plain React element, no JSX build step. */
		function SkeletonBody() {
			return jsxRuntime.jsx("div", {
				"data-dsh-preview-extra": "skeleton",
				style: { padding: "12px", fontFamily: "monospace" },
				children: "dsh-preview-extra skeleton is alive (v" + VERSION + ")"
			});
		}

		/**
		 * Required Cordis SERVICES (service keys, not package names). This plugin
		 * only needs the slot registry; a real preview plugin needs
		 * ["documentPreviews", "slots"] (+ "locale" when it registers dictionaries).
		 * The service provider packages belong in package.json `dsh.client.inject`,
		 * which is loading/prefetch metadata only, never apply sequencing
		 * (dsh-client-ui-workspace/lib/client.js:4101-4106).
		 */
		const inject = ["slots"];

		/**
		 * Plugin body. Everything registered through ctx.effect/ctx.provide is
		 * disposed with this fiber, so HMR reloads never leak registrations.
		 * @param ctx - client Cordis context.
		 */
		function apply(ctx) {
			console.log("[dsh-preview-extra-skeleton] client bundle applied (v" + VERSION + ")");

			// Observable #1: a DOM marker (visible in DevTools, no visual impact).
			if (typeof document !== "undefined" && document.documentElement) {
				document.documentElement.dataset.dshPreviewExtraSkeleton = VERSION;
			}

			// Observable #2: wait for the document body slot to be DECLARED, then
			// contribute one keyed body. `slots.inject` is the documented way to
			// depend on a slot declaration without assuming apply order.
			ctx.effect(
				() => ctx.slots.inject("sidebar.right.tab.document", () =>
					ctx.slots.register(
						{ name: "sidebar.right.tab.document", key: SAMPLE_PREVIEW_ID },
						SkeletonBody
					)
				),
				"dsh-preview-extra-skeleton: demo document body"
			);

			// Observable #3: a unique Cordis service other client plugins can
			// `inject: ["previewExtra"]` and `ctx.get("previewExtra")`. `ctx.provide`
			// is fiber-scoped and returns a disposer (cordis/src/reflect.ts:267-305).
			ctx.provide(SERVICE_NAME, { id: "dsh-preview-extra-skeleton", version: VERSION });
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
