/**
 * Host half of dsh-preview-extra.
 *
 * Every preview this plugin adds is browser-side: the right Sidebar's document
 * tab is a client tab type owned by
 * `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`, and extra preview
 * implementations register themselves into that tab's keyed document slot from
 * the browser bundle. The Node half therefore has nothing to mount or serve; it
 * exists only so the Loader has a row to enable, which is also what makes the
 * client-modules scanner publish `lib/client.js` at `/plugins/dsh-preview-extra`.
 */

/** Host plugin body: the whole feature lives in the browser export. */
export function apply() {}
