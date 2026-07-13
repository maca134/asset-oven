import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { AssetBuilder } from "./core.ts";

// fixture roots must live under the project tree (not os.tmpdir()) so that
// node_modules resolution (react, tailwindcss, ...) can walk up and find them
const TMP_ROOT = path.join(import.meta.dir, "..", ".test-tmp");

let root: string;

beforeEach(() => {
	mkdirSync(TMP_ROOT, { recursive: true });
	root = mkdtempSync(path.join(TMP_ROOT, "core-"));
});

afterAll(() => {
	rmSync(TMP_ROOT, { recursive: true, force: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	setSystemTime(); // undo any time travel from the negative-cache-backoff tests
});

function write(name: string, content: string | Buffer): void {
	writeFileSync(path.join(root, name), content);
}

function makeBuilder(
	options?: Partial<ConstructorParameters<typeof AssetBuilder>[0]>
): AssetBuilder {
	return new AssetBuilder({ root, publicPath: "/assets", ...options });
}

async function render(
	builder: AssetBuilder,
	bodyHtml: string
): Promise<string> {
	const res = new Response(
		`<!doctype html><html><body>${bodyHtml}</body></html>`,
		{
			headers: { "Content-Type": "text/html" },
		}
	);
	return (await builder.transformHtml(res)).text();
}

function fetchAsset(
	builder: AssetBuilder,
	url: string,
	init?: RequestInit
): Response {
	const res = builder.serveAsset(
		new Request(new URL(url, "http://x").toString(), init)
	);
	if (!res) throw new Error(`serveAsset returned undefined for ${url}`);
	return res;
}

function extractAttr(html: string, tagAttrPattern: RegExp): string {
	const match = tagAttrPattern.exec(html);
	if (!match?.[1])
		throw new Error(`no match for ${tagAttrPattern} in:\n${html}`);
	return match[1];
}

describe("basic rewriting (happy path)", () => {
	test("rewrites a <script src> and serves the bundled js", async () => {
		write("client.ts", `console.log("hi");\n`);
		const builder = makeBuilder();

		const html = await render(
			builder,
			`<script src="/client.ts" type="module"></script>`
		);
		const url = extractAttr(html, /<script[^>]*\ssrc="([^"]+)"/);
		expect(url).toMatch(/^\/assets\/client-[0-9a-z]+\.js$/);

		const res = fetchAsset(builder, url);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toMatch(/javascript/);
		expect(await res.text()).toContain('console.log("hi")');
	});

	test("rewrites an <img src> and serves the copied file with its content-type", async () => {
		write(
			"logo.png",
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
		);
		const builder = makeBuilder();

		const html = await render(
			builder,
			`<img src="/logo.png" alt="logo" />`
		);
		const url = extractAttr(html, /<img[^>]*\ssrc="([^"]+)"/);
		expect(url).toMatch(/^\/assets\/logo-[0-9a-f]{8}\.png$/);

		const res = fetchAsset(builder, url);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toMatch(/image\/png/);
	});
});

describe("content hashing", () => {
	test("streamed hashing of a copied asset matches a plain sha256 of the file", async () => {
		const content = "raw file content for hashing test\n".repeat(50);
		write("notes.txt", content);
		const builder = makeBuilder();

		const html = await render(
			builder,
			`<source src="/notes.txt"></source>`
		);
		const url = extractAttr(html, /<source[^>]*\ssrc="([^"]+)"/);
		const expectedHash = createHash("sha256")
			.update(content)
			.digest("hex")
			.slice(0, 8);
		expect(url).toBe(`/assets/notes-${expectedHash}.txt`);

		const res = fetchAsset(builder, url);
		expect(await res.text()).toBe(content);
	});
});

