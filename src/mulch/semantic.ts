/**
 * Semantic search module for mulch expertise records.
 *
 * Provides embedding generation (sentence-transformers, OpenAI, Ollama),
 * vector storage (.overstory/embeddings/), and cosine-similarity search
 * with optional hybrid BM25 scoring.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

// === Types (exported for use in client.ts and prime.ts) ===

export type EmbeddingProvider = "sentence-transformers" | "openai" | "ollama";

export interface SemanticSearchOptions {
	domain?: string;
	topK?: number;
	hybrid?: boolean;
}

export interface SemanticSearchResult {
	record: Record<string, unknown>;
	semanticScore: number;
	bm25Score?: number;
	combinedScore?: number;
}

export interface EmbedStatus {
	totalRecords: number;
	embeddedRecords: number;
	staleRecords: number;
	domains: Array<{ name: string; total: number; embedded: number; stale: number }>;
}

// === Internal types ===

interface EmbeddingIndexEntry {
	id: string;
	offset: number;
	contentHash: string;
}

interface EmbeddingIndex {
	model: string;
	dimension: number;
	entries: EmbeddingIndexEntry[];
}

// === Constants ===

const OLLAMA_ALLOWED_HOSTNAMES = ["localhost", "127.0.0.1", "::1"];

/** Module-level flag: consent notice is shown at most once per process. */
let openaiNoticeShown = false;

/**
 * Fixed Python script for sentence-transformers embedding.
 * Reads JSON array of strings from stdin, outputs JSON array of float arrays.
 * SECURITY: This is a fixed constant — not derived from user input.
 */
const SENTENCE_TRANSFORMERS_SCRIPT = `
import sys, json
try:
    from sentence_transformers import SentenceTransformer
    texts = json.load(sys.stdin)
    model = SentenceTransformer(sys.argv[1] if len(sys.argv) > 1 else 'all-MiniLM-L6-v2')
    embeddings = model.encode(texts, convert_to_numpy=True)
    print(json.dumps([e.tolist() for e in embeddings]))
except Exception as e:
    print(json.dumps({'error': str(e)}), file=sys.stderr)
    sys.exit(1)
`;

// === Embedding Adapters ===

/**
 * Generate embeddings for a batch of texts using the specified provider.
 * Returns null if the provider is unavailable or the request fails.
 */
export async function embedTexts(
	texts: string[],
	provider: EmbeddingProvider,
	model: string,
): Promise<Float32Array[] | null> {
	if (texts.length === 0) return [];

	switch (provider) {
		case "sentence-transformers":
			return embedViaSentenceTransformers(texts, model);
		case "openai":
			return embedViaOpenAI(texts, model);
		case "ollama":
			return embedViaOllama(texts, model);
	}
}

async function embedViaSentenceTransformers(
	texts: string[],
	model: string,
): Promise<Float32Array[] | null> {
	try {
		// Pass texts via stdin as JSON — never as CLI args (security requirement)
		const proc = Bun.spawn(["python3", "-c", SENTENCE_TRANSFORMERS_SCRIPT, model], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		const inputJson = JSON.stringify(texts);
		proc.stdin.write(new TextEncoder().encode(inputJson));
		proc.stdin.end();

		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			return null;
		}

		const raw = await new Response(proc.stdout).text();
		const parsed: unknown = JSON.parse(raw.trim());
		if (!Array.isArray(parsed)) return null;
		return (parsed as number[][]).map((arr) => new Float32Array(arr));
	} catch {
		return null;
	}
}

async function embedViaOpenAI(texts: string[], model: string): Promise<Float32Array[] | null> {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) return null;

	// Log consent notice on first use — API key is never logged
	if (!openaiNoticeShown) {
		process.stderr.write("Note: Sending text to OpenAI API for embedding generation\n");
		openaiNoticeShown = true;
	}

	const controller = new AbortController();
	const connectTimeout = setTimeout(() => controller.abort(), 500);
	const totalTimeout = setTimeout(() => controller.abort(), 10_000);

	try {
		const response = await fetch("https://api.openai.com/v1/embeddings", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({ input: texts, model }),
			signal: controller.signal,
		});

		clearTimeout(connectTimeout);

		if (!response.ok) {
			return null;
		}

		const data = (await response.json()) as {
			data: Array<{ embedding: number[]; index: number }>;
		};

		// Sort by index to preserve order
		const sorted = [...data.data].sort((a, b) => a.index - b.index);
		return sorted.map((entry) => new Float32Array(entry.embedding));
	} catch {
		return null;
	} finally {
		clearTimeout(connectTimeout);
		clearTimeout(totalTimeout);
	}
}

