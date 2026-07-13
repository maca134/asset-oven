import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveFile } from "./serve.ts";

export type AssetBuilderOptions = {
	/** Root directory local asset paths are resolved against. Defaults to `process.cwd()`. */
	root?: string;
	/** Prefix prepended to every hashed asset URL. Defaults to "" (stored without a trailing slash). */
	publicPath?: string;
	/** Output directory for built/copied assets. Defaults to a random subdir of `os.tmpdir()`. Wiped and recreated on boot. */
	cacheDir?: string;
	/** Merged into every `Bun.build` call — e.g. `minify`, `sourcemap`, `plugins`, `define`. `entrypoints`/`outdir`/`root`/`target`/`naming`/`publicPath`/`metafile` are always overridden. */
	build?: Partial<Bun.BuildConfig>;
	/** How long (ms) a failed or missing asset lookup is negative-cached before a retry is allowed. Defaults to 60000 when `process.env.NODE_ENV === "production"`, else 5000. */
	negativeCacheTtl?: number;
};

type FileEntry = { path: string; type: string };

// entrypoints Bun's bundler knows how to process; everything else is copied as-is
const BUNDLE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".css",
]);

// only these `<link>` rel values point at a servable local file we should
// hash/cache; others (canonical, preconnect, alternate, author, search, ...)
// hold routes/origins rather than files and are left untouched
const REWRITABLE_LINK_RELS = new Set([
	"stylesheet",
	"icon",
	"shortcut icon",
	"apple-touch-icon",
	"apple-touch-icon-precomposed",
	"apple-touch-startup-image",
	"mask-icon",
	"manifest",
	"preload",
	"modulepreload",
	"prefetch",
]);

