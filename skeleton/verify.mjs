#!/usr/bin/env node
/**
 * verify.mjs — static + simulated contract check for a hand-written DSH client
 * plugin package. No dependencies, no network, no build step.
 *
 * Usage (from this directory):
 *
 *   & 'C:\Program Files\nodejs\node.exe' verify.mjs
 *   & 'C:\Program Files\nodejs\node.exe' verify.mjs <path-to-package-dir>
 *
 * It checks the same boundaries the real host/browser enforce, so a PASS here
 * means "the package cannot fail for a *contract* reason on load":
 *
 *  1. package.json shape — `dsh.client.platform === "web"`, string-array
 *     `inject`/`external`, and an `exports["./client"]` that resolves to an
 *     existing file (dsh-client-modules/lib/index.js:61-75, 170-181, 701-731).
 *  2. Client bundle is a classic `window.__ModuleLoader__.load({id, factory})`
 *     script whose `id` equals package.json `name`, registers exactly once and
 *     exports `apply` (dsh-client-modules/lib/client.js:569-581, 624-640).
 *  3. Every `require("...")` in the bundle is a platform seed word or a declared
 *     `dsh.client.external` entry — the build-time bundle-purity gate mirrored
 *     at runtime by dsh-client-modules/lib/client.js:697-715.
 *  4. `exports.inject` declares every Cordis service the bundle touches.
 *  5. Simulated `apply(ctx)` runs without throwing and does something
 *     observable (console log, slot registration, service provide, effect).
 *  6. Host half imports as ESM and exports `apply`.
 *
 * `node --check lib/client.js` is the out-of-process equivalent of step 2; this
 * verifier parses in-process with node:vm so it also runs under the DSH file
 * sandbox (which forbids piped child processes).
 *
 * Exit code: 0 = all checks pass, 1 = at least one failure.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_DIR = resolve(process.argv[2] ?? ROOT);

/**
 * The frozen platform module table seeded by the web shell.
 * Extracted from dsh-web-frontend/dist/assets/index-5SrrfWpU.js (single
 * minified line 126): `function rM(){return{react:Ef,"react/jsx-runtime":If,
 * "react-dom":Rf,"react-dom/client":Df,"@deepseek-ai/cordis":sf,
 * "@deepseek-ai/dsh-client-store":lh,"@deepseek-ai/dsh-client-ui-slots":hh,
 * "@deepseek-ai/dsh-client-ui-primitives":sE,"@deepseek-ai/dsh-client-ui-dockkit":XS}}`
 * (byte offset ~628285; passed to the module system as `staticModules: rM()`).
 * Named in dsh-client-modules/README.zh.md:46 as `PLATFORM_MODULES`.
 */
const PLATFORM_MODULES = Object.freeze([
	"react",
	"react/jsx-runtime",
	"react-dom",
	"react-dom/client",
	"@deepseek-ai/cordis",
	"@deepseek-ai/dsh-client-store",
	"@deepseek-ai/dsh-client-ui-slots",
	"@deepseek-ai/dsh-client-ui-primitives",
	"@deepseek-ai/dsh-client-ui-dockkit",
]);

/** Accepted package-local chunk file names (dsh-client-modules/lib/index.js:169). */
const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;

const failures = [];
let checks = 0;