async function embedViaOllama(texts: string[], model: string): Promise<Float32Array[] | null> {
	// SSRF prevention: validate that the Ollama URL resolves to localhost
	const ollamaBase = "http://localhost:11434";
	try {
		const parsed = new URL(ollamaBase);
		if (!OLLAMA_ALLOWED_HOSTNAMES.includes(parsed.hostname)) {
			process.stderr.write(`Ollama host not in allowlist: ${parsed.hostname}\n`);
			return null;
		}
	} catch {
		return null;
	}

	const results: Float32Array[] = [];

	for (const text of texts) {
		const controller = new AbortController();
		const connectTimeout = setTimeout(() => controller.abort(), 500);
		const totalTimeout = setTimeout(() => controller.abort(), 10_000);

		try {
			const response = await fetch(`${ollamaBase}/api/embed`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model, input: text }),
				signal: controller.signal,
			});

			clearTimeout(connectTimeout);

			if (!response.ok) {
				return null;
			}

			const data = (await response.json()) as { embeddings?: number[][]; embedding?: number[] };
			const vec = data.embeddings?.[0] ?? data.embedding;
			if (!vec) return null;
			results.push(new Float32Array(vec));
		} catch {
			return null;
		} finally {
			clearTimeout(connectTimeout);
			clearTimeout(totalTimeout);
		}
	}

	return results;
}

// === Vector Store ===

/**
 * Sanitize a domain name for safe use in file paths.
 * Strips /, \, and .. sequences.
 */
function sanitizeDomainName(domain: string): string {
	return domain.replace(/\.\./g, "").replace(/[/\\]/g, "_").trim();
}

/**
 * Hash text content using SHA-256 for staleness detection.
 */
function hashContent(text: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(text);
	return hasher.digest("hex");
}

/**
 * Load embeddings and index for a domain from disk.
 * Returns null if files don't exist or can't be parsed.
 */
export async function loadEmbeddings(
	embeddingsDir: string,
	domain: string,
): Promise<{ vectors: Float32Array[]; index: EmbeddingIndex } | null> {
	const safe = sanitizeDomainName(domain);
	const binPath = join(embeddingsDir, `${safe}.bin`);
	const idxPath = join(embeddingsDir, `${safe}.idx.json`);

	try {
		const idxFile = Bun.file(idxPath);
		if (!(await idxFile.exists())) return null;
		const index = (await idxFile.json()) as EmbeddingIndex;

		const binFile = Bun.file(binPath);
		if (!(await binFile.exists())) return null;
		const buffer = await binFile.arrayBuffer();

		if (index.entries.length === 0 || index.dimension === 0) return null;

		const bytesPerVector = index.dimension * Float32Array.BYTES_PER_ELEMENT;
		const vectors: Float32Array[] = [];

		for (let i = 0; i < index.entries.length; i++) {
			const entry = index.entries[i];
			if (entry === undefined) continue;
			const start = entry.offset * bytesPerVector;
			const slice = buffer.slice(start, start + bytesPerVector);
			vectors.push(new Float32Array(slice));
		}

		return { vectors, index };
	} catch {
		return null;
	}
}

/**
 * Save embeddings and index for a domain to disk.
 */
export async function saveEmbeddings(
	embeddingsDir: string,
	domain: string,
	vectors: Float32Array[],
	index: EmbeddingIndex,
): Promise<void> {
	const safe = sanitizeDomainName(domain);
	const binPath = join(embeddingsDir, `${safe}.bin`);
	const idxPath = join(embeddingsDir, `${safe}.idx.json`);

	// Concatenate all float32 arrays into one ArrayBuffer
	const totalBytes = vectors.length * index.dimension * Float32Array.BYTES_PER_ELEMENT;
	const buffer = new ArrayBuffer(totalBytes);
	const view = new Float32Array(buffer);

	let offset = 0;
	for (const vec of vectors) {
		view.set(vec, offset);
		offset += index.dimension;
	}

	// Ensure directory exists
	await Bun.write(idxPath, `${JSON.stringify(index, null, "\t")}\n`);
	await Bun.write(binPath, buffer);
}

// === Core Math ===

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		const ai = a[i] ?? 0;
		const bi = b[i] ?? 0;
		dot += ai * bi;
		normA += ai * ai;
		normB += bi * bi;
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	if (denom === 0) return 0;
	return dot / denom;
}

/**
 * Compute a simple TF-based BM25 score.
 * Counts how many query terms appear in the text, normalized by text length.
 */