describe("nested asset bundling", () => {
	test("resolves a JS-imported image to its own hashed asset url", async () => {
		const pngBytes = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03,
		]);
		write("logo.png", pngBytes);
		write(
			"client.ts",
			`import img from "./logo.png";\nconsole.log(img);\n`
		);
		const builder = makeBuilder();

		const html = await render(
			builder,
			`<script src="/client.ts" type="module"></script>`
		);
		const scriptUrl = extractAttr(html, /<script[^>]*\ssrc="([^"]+)"/);
		const scriptBody = await fetchAsset(builder, scriptUrl).text();
		const imgUrl = extractAttr(scriptBody, /"(\/assets\/logo-[^"]+\.png)"/);

		const imgRes = fetchAsset(builder, imgUrl);
		expect(imgRes.status).toBe(200);
		expect(imgRes.headers.get("Content-Type")).toMatch(/image\/png/);
		expect(new Uint8Array(await imgRes.arrayBuffer())).toEqual(
			new Uint8Array(pngBytes)
		);
	});

	test("resolves a CSS url() background image to its own hashed asset url", async () => {
		// large enough that Bun's bundler won't inline it as a data: URI instead
		// of emitting a separate hashed output
		const pngBytes = Buffer.alloc(300_000, 0xab);
		pngBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
		write("logo.png", pngBytes);
		write("styles.css", `.logo { background: url("./logo.png"); }\n`);
		const builder = makeBuilder();

		const html = await render(
			builder,
			`<link rel="stylesheet" href="/styles.css" />`
		);
		const cssUrl = extractAttr(html, /<link[^>]*\shref="([^"]+)"/);
		expect(cssUrl).toMatch(/^\/assets\/styles-[0-9a-z]+\.css$/);

		const cssRes = fetchAsset(builder, cssUrl);
		expect(cssRes.headers.get("Content-Type")).toMatch(/text\/css/);
		const cssBody = await cssRes.text();
		const imgUrl = extractAttr(
			cssBody,
			/url\("(\/assets\/logo-[^"]+\.png)"\)/
		);

		const imgRes = fetchAsset(builder, imgUrl);
		expect(imgRes.status).toBe(200);
		expect(imgRes.headers.get("Content-Type")).toMatch(/image\/png/);
		expect((await imgRes.arrayBuffer()).byteLength).toBe(
			pngBytes.byteLength
		);
	});
});

describe("srcset rewriting", () => {
	test("rewrites local candidates, preserves descriptors, and leaves remote candidates untouched", async () => {
		write("small.png", Buffer.from("small-image-bytes"));
		write("large.png", Buffer.from("large-image-bytes"));
		const builder = makeBuilder();

		const html = await render(
			builder,
			`<img src="/small.png" srcset="/small.png 1x, /large.png 2x, https://cdn.example.com/remote.png 3x" alt="" />`
		);
		const srcset = extractAttr(html, /<img[^>]*\ssrcset="([^"]+)"/);
		const candidates = srcset.split(",").map((s) => s.trim());

		expect(candidates).toHaveLength(3);
		expect(candidates[0]).toMatch(/^\/assets\/small-[0-9a-f]{8}\.png 1x$/);
		expect(candidates[1]).toMatch(/^\/assets\/large-[0-9a-f]{8}\.png 2x$/);
		expect(candidates[2]).toBe("https://cdn.example.com/remote.png 3x");
	});
});

describe("passthrough behavior", () => {
	test("leaves absolute, protocol-relative, and data: sources untouched", async () => {
		const builder = makeBuilder();
		const html = await render(
			builder,
			`<img src="https://cdn.example.com/a.png" alt="" />` +
				`<img src="//cdn.example.com/b.png" alt="" />` +
				`<img src="data:image/png;base64,AAAA" alt="" />`
		);

		expect(html).toContain('src="https://cdn.example.com/a.png"');
		expect(html).toContain('src="//cdn.example.com/b.png"');
		expect(html).toContain('src="data:image/png;base64,AAAA"');
	});
});

