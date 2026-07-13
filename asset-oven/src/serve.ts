type ByteRange = { start: number; end: number };

// parses a single-range "Range: bytes=start-end" request header (RFC 9110 14.1.2);
// multi-range requests aren't supported and are treated as absent, falling back to a full 200
function parseRange(
	header: string | null,
	size: number
): ByteRange | "unsatisfiable" | undefined {
	if (!header) return undefined;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match || (!match[1] && !match[2])) return undefined;

	let start: number;
	let end: number;
	if (!match[1]) {
		// suffix range, e.g. "bytes=-500" means the last 500 bytes
		const suffixLength = Number(match[2]);
		start = Math.max(0, size - suffixLength);
		end = size - 1;
	} else {
		start = Number(match[1]);
		end = match[2] ? Number(match[2]) : size - 1;
	}

	// a backwards range (e.g. "bytes=5-2") is syntactically invalid, not
	// unsatisfiable; RFC 9110 §14.1.2 says to disregard it and serve a full
	// 200, not reject it with a 416
	if (start > end) return undefined;
	if (start < 0 || start >= size) return "unsatisfiable";
	return { start, end: Math.min(end, size - 1) };
}

/**
 * Serves a file from disk with Range/HEAD support and long-lived immutable
 * caching headers. Pure and stateless: the caller is responsible for
 * resolving `path` and `type` and for gating on GET/HEAD.
 */
export function serveFile(req: Request, path: string, type: string): Response {
	const file = Bun.file(path);
	const size = file.size;
	const isHead = req.method === "HEAD";

	const headers = new Headers({
		"Content-Type": type,
		"Cache-Control": "public, max-age=31536000, immutable",
		"Accept-Ranges": "bytes",
	});

	const range = parseRange(req.headers.get("Range"), size);
	if (range === "unsatisfiable") {
		headers.set("Content-Range", `bytes */${size}`);
		return new Response(null, { status: 416, headers });
	}

	if (range) {
		const { start, end } = range;
		headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
		headers.set("Content-Length", String(end - start + 1));
		if (isHead) return new Response(null, { status: 206, headers });
		return new Response(file.slice(start, end + 1).stream(), {
			status: 206,
			headers,
		});
	}

	headers.set("Content-Length", String(size));
	if (isHead) return new Response(null, { status: 200, headers });
	return new Response(file.stream(), { status: 200, headers });
}