function bm25Score(queryTerms: string[], text: string): number {
	const lower = text.toLowerCase();
	const words = lower.split(/\s+/);
	let matches = 0;
	for (const term of queryTerms) {
		if (lower.includes(term.toLowerCase())) matches++;
	}
	return words.length > 0 ? matches / queryTerms.length : 0;
}

/**
 * Compute confirmation score from record outcomes.
 * success outcomes = 1.0, no outcomes = 0.5, failure outcomes = 0.0
 */
function confirmationScore(record: Record<string, unknown>): number {
	const outcomes = record.outcomes;
	if (!Array.isArray(outcomes) || outcomes.length === 0) return 0.5;
	const hasSuccess = outcomes.some(
		(o) =>
			typeof o === "object" && o !== null && (o as Record<string, unknown>).status === "success",
	);
	const hasFailure = outcomes.some(
		(o) =>
			typeof o === "object" && o !== null && (o as Record<string, unknown>).status === "failure",
	);
	if (hasSuccess) return 1.0;
	if (hasFailure) return 0.0;
	return 0.5;
}

/** Extract searchable text from a mulch record. */
function recordToText(record: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const key of ["content", "description", "title", "rationale", "name"]) {
		const v = record[key];
		if (typeof v === "string" && v) parts.push(v);
	}
	return parts.join(" ");
}

// === Semantic Search ===

/**
 * Perform semantic search over a set of records.
 *
 * Embeds the query, loads stored embeddings, computes cosine similarity,
 * optionally blends with BM25 and confirmation scores (hybrid mode).
 * Falls back to empty array if embeddings are unavailable.
 */
export async function semanticSearch(
	query: string,
	records: Array<{ id?: string; domain: string; [key: string]: unknown }>,
	embeddingsDir: string,
	provider: EmbeddingProvider,
	model: string,
	options?: SemanticSearchOptions,
): Promise<SemanticSearchResult[]> {
	const topK = options?.topK ?? 10;
	const hybrid = options?.hybrid ?? true;
	const domainFilter = options?.domain;

	// 1. Embed query
	const queryVecs = await embedTexts([query], provider, model);
	if (!queryVecs || queryVecs.length === 0) return [];
	const queryVec = queryVecs[0];
	if (!queryVec) return [];

	// 2. Group records by domain
	const filteredRecords = domainFilter ? records.filter((r) => r.domain === domainFilter) : records;

	const byDomain = new Map<string, typeof filteredRecords>();
	for (const rec of filteredRecords) {
		const bucket = byDomain.get(rec.domain) ?? [];
		bucket.push(rec);
		byDomain.set(rec.domain, bucket);
	}

	const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
	const scored: SemanticSearchResult[] = [];

	// 3. For each domain, load embeddings and score records
	for (const [domain, domainRecords] of byDomain) {
		const stored = await loadEmbeddings(embeddingsDir, domain);
		if (!stored) continue;

		const { vectors, index } = stored;

		for (let i = 0; i < domainRecords.length; i++) {
			const rec = domainRecords[i];
			if (!rec) continue;

			// Find corresponding vector by record ID match
			const recId = String(rec.id ?? "");
			const entryIdx = recId ? index.entries.findIndex((e) => e.id === recId) : i;

			const vec = entryIdx >= 0 ? vectors[entryIdx] : vectors[i];
			if (!vec) continue;

			const semanticScore = cosineSimilarity(queryVec, vec);

			if (!hybrid) {
				scored.push({ record: rec as Record<string, unknown>, semanticScore });
				continue;
			}

			const text = recordToText(rec as Record<string, unknown>);
			const bm25 = bm25Score(queryTerms, text);
			const confirmation = confirmationScore(rec as Record<string, unknown>);

			const combinedScore = semanticScore * 0.5 + bm25 * 0.3 + confirmation * 0.2;
			scored.push({
				record: rec as Record<string, unknown>,
				semanticScore,
				bm25Score: bm25,
				combinedScore,
			});
		}
	}

	// 4. Sort by combined (hybrid) or semantic score
	scored.sort((a, b) => {
		const scoreA = a.combinedScore ?? a.semanticScore;
		const scoreB = b.combinedScore ?? b.semanticScore;
		return scoreB - scoreA;
	});

	return scored.slice(0, topK);
}

// === Embed All Records ===

/**
 * Embed all records across domains and store in .overstory/embeddings/.
 * Accepts records as a parameter to avoid circular dependency with client.ts.
 */