describe("query string / fragment stripping", () => {
	test("cache-busted references to the same file resolve to one shared hashed url", async () => {
		write("client.ts", `export const x = 1;\n`);
		const builder = makeBuilder();

		const html = await render(
			builder,
			`<script src="/client.ts?v=2" type="module"></script>` +
				`<script src="/client.ts?v=3#frag"></script>`
		);
		const urls = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(
			(m) => m[1]
		);
		expect(urls).toHaveLength(2);
		expect(urls[0]).toBe(urls[1]);
		expect(urls[0]).toMatch(/^\/assets\/client-[0-9a-z]+\.js$/);
	});
});

describe("path-escape rejection", () => {
	test("a path-escape attempt is rejected and stays permanently rejected on later requests", async () => {
		const builder = makeBuilder();

		const first = await render(
			builder,
			`<img src="/../outside.png" alt="" />`
		);
		const second = await render(
			builder,
			`<img src="/../outside.png" alt="" />`
		);

		expect(first).toContain('src="/../outside.png"');
		expect(second).toContain('src="/../outside.png"');
	});
});

describe("missing-asset retry", () => {
	test("a not-found asset is negative-cached and retried only after the TTL elapses", async () => {
		const builder = makeBuilder({ negativeCacheTtl: 5_000 });

		const before = await render(builder, `<img src="/late.png" alt="" />`);
		expect(before).toContain('src="/late.png"'); // left untouched: not found yet

		write("late.png", "fake-png-bytes");

		const stillWithinTtl = await render(
			builder,
			`<img src="/late.png" alt="" />`
		);
		expect(stillWithinTtl).toContain('src="/late.png"'); // still within the negative-cache window

		setSystemTime(new Date(Date.now() + 10_000)); // past the 5s negativeCacheTtl

		const after = await render(builder, `<img src="/late.png" alt="" />`);
		expect(after).toMatch(/src="\/assets\/late-[0-9a-f]{8}\.png"/);
	});
});

describe("build-error retry backoff", () => {
	test("a persistently broken build is not retried within the backoff window, but is retried after it", async () => {
		write("client.ts", "function broken() {\n"); // unclosed brace: fails Bun.build
		const builder = makeBuilder({ negativeCacheTtl: 5_000 });
		const buildSpy = spyOn(Bun, "build");

		try {
			const first = await render(
				builder,
				`<script src="/client.ts" type="module"></script>`
			);
			expect(first).toContain('src="/client.ts"'); // left untouched: build failed
			expect(buildSpy).toHaveBeenCalledTimes(1);

			const second = await render(
				builder,
				`<script src="/client.ts" type="module"></script>`
			);
			expect(second).toContain('src="/client.ts"');
			expect(buildSpy).toHaveBeenCalledTimes(1); // still within the backoff window: no retry

			setSystemTime(new Date(Date.now() + 10_000)); // past the 5s negativeCacheTtl

			const third = await render(
				builder,
				`<script src="/client.ts" type="module"></script>`
			);
			expect(third).toContain('src="/client.ts"'); // still broken, but retried
			expect(buildSpy).toHaveBeenCalledTimes(2);
		} finally {
			buildSpy.mockRestore();
		}
	});
});

describe("concurrent dedupe", () => {
	test("concurrent requests for the same not-yet-built asset all converge on one rewritten url", async () => {
		write("client.ts", `export const x = "concurrent";\n`);
		const builder = makeBuilder();

		const htmls = await Promise.all(
			Array.from({ length: 10 }, () =>
				render(
					builder,
					`<script src="/client.ts" type="module"></script>`
				)
			)
		);

		const urls = new Set(
			htmls.map((html) =>
				extractAttr(html, /<script[^>]*\ssrc="([^"]+)"/)
			)
		);
		expect(urls.size).toBe(1);
		expect([...urls][0]).toMatch(/^\/assets\/client-[0-9a-z]+\.js$/);
	});
});

