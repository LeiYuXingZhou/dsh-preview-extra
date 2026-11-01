/**
 * Host half of the skeleton plugin.
 *
 * The whole feature lives in the browser bundle (`lib/client.js`); this module
 * exists only so the Cordis Loader has an importable module to mount. Two
 * reasons it is required rather than optional:
 *
 *  1. a Loader row imports its `name` specifier — that import must resolve to a
 *     package that has `package.json`, because `dsh-client-modules` locates the
 *     browser declaration by walking up to the nearest package.json
 *     (dsh-client-modules/lib/index.js:743-790);
 *  2. importing the client bundle on the host is not possible: it references
 *     `window.__ModuleLoader__` at top level.
 *
 * A no-op body is the supported shape; the shipped
 * @deepseek-ai/dsh-cordis-client-runner does exactly this
 * (dsh-cordis-client-runner/lib/index.js:1-11).
 */

/** Host plugin body: intentionally empty — no services, routes or tools. */
export function apply() {}