export async function embedAllRecords(
	records: Array<{ id?: string; domain: string; [key: string]: unknown }>,
	embeddingsDir: string,
	provider: EmbeddingProvider,
	model: string,
): Promise<EmbedStatus> {
	const byDomain = new Map<string, typeof records>();
	for (const rec of records) {
		const bucket = byDomain.get(rec.domain) ?? [];
		bucket.push(rec);
		byDomain.set(rec.domain, bucket);
	}

	let totalRecords = 0;
	let embeddedRecords = 0;
	let staleRecords = 0;
	const domainStats: EmbedStatus["domains"] = [];

	for (const [domain, domainRecords] of byDomain) {
		totalRecords += domainRecords.length;

		// Load existing index for staleness detection
		const existing = await loadEmbeddings(embeddingsDir, domain);
		const existingIndex = existing?.index;

		const textsToEmbed: string[] = [];
		const idsToEmbed: string[] = [];
		let domainStale = 0;

		for (const rec of domainRecords) {
			const text = recordToText(rec as Record<string, unknown>);
			const hash = hashContent(text);
			const recId = String(rec.id ?? "");

			const existing_entry = existingIndex?.entries.find((e) => e.id === recId);
			if (existing_entry && existing_entry.contentHash === hash) {
				// Up to date — no need to re-embed
				embeddedRecords++;
			} else {
				if (existing_entry) domainStale++;
				textsToEmbed.push(text);
				idsToEmbed.push(recId);
			}
		}

		staleRecords += domainStale;

		if (textsToEmbed.length === 0) {
			const domainEmbedded = domainRecords.length - domainStale;
			domainStats.push({
				name: domain,
				total: domainRecords.length,
				embedded: domainEmbedded,
				stale: 0,
			});
			continue;
		}

		const vecs = await embedTexts(textsToEmbed, provider, model);
		if (!vecs || vecs.length !== textsToEmbed.length) {
			domainStats.push({
				name: domain,
				total: domainRecords.length,
				embedded: domainRecords.length - textsToEmbed.length,
				stale: domainStale,
			});
			continue;
		}

		// Rebuild full vector list: existing + new
		const allVectors: Float32Array[] = existing?.vectors ? [...existing.vectors] : [];
		const allEntries: EmbeddingIndexEntry[] = existingIndex ? [...existingIndex.entries] : [];

		const dim = vecs[0]?.length ?? 0;

		for (let i = 0; i < vecs.length; i++) {
			const vec = vecs[i];
			const id = idsToEmbed[i];
			if (!vec || id === undefined) continue;

			const text = textsToEmbed[i] ?? "";
			const hash = hashContent(text);

			const existingEntryIdx = allEntries.findIndex((e) => e.id === id);
			if (existingEntryIdx >= 0) {
				// Update in place
				allVectors[existingEntryIdx] = vec;
				const entry = allEntries[existingEntryIdx];
				if (entry) entry.contentHash = hash;
			} else {
				const offset = allVectors.length;
				allVectors.push(vec);
				allEntries.push({ id, offset, contentHash: hash });
			}
		}

		const newIndex: EmbeddingIndex = {
			model,
			dimension: dim,
			entries: allEntries,
		};

		await saveEmbeddings(embeddingsDir, domain, allVectors, newIndex);
		embeddedRecords += textsToEmbed.length;

		domainStats.push({
			name: domain,
			total: domainRecords.length,
			embedded: domainRecords.length,
			stale: 0,
		});
	}

	return { totalRecords, embeddedRecords, staleRecords, domains: domainStats };
}

// === Embed Status ===

/**
 * Read index files from .overstory/embeddings/ to compute coverage stats.
 */
export async function getEmbedStatus(embeddingsDir: string): Promise<EmbedStatus> {
	const status: EmbedStatus = {
		totalRecords: 0,
		embeddedRecords: 0,
		staleRecords: 0,
		domains: [],
	};

	if (!existsSync(embeddingsDir)) return status;

	try {
		const glob = new Bun.Glob("*.idx.json");
		for await (const filename of glob.scan(embeddingsDir)) {
			const idxPath = join(embeddingsDir, filename);
			try {
				const index = (await Bun.file(idxPath).json()) as EmbeddingIndex;
				const count = index.entries.length;
				const domainName = filename.replace(/\.idx\.json$/, "");
				status.embeddedRecords += count;
				status.totalRecords += count;
				status.domains.push({ name: domainName, total: count, embedded: count, stale: 0 });
			} catch {
				// Skip unreadable index files
			}
		}
	} catch {
		// Directory scan failed — return empty status
	}

	return status;
}