describe("method gating on the asset cache", () => {
	test("a POST to a hashed asset url falls through (serveAsset returns undefined)", async () => {
		write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		const builder = makeBuilder();
		const html = await render(builder, `<img src="/logo.png" alt="" />`);
		const url = extractAttr(html, /<img[^>]*\ssrc="([^"]+)"/);

		const res = builder.serveAsset(
			new Request(new URL(url, "http://x").toString(), { method: "POST" })
		);
		expect(res).toBeUndefined();
	});

	test("a HEAD request for a hashed asset url returns the headers with no body", async () => {
		write(
			"logo.png",
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
		);
		const builder = makeBuilder();
		const html = await render(builder, `<img src="/logo.png" alt="" />`);
		const url = extractAttr(html, /<img[^>]*\ssrc="([^"]+)"/);

		const res = fetchAsset(builder, url, { method: "HEAD" });
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toMatch(/image\/png/);
		expect(res.headers.get("Content-Length")).toBe("8");
		expect((await res.arrayBuffer()).byteLength).toBe(0);
	});
});

describe("caching", () => {
	test("reuses the cached hashed url on later requests without rebuilding from disk", async () => {
		write("client.ts", `console.log("v1");\n`);
		const builder = makeBuilder();

		const html1 = await render(
			builder,
			`<script src="/client.ts" type="module"></script>`
		);
		const url1 = extractAttr(html1, /<script[^>]*\ssrc="([^"]+)"/);

		rmSync(path.join(root, "client.ts")); // if a rebuild were attempted, it would now fail

		const html2 = await render(
			builder,
			`<script src="/client.ts" type="module"></script>`
		);
		const url2 = extractAttr(html2, /<script[^>]*\ssrc="([^"]+)"/);
		expect(url2).toBe(url1);

		const res = fetchAsset(builder, url1);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('console.log("v1")');
	});

	test("a copied (raw) asset keeps serving under its hashed url after the source is deleted", async () => {
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
		write("logo.png", bytes);
		const builder = makeBuilder();

		const html = await render(builder, `<img src="/logo.png" alt="" />`);
		const url = extractAttr(html, /<img[^>]*\ssrc="([^"]+)"/);

		rmSync(path.join(root, "logo.png")); // outdir has its own copy - source deletion shouldn't matter

		const res = fetchAsset(builder, url);
		expect(res.status).toBe(200);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(
			new Uint8Array(bytes)
		);
	});
});

describe("cacheDir option", () => {
	test("is respected as the output directory and wiped/recreated on boot", async () => {
		const cacheDir = mkdtempSync(path.join(TMP_ROOT, "cache-"));
		writeFileSync(
			path.join(cacheDir, "stale-leftover.txt"),
			"should be gone"
		);

		write("client.ts", `console.log("cached");\n`);
		const builder = makeBuilder({ cacheDir });

		expect(existsSync(path.join(cacheDir, "stale-leftover.txt"))).toBe(
			false
		);

		const html = await render(
			builder,
			`<script src="/client.ts" type="module"></script>`
		);
		const url = extractAttr(html, /<script[^>]*\ssrc="([^"]+)"/);
		const files = readdirSync(cacheDir);
		expect(
			files.some((f) => f.startsWith("client-") && f.endsWith(".js"))
		).toBe(true);

		const res = fetchAsset(builder, url);
		expect(res.status).toBe(200);
	});
});

describe("sourcemap linking via options.build", () => {
	test("a linked sourcemap is servable at the url the bundled output references", async () => {
		write(
			"client.ts",
			`export const greeting = "hello";\nconsole.log(greeting);\n`
		);
		const builder = makeBuilder({ build: { sourcemap: "linked" } });

		const html = await render(
			builder,
			`<script src="/client.ts" type="module"></script>`
		);
		const scriptUrl = extractAttr(html, /<script[^>]*\ssrc="([^"]+)"/);

		const scriptBody = await fetchAsset(builder, scriptUrl).text();
		const mapUrl = extractAttr(scriptBody, /\/\/# sourceMappingURL=(\S+)/);

		const mapRes = fetchAsset(builder, mapUrl);
		expect(mapRes.status).toBe(200);
		const map = (await mapRes.json()) as {
			version: number;
			sources: string[];
		};
		expect(map.version).toBe(3);
		expect(Array.isArray(map.sources)).toBe(true);
	});
});