function stripQuery(src: string): string {
	const idx = src.search(/[?#]/);
	return idx === -1 ? src : src.slice(0, idx);
}

async function hashFile(filePath: string): Promise<string> {
	const hasher = createHash("sha256");
	for await (const chunk of Bun.file(filePath).stream()) {
		hasher.update(chunk);
	}
	return hasher.digest("hex").slice(0, 8);
}

/**
 * Lazily builds/copies local assets referenced in server-rendered HTML into a
 * content-hashed cache directory on disk, and serves them back out.
 *
 * Public API is exactly `serveAsset` and `transformHtml`; everything else
 * (discovery via HTMLRewriter, bundling via `Bun.build`, hashing, negative
 * caching, concurrent-request dedupe) is an implementation detail.
 */
export class AssetBuilder {
	#root: string;
	#publicPath: string;
	#outdir: string;
	#build: Partial<Bun.BuildConfig>;
	#negativeCacheTtl: number;
	#rewriter: HTMLRewriter;

	// src -> hashed public URL
	#urls = new Map<string, string>();
	// hashed public URL -> file on disk
	#files = new Map<string, FileEntry>();
	// src -> in-flight build/copy, for concurrent-request dedupe
	#pending = new Map<string, Promise<string | undefined>>();
	// src -> timestamp after which a retry is allowed (Infinity = permanent)
	#failed = new Map<string, number>();

	constructor(options: AssetBuilderOptions = {}) {
		this.#root = path.resolve(options.root ?? process.cwd());
		this.#publicPath = (options.publicPath ?? "").replace(/\/$/, "");
		const isProduction = process.env.NODE_ENV === "production";
		this.#negativeCacheTtl =
			options.negativeCacheTtl ?? (isProduction ? 60_000 : 5_000);
		this.#build = options.build ?? {};

		this.#outdir = path.resolve(
			options.cacheDir ??
				path.join(os.tmpdir(), `asset-oven-${randomUUID()}`)
		);
		this.#prepareOutdir();

		this.#rewriter = new HTMLRewriter()
			.on("script[src]", {
				element: (element) => this.#onAttribute(element, "src"),
			})
			.on("link[href]", {
				element: (element) => this.#onLink(element),
			})
			.on("img[src]", {
				element: (element) => this.#onAttribute(element, "src"),
			})
			.on("img[srcset]", {
				element: (element) => this.#onSrcset(element),
			})
			.on("source[src]", {
				element: (element) => this.#onAttribute(element, "src"),
			})
			.on("source[srcset]", {
				element: (element) => this.#onSrcset(element),
			})
			.on("video[src]", {
				element: (element) => this.#onAttribute(element, "src"),
			})
			.on("audio[src]", {
				element: (element) => this.#onAttribute(element, "src"),
			});
	}

	// wiped/recreated on boot: never trust leftover files from a previous run
	#prepareOutdir() {
		try {
			fs.rmSync(this.#outdir, { recursive: true, force: true });
			fs.mkdirSync(this.#outdir, { recursive: true });
			fs.accessSync(this.#outdir, fs.constants.W_OK);
		} catch (error) {
			throw new Error(
				`[AssetBuilder] cache directory is not writable: ${this.#outdir}`,
				{ cause: error }
			);
		}
	}

	/** Serves a previously-registered hashed asset URL, or `undefined` to fall through. */
	serveAsset(req: Request): Response | undefined {
		// gated to GET/HEAD: this is a read-only cache of built assets, and
		// matching on path alone would otherwise let e.g. a POST to a hashed
		// URL return the asset body instead of falling through to the app
		if (req.method !== "GET" && req.method !== "HEAD") return undefined;

		const { pathname } = new URL(req.url);
		const file = this.#files.get(pathname);
		if (!file) return undefined;
		return serveFile(req, file.path, file.type);
	}

	/** Rewrites local asset tags in an HTML response to their hashed URLs. Caller must check Content-Type. */
	async transformHtml(res: Response): Promise<Response> {
		// buffer before rewriting: piping HTMLRewriter.transform() over a
		// lazy file-backed (Bun.file) response body through Bun.serve hangs
		// forever on Windows (observed on Bun 1.3.14). HTML entrypoints are
		// small, so materializing the body up front is cheap and sidesteps
		// the platform bug entirely.
		const buffered = new Response(await res.arrayBuffer(), res);
		return this.#rewriter.transform(buffered);
	}

	// resolves a root-relative asset path (e.g. "/client.ts") to its hashed
	// public URL, lazily building/copying and caching it on first request
	async #resolveAsset(src: string): Promise<string | undefined> {
		src = stripQuery(src);

		const cachedUrl = this.#urls.get(src);
		if (cachedUrl) return cachedUrl;

		const retryAfter = this.#failed.get(src);
		if (retryAfter !== undefined && Date.now() < retryAfter)
			return undefined;

		const pending = this.#pending.get(src);
		if (pending) return pending;

		const promise = this.#buildAsset(src).finally(() =>
			this.#pending.delete(src)
		);
		this.#pending.set(src, promise);
		return promise;
	}

	async #buildAsset(src: string): Promise<string | undefined> {
		const resolved = path.join(this.#root, src);
		if (
			resolved !== this.#root &&
			!resolved.startsWith(this.#root + path.sep)
		) {
			console.error(
				`[AssetBuilder] refusing to serve path outside root: ${src}`
			);
			// permanent: this is a static property of the path itself, not a
			// transient condition, so retrying can never succeed
			this.#failed.set(src, Infinity);
			return undefined;
		}

		if (!(await Bun.file(resolved).exists())) {
			console.error(`[AssetBuilder] asset not found: ${src}`);
			this.#failed.set(src, Date.now() + this.#negativeCacheTtl);
			return undefined;
		}

		try {
			const url = BUNDLE_EXTENSIONS.has(path.extname(resolved))
				? await this.#bundle(resolved)
				: await this.#copy(resolved);
			this.#urls.set(src, url);
			this.#failed.delete(src);
			return url;
		} catch (error) {
			console.error(
				`[AssetBuilder] failed to build asset ${src}:`,
				error
			);
			// negative-cached with a TTL (not permanent, unlike a path escape):
			// a build error can be transient (e.g. a syntax error mid-edit in
			// dev), and this backoff just keeps a persistently broken file
			// from triggering a fresh Bun.build on every single request
			this.#failed.set(src, Date.now() + this.#negativeCacheTtl);
			return undefined;
		}
	}

	async #bundle(resolved: string): Promise<string> {
		const define = {
			"process.env.NODE_ENV": JSON.stringify(
				process.env.NODE_ENV ?? "development"
			),
			...this.#build.define,
		};

		const result = await Bun.build({
			...this.#build,
			define,
			entrypoints: [resolved],
			outdir: this.#outdir,
			root: this.#root,
			target: "browser",
			// trailing slash required: Bun concatenates publicPath directly
			// onto the emitted reference (e.g. `img.src`) with no separator
			// of its own, and that reference isn't resolved against the
			// importing script's URL - it's used as the literal served path
			publicPath: this.#publicPath + "/",
			naming: {
				entry: "[name]-[hash].[ext]",
				chunk: "[name]-[hash].[ext]",
				asset: "[name]-[hash].[ext]",
			},
			// needed to reliably locate the entry output below: a CSS
			// entrypoint comes back with kind "asset" (same as a
			// referenced/nested asset), not "entry-point"
			metafile: true,
		});

		if (!result.success) {
			const message = result.logs.map((log) => log.message).join("\n");
			throw new Error(`failed to build ${resolved}:\n${message}`);
		}

		// match by basename, not by the metafile key directly: the metafile's
		// output keys aren't necessarily the same path shape as
		// `result.outputs[].path` (which is always an absolute path here,
		// since `outdir` is set)
		const entryKey = Object.entries(result.metafile?.outputs ?? {}).find(
			([, output]) => output.entryPoint
		)?.[0];
		const entryBasename = entryKey ? path.basename(entryKey) : undefined;
		const entry =
			result.outputs.find(
				(output) => path.basename(output.path) === entryBasename
			) ?? result.outputs.find((output) => output.kind === "entry-point");
		if (!entry) {
			throw new Error(`no entry output produced for ${resolved}`);
		}

		// any other outputs are local files the entry references (an
		// imported image, a CSS url(), a code-split chunk, a linked
		// sourcemap, ...) - Bun already wrote and content-hashed them under
		// #outdir, so just register them under their Bun-hashed basenames
		for (const output of result.outputs) {
			if (output === entry) continue;
			const url = `${this.#publicPath}/${path.basename(output.path)}`;
			if (!this.#files.has(url)) {
				this.#files.set(url, { path: output.path, type: output.type });
			}
		}

		const url = `${this.#publicPath}/${path.basename(entry.path)}`;
		this.#files.set(url, { path: entry.path, type: entry.type });
		return url;
	}

	// raw/media assets are copied into #outdir and served straight off disk
	// (see serveAsset), never held in memory - hash them by streaming
	// instead of buffering the whole file just to throw the bytes away
	async #copy(resolved: string): Promise<string> {
		const hash = await hashFile(resolved);
		const ext = path.extname(resolved);
		const name = path.basename(resolved, ext);
		const hashedName = `${name}-${hash}${ext}`;
		const dest = path.join(this.#outdir, hashedName);

		const source = Bun.file(resolved);
		await Bun.write(dest, source);

		const url = `${this.#publicPath}/${hashedName}`;
		this.#files.set(url, {
			path: dest,
			type: source.type || "application/octet-stream",
		});
		return url;
	}

	async #onLink(element: HTMLRewriterTypes.Element) {
		const rel = element.getAttribute("rel")?.trim().toLowerCase();
		if (!rel || !REWRITABLE_LINK_RELS.has(rel)) return;

		await this.#onAttribute(element, "href");
	}

	async #onAttribute(element: HTMLRewriterTypes.Element, attr: string) {
		const src = element.getAttribute(attr);
		if (!this.#isLocalAsset(src)) return;

		const url = await this.#resolveAsset(src);
		if (url) element.setAttribute(attr, url);
	}

	async #onSrcset(element: HTMLRewriterTypes.Element) {
		const srcset = element.getAttribute("srcset");
		if (!srcset) return;

		const candidates = srcset
			.split(",")
			.map((candidate) => candidate.trim())
			.filter(Boolean);
		const rewritten = await Promise.all(
			candidates.map(async (candidate) => {
				const [src, descriptor] = candidate.split(/\s+/, 2);
				if (!this.#isLocalAsset(src)) return candidate;

				const url = await this.#resolveAsset(src);
				if (!url) return candidate;
				return descriptor ? `${url} ${descriptor}` : url;
			})
		);

		element.setAttribute("srcset", rewritten.join(", "));
	}

	#isLocalAsset(value: string | null | undefined): value is string {
		if (!value) return false;
		if (value.startsWith("//")) return false; // protocol-relative
		if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false; // has a scheme, e.g. http:, data:, mailto:
		return value.startsWith("/");
	}
}
