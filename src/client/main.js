/**
 * Browser half of dsh-preview-extra.
 *
 * Registers extra document-preview implementations into the right Sidebar's
 * document tab. The contract (DSH 0.2.0-rc.2,
 * `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`):
 *
 *  - `ctx.documentPreviews.register(def)` claims file suffixes and names the
 *    loading mode; `loading: 'bytes-complete'` makes the tab system read the
 *    whole file and hand the body `content = { kind: 'bytes', data }`.
 *  - the body must also be registered into the keyed child slot
 *    `sidebar.right.tab.document` with the SAME id, so the framework can render
 *    it next to every other implementation (the builtin image/PDF bodies work
 *    exactly this way).
 *  - `sidebar.right.pane.tab.title` is owned by the documentpreview package's
 *    chip title; our bodies live inside that chip, so no title contribution is
 *    needed.
 *
 * Hard dependency: only `slots` (the browser slot registry). `documentPreviews`
 * and `locale` are waited for with a child scope instead of being declared in
 * `inject`, because a missing service in `inject` leaves this fiber PENDING and
 * DSH's page boot is all-or-nothing (it would fail the whole page when the
 * documentpreview row is disabled). With a child scope the plugin simply stays
 * dormant while that row is off.
 *
 * `react`, `jsxRuntime` and `primitives` are declared by the bundle factory
 * (scripts/build-client.mjs); UI modules reference them as free variables.
 */
import {
  previewLocales,
  previewDefinitions,
  previewCss,
  previewBodies,
} from '../ui/views.js';

/** Locale namespace owned by this plugin. */
const LOCALE_NS = 'dshPreviewExtra';

/** Cordis services that must exist before `apply` runs. */
const inject = ['slots'];

/** Append the plugin's stylesheet once per page; return a disposer. */
function installStyles() {
  if (typeof document === 'undefined' || !document.head || typeof document.createElement !== 'function') {
    return undefined;
  }
  try {
    const existing =
      typeof document.querySelector === 'function'
        ? document.querySelector('style[data-dsh-preview-extra]')
        : null;
    if (existing !== null) return undefined;
    const style = document.createElement('style');
    style.dataset.dshPreviewExtra = '';
    style.textContent = previewCss;
    if (typeof document.head.appendChild !== 'function') return undefined;
    document.head.appendChild(style);
    return () => {
      if (typeof style.remove === 'function') style.remove();
    };
  } catch {
    return undefined;
  }
}

/**
 * Register the preview metadata and keyed bodies inside a child scope that
 * exists only while `documentPreviews` + `locale` are provided.
 * @param scope - child Cordis context carrying documentPreviews and locale.
 */
function registerPreviews(scope) {
  const t = scope.locale.bind(LOCALE_NS);
  scope.effect(() => scope.locale.register(LOCALE_NS, previewLocales), 'dsh-preview-extra: dictionaries');

  for (const definition of previewDefinitions) {
    const body = previewBodies[definition.id];
    if (body === undefined) continue;

    const metadata = {
      id: definition.id,
      extensions: definition.extensions,
      priority: 'extension',
      title: () => t(definition.titleKey),
      loading: definition.loading ?? 'bytes-complete',
      wrap: definition.wrap === true,
    };
    if (definition.binaryExtensions !== undefined) {
      metadata.binaryExtensions = definition.binaryExtensions;
    }

    scope.effect(
      () => scope.documentPreviews.register(metadata),
      `dsh-preview-extra: preview ${definition.id}`
    );

    scope.effect(
      () =>
        scope.slots.inject('sidebar.right.tab.document', () =>
          scope.slots.register(
            {
              name: 'sidebar.right.tab.document',
              key: definition.id,
              locale: LOCALE_NS,
            },
            body
          )
        ),
      `dsh-preview-extra: body ${definition.id}`
    );
  }
}

/**
 * @param ctx - client Cordis context (at least `slots` present).
 */
function apply(ctx) {
  try {
    ctx.effect(() => installStyles(), 'dsh-preview-extra: stylesheet');
  } catch {
    // A missing effect()/DOM must never take the whole page boot down.
  }
  const run = (scope) => {
    try {
      registerPreviews(scope);
    } catch (error) {
      console.error('[dsh-preview-extra] preview registration failed:', error);
    }
  };
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['documentPreviews', 'locale'], (child) => run(child));
    } else {
      run(ctx);
    }
  } catch (error) {
    console.error('[dsh-preview-extra] service wait failed:', error);
  }
}

export { apply, inject };