describe("plugin support via options.build", () => {
	test("Tailwind CSS is processed end-to-end via bun-plugin-tailwind", async () => {
		const tailwind = (await import("bun-plugin-tailwind")).default;
		write("styles.css", `@import "tailwindcss";\n`);
		const builder = makeBuilder({ build: { plugins: [tailwind] } });

		const html = await render(
			builder,
			`<link rel="stylesheet" href="/styles.css" />`
		);
		const cssUrl = extractAttr(html, /<link[^>]*\shref="([^"]+)"/);

		const res = fetchAsset(builder, cssUrl);
		expect(res.status).toBe(200);
		const css = await res.text();
		// the raw "@import "tailwindcss";" entrypoint is one line; seeing the
		// expanded preflight/theme layers confirms the plugin actually ran
		expect(css).toContain("@layer theme, base, components, utilities;");
		expect(css.length).toBeGreaterThan(1000);
	});
});

describe("client fixtures", () => {
	test("a vanilla TypeScript entrypoint bundles and runs", async () => {
		write(
			"client.ts",
			`export function add(a: number, b: number): number {\n  return a + b;\n}\nconsole.log(add(2, 3));\n`
		);
		const builder = makeBuilder();

		const html = await render(
			builder,
			`<script src="/client.ts" type="module"></script>`
		);
		const url = extractAttr(html, /<script[^>]*\ssrc="([^"]+)"/);
		const res = fetchAsset(builder, url);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("console.log(add(2, 3))");
	});

	test("a React entrypoint bundles against the host project's node_modules", async () => {
		write(
			"app.tsx",
			`import { createElement } from "react";\n` +
				`import { renderToString } from "react-dom/server";\n` +
				`const el = createElement("div", { className: "app-root" }, "hello");\n` +
				`console.log(renderToString(el));\n`
		);
		const builder = makeBuilder();

		const html = await render(
			builder,
			`<script src="/app.tsx" type="module"></script>`
		);
		const url = extractAttr(html, /<script[^>]*\ssrc="([^"]+)"/);
		const res = fetchAsset(builder, url);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("app-root");
		expect(body).toContain("hello");
	});
});

// core.ts relies on two Bun HTMLRewriter behaviors it doesn't control: async
// element handlers are awaited before the transformed response resolves, and
// a single HTMLRewriter instance (shared across all requests, see the
// AssetBuilder constructor) can safely handle concurrent transforms. These
// lock in that contract so an upstream Bun regression shows up here instead
// of as silently unrewritten tags in production. Verified against Bun 1.3.14.
describe("HTMLRewriter async safety (Bun runtime contract)", () => {
	test("awaits promises returned from element handlers before the transform resolves", async () => {
		let resolved = false;
		const rewriter = new HTMLRewriter().on("span", {
			async element(el) {
				await Bun.sleep(50);
				resolved = true;
				el.setAttribute("data-done", "1");
			},
		});

		const res = rewriter.transform(
			new Response("<span>hi</span>", {
				headers: { "Content-Type": "text/html" },
			})
		);
		const html = await res.text();

		expect(resolved).toBe(true);
		expect(html).toContain('data-done="1"');
	});

	test("a shared AssetBuilder handles concurrent transforms without cross-contamination", async () => {
		write("a.png", Buffer.from("a-bytes"));
		write("b.png", Buffer.from("b-bytes"));
		const builder = makeBuilder();

		async function run(src: string) {
			const html = await render(builder, `<img src="/${src}" alt="" />`);
			return extractAttr(html, /<img[^>]*\ssrc="([^"]+)"/);
		}

		const [urlA, urlB] = await Promise.all([run("a.png"), run("b.png")]);
		expect(urlA).toMatch(/^\/assets\/a-[0-9a-f]{8}\.png$/);
		expect(urlB).toMatch(/^\/assets\/b-[0-9a-f]{8}\.png$/);
	});
});