function check(ok, label, detail) {
	checks += 1;
	if (!ok) failures.push(label);
	const suffix = ok ? "" : `   <-- ${detail ?? "failed"}`;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${suffix}`);
}

function section(title) {
	console.log(`\n== ${title}`);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

/** Mirror of clientExportOf() in dsh-client-modules/lib/index.js:170-181. */
function clientExportOf(exportsField) {
	if (typeof exportsField !== "object" || exportsField === null) return undefined;
	const client = exportsField["./client"];
	if (client === undefined) return undefined;
	if (typeof client === "string") return client;
	if (typeof client === "object" && client !== null && typeof client.default === "string") return client.default;
	throw new Error('exports["./client"] must be a string or an object with a string default');
}

/**
 * Remove // and block comments while preserving string/template literals, so
 * words mentioned in documentation do not look like real code.
 * @param {string} source - raw JavaScript text.
 * @returns {string} the same text with comments blanked out.
 */
function stripComments(source) {
	let out = "";
	let index = 0;
	let quote = "";
	while (index < source.length) {
		const char = source[index];
		const next = source[index + 1];
		if (quote !== "") {
			out += char;
			if (char === "\\") {
				out += next ?? "";
				index += 2;
				continue;
			}
			if (char === quote) quote = "";
			index += 1;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			out += char;
			index += 1;
			continue;
		}
		if (char === "/" && next === "/") {
			while (index < source.length && source[index] !== "\n") index += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			index += 2;
			while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
			index += 2;
			continue;
		}
		out += char;
		index += 1;
	}
	return out;
}

/** Collect every direct (synchronous) require specifier. */
function requireLiterals(code) {
	return [...new Set([...code.matchAll(/\brequire\("([^"]+)"\)/g)].map((match) => match[1]))];
}

/** Collect `require.async("...")` specifiers (chunk loads). */
function requireAsyncLiterals(code) {
	return [...new Set([...code.matchAll(/require\.async\("([^"]+)"\)/g)].map((match) => match[1]))];
}

function makeDocumentStub(domWrites) {
	const dataset = () =>
		new Proxy(
			{},
			{
				set(target, property, value) {
					domWrites.push(String(property));
					target[property] = value;
					return true;
				},
			}
		);
	const element = () => ({
		style: {},
		dataset: dataset(),
		append() {},
		remove() {},
		setAttribute(name) {
			domWrites.push(`@${String(name)}`);
		},
		getAttribute() {
			return null;
		},
		querySelectorAll() {
			return [];
		},
	});
	return {
		documentElement: element(),
		head: { append() {} },
		body: element(),
		createElement: element,
		querySelectorAll() {
			return [];
		},
	};
}

function stubModule(specifier) {
	switch (specifier) {
		case "react/jsx-runtime":
			return {
				Fragment: Symbol.for("react.fragment"),
				jsx: (type, props, key) => ({ $$jsx: true, type, props, key }),
				jsxs: (type, props, key) => ({ $$jsx: true, type, props, key }),
			};
		case "react":
			return { createElement: (type, props, ...children) => ({ $$jsx: true, type, props, children }) };
		case "react-dom":
		case "react-dom/client":
			return { createRoot: () => ({ render() {}, unmount() {} }) };
		case "@deepseek-ai/cordis":
			return { Service: class Service {} };
		default:
			// Static UI libraries: apply() must not touch them at registration time.
			return {};
	}
}

async function main() {
	console.log(`package: ${PACKAGE_DIR}\n`);

	// ---------------------------------------------------------------- package.json
	section("1. package.json / dsh.client declaration");
	const pkgPath = join(PACKAGE_DIR, "package.json");
	check(existsSync(pkgPath), "package.json exists", pkgPath);
	const pkg = readJson(pkgPath);
	check(typeof pkg.name === "string" && pkg.name.length > 0, `package name is a string ("${pkg.name}")`);
	check(pkg.type === "module", 'package type is "module" (host half is ESM)');

	const dshClient = pkg.dsh?.client;
	check(typeof dshClient === "object" && dshClient !== null, "package.json has a dsh.client object");
	check(dshClient?.platform === "web", 'dsh.client.platform === "web" (dsh-client-modules/lib/index.js:714-717)');
	const injectPkgs = dshClient?.inject;
	check(
		injectPkgs === undefined || (Array.isArray(injectPkgs) && injectPkgs.every((v) => typeof v === "string")),
		"dsh.client.inject is a string array"
	);
	const external = dshClient?.external ?? [];
	check(
		Array.isArray(external) && external.every((v) => typeof v === "string"),
		"dsh.client.external is a string array (or absent)"
	);
	check(
		dshClient?.immediately === undefined || typeof dshClient.immediately === "boolean",
		"dsh.client.immediately is boolean (or absent)"
	);
	check(dshClient?.entry === undefined, "dsh.client.entry is NOT a supported field (entry comes from exports[./client])");

	let clientRel;
	try {
		clientRel = clientExportOf(pkg.exports);
		check(typeof clientRel === "string", `exports["./client"] resolves to "${clientRel}"`);
	} catch (error) {
		check(false, 'exports["./client"] is a string or {default:string}', error.message);
	}
	const clientPath = clientRel === undefined ? undefined : join(PACKAGE_DIR, clientRel);
	check(clientPath !== undefined && existsSync(clientPath), "client bundle file exists", clientPath);
	check(
		typeof pkg.exports === "object" && pkg.exports !== null && typeof (pkg.exports["."] ?? pkg.main) !== "undefined",
		'host entry exists via exports["."] or main (needed when mounting by package name)'
	);
	const hostRel = typeof pkg.exports?.["."] === "string" ? pkg.exports["."] : pkg.main;
	const hostPath = typeof hostRel === "string" ? join(PACKAGE_DIR, hostRel) : undefined;
	check(hostPath !== undefined && existsSync(hostPath), "host half file exists", hostPath);
	const patchRel = pkg.dsh?.bundle?.patch;
	if (patchRel !== undefined) {
		const patchPath = join(PACKAGE_DIR, Array.isArray(patchRel) ? patchRel[0] : patchRel);
		check(existsSync(patchPath), "dsh.bundle.patch file exists", patchPath);
	} else {
		console.log("SKIP  dsh.bundle.patch absent (fine for manual profile-patch mounting)");
	}

	if (!clientPath || !existsSync(clientPath) || typeof pkg.name !== "string") {
		return finish();
	}

	// ---------------------------------------------------------------- syntax + registration
	section("2. Classic-script parse + bundle registration");
	const source = readFileSync(clientPath, "utf8");
	try {
		new vm.Script(source, { filename: clientPath });
		check(true, "client bundle parses as a classic script (equivalent to node --check)");
	} catch (error) {
		check(false, "client bundle parses as a classic script", error.message);
		return finish();
	}
	const code = stripComments(source);
	const opening = "window.__ModuleLoader__.load({";
	check(
		code.trimStart().startsWith(opening),
		"first statement is window.__ModuleLoader__.load({ (comments above are fine)"
	);
	check(/\)\s*;?\s*$/.test(code.trimEnd()), "last statement closes the load(...) call");

	const consoleLogs = [];
	const domWrites = [];
	const registrations = [];
	const sandbox = {
		window: {
			__ModuleLoader__: {
				load(registration) {
					registrations.push(registration);
				},
			},
		},
		document: makeDocumentStub(domWrites),
		console: {
			log: (...args) => consoleLogs.push(args),
			info: (...args) => consoleLogs.push(args),
			warn: (...args) => consoleLogs.push(args),
			error: (...args) => consoleLogs.push(args),
			debug: (...args) => consoleLogs.push(args),
		},
	};
	sandbox.globalThis = sandbox;
	try {
		vm.runInNewContext(source, sandbox, { filename: clientPath, timeout: 5000 });
		check(true, "bundle executes without throwing at registration time");
	} catch (error) {
		check(false, "bundle executes without throwing at registration time", error.message);
		return finish();
	}
	check(registrations.length === 1, `bundle registers exactly one module (got ${registrations.length})`);
	const registration = registrations[0] ?? {};
	check(
		registration.id === pkg.name,
		`load() id ("${registration.id}") equals package.json name ("${pkg.name}")`
	);
	check(typeof registration.factory === "function", "load() carries a factory function");
	check(registration.chunk === undefined, "single-resource bundle (no `chunk` field; chunks are optional)");

	if (typeof registration.factory !== "function") return finish();

	// ---------------------------------------------------------------- require graph
	section("3. require() resolves against the frozen platform table");
	const required = requireLiterals(code);
	const allowed = new Set([...PLATFORM_MODULES, ...external]);
	console.log(`required : ${JSON.stringify(required)}`);
	console.log(`declared : external=${JSON.stringify(external)}`);
	for (const specifier of required) {
		check(
			allowed.has(specifier),
			`require("${specifier}") is a platform seed word or declared external`,
			"would throw the runtime 'missed the module table' error (dsh-client-modules/lib/client.js:697-715)"
		);
	}
	const asyncs = requireAsyncLiterals(code);
	if (asyncs.length === 0) {
		console.log("SKIP  no require.async(...) — single-file bundle is valid");
	}
	for (const specifier of asyncs) {
		if (specifier.startsWith("./")) {
			const fileName = specifier.slice(2);
			check(CLIENT_CHUNK.test(fileName), `require.async("${specifier}") names a package-local chunk`);
			check(existsSync(join(dirname(clientPath), fileName)), `chunk file exists: ${fileName}`);
		} else {
			check(allowed.has(specifier), `require.async("${specifier}") is resolved by the platform table`);
		}
	}

	// ---------------------------------------------------------------- factory exports
	section("4. factory(require) exports face");
	const requireStub = (specifier) => {
		if (!allowed.has(specifier)) {
			throw new Error(`require("${specifier}") missed the module table`);
		}
		return stubModule(specifier);
	};
	let exportsObject;
	try {
		exportsObject = registration.factory(requireStub);
		check(true, "factory(require) returns without throwing");
	} catch (error) {
		check(false, "factory(require) returns without throwing", error.message);
		return finish();
	}
	check(exportsObject !== null && typeof exportsObject === "object", "factory returns an object (module.exports)");
	check(typeof exportsObject?.apply === "function", "exports.apply is a function (Cordis plugin body)");
	const declaredServices = exportsObject?.inject;
	check(
		declaredServices === undefined || (Array.isArray(declaredServices) && declaredServices.every((v) => typeof v === "string")),
		"exports.inject is a string array of Cordis SERVICE names"
	);
	if (declaredServices === undefined) {
		console.log("SKIP  exports.inject absent (no waitable services)");
	} else {
		for (const service of declaredServices) {
			check(typeof service === "string" && service.length > 0, `service name "${service}" is a non-empty string`);
		}
		console.log(`INFO  exports.inject = ${JSON.stringify(declaredServices)}`);
	}

	// Static cross-check: a bundle that touches ctx.<service> must inject it.
	const touchedServices = [];
	if (/\bctx\.slots\b/.test(code)) touchedServices.push("slots");
	if (/\bctx\.locale\b/.test(code)) touchedServices.push("locale");
	if (/\bctx\.documentPreviews\b/.test(code)) touchedServices.push("documentPreviews");
	if (/\bctx\.modules\b/.test(code)) touchedServices.push("modules");
	for (const service of touchedServices) {
		check(
			Array.isArray(declaredServices) && declaredServices.includes(service),
			`bundle uses ctx.${service} and exports.inject lists "${service}"`,
			"Cordis will not wait for the service, so apply may run too early"
		);
	}

	// ---------------------------------------------------------------- apply simulation
	section("5. Simulated apply(ctx)");
	const log = { effects: [], registered: [], provided: [], injected: [] };
	const fakeCtx = {
		logger: {
			info() {},
			warn() {},
			error() {},
			debug() {},
		},
		effect(fn, label) {
			log.effects.push(label ?? "(unnamed)");
			const disposer = fn();
			return () => {
				if (typeof disposer === "function") disposer();
			};
		},
		slots: {
			inject(key, callback) {
				log.injected.push(key);
				const disposer = callback();
				return () => {
					if (typeof disposer === "function") disposer();
				};
			},
			register(options, component) {
				log.registered.push({ options, component });
				return () => {};
			},
			installLocale() {},
		},
		provide(name, value) {
			log.provided.push({ name, value });
			return () => {};
		},
		reflect: {
			provide(name, value) {
				log.provided.push({ name, value });
				return () => {};
			},
		},
	};
	try {
		exportsObject.apply(fakeCtx);
		check(true, "apply(ctx) runs without throwing");
	} catch (error) {
		check(false, "apply(ctx) runs without throwing", error.stack ?? error.message);
	}
	const observable =
		consoleLogs.length +
		domWrites.length +
		log.effects.length +
		log.registered.length +
		log.provided.length +
		log.injected.length;
	check(observable > 0, "apply(ctx) performs at least one observable action (log/DOM/effect/slot wait/service)");
	if (consoleLogs.length > 0) {
		console.log("PASS  apply(ctx) logs a line (visible in the browser console)");
	} else {
		console.log("SKIP  apply(ctx) logs nothing (fine if it only registers slots/services/DOM markers)");
	}
	if (log.provided.length > 0) {
		const name = log.provided[0].name;
		check(typeof name === "string" && name.length > 0, `provided service name is valid ("${name}")`);
	}
	for (const entry of log.registered) {
		check(typeof entry.options?.name === "string", `slot registration names a parent slot ("${entry.options?.name}")`);
		check(
			typeof entry.component === "function",
			`slot registration for "${entry.options?.name}" carries a component function`
		);
		if (typeof entry.component === "function") {
			try {
				const rendered = entry.component({});
				check(rendered !== undefined && rendered !== null, "registered component renders a non-null element");
			} catch (error) {
				check(false, "registered component renders without throwing", error.message);
			}
		}
	}
	console.log(
		`INFO  simulated: ${log.effects.length} effect(s), ${log.injected.length} slot.inject wait(s), ` +
			`${log.registered.length} slot registration(s), ${log.provided.length} provided service(s)`
	);

	// ---------------------------------------------------------------- host half
	section("6. Host half imports and applies as a no-op");
	if (hostPath && existsSync(hostPath)) {
		try {
			const hostModule = await import(pathToFileURL(hostPath).href);
			check(true, "host half imports as ESM (parse + evaluation)");
			check(typeof hostModule.apply === "function", "host half exports apply (Cordis host plugin)");
		} catch (error) {
			check(false, "host half imports as ESM", error.message);
		}
	}

	finish();
}

function finish() {
	console.log(`\n${checks - failures.length}/${checks} checks passed`);
	if (failures.length > 0) {
		console.log(`FAILED checks:\n  - ${failures.join("\n  - ")}`);
		process.exitCode = 1;
		return;
	}
	console.log("OK — package satisfies the hand-written client-module contract.");
}

main().catch((error) => {
	console.error("verifier crashed:", error);
	process.exitCode = 1;
});
