// @three-ws/voice — give an avatar a voice: speech in, speech out, lips that move.
// Thin client over the public, auth-free voice loop:
//   transcribe() → POST /api/asr        (NVIDIA Riva ASR, speech → text)
//   speak()      → POST /api/tts/speak  (NVIDIA Magpie TTS, text → audio)
//   lipsync()    → POST /api/a2f        (NVIDIA Audio2Face-3D, audio → ARKit visemes)
//   say()        → POST /api/a2f {text} (synthesize + animate in one round trip)
//   voices()     → GET  /api/tts/voices (the live voice catalog)
// See README.md for the full reference.

import { createHttp, resolveBaseUrl, ThreeWsError, PaymentRequiredError } from './http.js';

export { ThreeWsError, PaymentRequiredError, DEFAULT_BASE_URL } from './http.js';

// Audio encodings the ASR lane accepts (mirrors api/asr.js ACCEPTED_ENCODINGS).
const ASR_FORMATS = ['wav', 'pcm', 'flac', 'ogg'];
// Output containers /api/tts/speak can serve (mirrors api/tts/speak.js FORMATS).
const TTS_FORMATS = ['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm'];
// Backstop models /api/tts/speak validates (mirrors api/tts/speak.js MODELS).
const TTS_MODELS = ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'];
// A2F accepts WAV or raw PCM bytes (mirrors api/a2f.js encodingFromContentType).
const A2F_FORMATS = ['wav', 'pcm'];

const TEXT_MAX = 4096;

// Audio MIME → friendly encoding alias the ASR lane understands. Kept in lockstep
// with api/asr.js: WebM/Opus is intentionally absent because Riva rejects the
// container — we surface that as invalid_input client-side instead of mislabeling.
const MIME_TO_FORMAT = {
	'audio/wav': 'wav',
	'audio/x-wav': 'wav',
	'audio/wave': 'wav',
	'audio/l16': 'pcm',
	'audio/pcm': 'pcm',
	'audio/x-pcm': 'pcm',
	'audio/flac': 'flac',
	'audio/x-flac': 'flac',
	'audio/ogg': 'ogg',
	'audio/opus': 'ogg',
};

// Friendly format → the Content-Type the endpoints key off when audio is sent as
// the raw request body.
const FORMAT_TO_MIME = {
	wav: 'audio/wav',
	pcm: 'audio/pcm',
	flac: 'audio/flac',
	ogg: 'audio/ogg',
};

/**
 * Create a Voice client bound to a base URL, fetch, and optional auth.
 * For most callers the default exports `transcribe()` / `speak()` / `lipsync()`
 * are enough; use this to reuse configuration (a payment-aware fetch for the
 * paid OpenAI/ElevenLabs backstops, a custom origin) across many calls.
 */
export function createVoice(options = {}) {
	// The JSON-in/JSON-out core handles the probes, /api/a2f, and /api/tts/voices.
	const request = createHttp(options);
	// Raw audio I/O (binary request bodies, the binary /api/tts/speak response)
	// can't ride the JSON core, so a small sibling reuses the same base URL, auth,
	// and error envelope.
	const raw = createRawFetch(options);

	/** Speech → text on the free Riva ASR lane. `audio` is a Blob/ArrayBuffer/Uint8Array. */
	async function transcribe(audio, opts = {}) {
		const bytes = await toBytes(audio, 'transcribe(audio)');
		// Validate an explicit format up front; otherwise sniff the blob's MIME.
		const format = normalizeFormat(opts.format, ASR_FORMATS, 'format') || formatFromAudio(audio) || 'wav';

		const query = prune({
			language: opts.language,
			rate: opts.sampleRate,
			words: opts.words ? '1' : undefined,
			model: opts.model,
		});

		const res = await raw('/api/asr', {
			method: 'POST',
			query,
			body: bytes,
			contentType: FORMAT_TO_MIME[format] || 'audio/wav',
			headers: opts.headers,
			signal: opts.signal,
			parse: 'json',
		});
		return shapeTranscript(res);
	}

	/** Text → a voiced audio clip. Returns the bytes plus a ready-to-play object URL. */
	async function speak(text, opts = {}) {
		const value = typeof text === 'string' ? text.trim() : '';
		if (!value) throw invalid('speak() needs a non-empty `text` string.');
		if (value.length > TEXT_MAX) throw invalid(`text exceeds ${TEXT_MAX} characters.`);

		const format = opts.format === undefined || opts.format === null
			? undefined
			: normalizeFormat(opts.format, TTS_FORMATS, 'format');
		const model = opts.model === undefined || opts.model === null
			? undefined
			: normalizeFormat(opts.model, TTS_MODELS, 'model');

		const body = prune({
			text: value,
			voice: opts.voice,
			model,
			format,
			language: opts.language,
			speed: opts.speed,
		});

		// /api/tts/speak answers with raw audio bytes, not JSON — the truthful
		// container + voice + model ride in x-tts-* headers.
		const res = await raw('/api/tts/speak', {
			method: 'POST',
			jsonBody: body,
			headers: opts.headers,
			signal: opts.signal,
			parse: 'binary',
		});
		return shapeClip(res);
	}

	/** Speech → a per-frame ARKit blendshape track on the free Audio2Face-3D lane. */
	async function lipsync(audio, opts = {}) {
		const bytes = await toBytes(audio, 'lipsync(audio)');
		// A2F only accepts wav/pcm. Honour an explicit format; otherwise prefer a
		// sniffed pcm/wav, defaulting non-matching containers to wav (the endpoint
		// parses the RIFF header for the real rate).
		const sniffed = formatFromAudio(audio);
		const format = normalizeFormat(opts.format, A2F_FORMATS, 'format')
			|| (sniffed === 'pcm' ? 'pcm' : 'wav');

		const query = format === 'pcm' ? prune({ rate: opts.sampleRate }) : undefined;

		const res = await raw('/api/a2f', {
			method: 'POST',
			query,
			body: bytes,
			contentType: format === 'pcm' ? 'audio/pcm' : 'audio/wav',
			headers: opts.headers,
			signal: opts.signal,
			parse: 'json',
		});
		return shapeFaceTrack(res?.animation ?? res);
	}

	/** One-shot text → speech → face: the server synthesizes then animates that clip. */
	async function say(text, opts = {}) {
		const value = typeof text === 'string' ? text.trim() : '';
		if (!value) throw invalid('say() needs a non-empty `text` string.');
		if (value.length > TEXT_MAX) throw invalid(`text exceeds ${TEXT_MAX} characters.`);

		const res = await request('/api/a2f', {
			method: 'POST',
			body: prune({ text: value, voice: opts.voice, language: opts.language }),
			headers: opts.headers,
			signal: opts.signal,
		});
		return {
			audio: shapeSynthAudio(res?.audio),
			animation: shapeFaceTrack(res?.animation),
			raw: res,
		};
	}

	/** Fetch the live voice catalog — ids, names, descriptions, which lanes are configured. */
	async function voices(opts = {}) {
		const res = await request('/api/tts/voices', { signal: opts?.signal });
		return {
			enabled: Boolean(res?.enabled),
			default: res?.default ?? 'nova',
			voices: Array.isArray(res?.voices) ? res.voices.map((v) => ({ ...v })) : [],
			providers: res?.providers ?? {},
			raw: res,
		};
	}

	/** Probe the ASR lane: `{ configured, encodings, sampleRate }`. */
	async function asrInfo(opts = {}) {
		const res = await request('/api/asr', { signal: opts?.signal });
		return {
			configured: Boolean(res?.configured),
			encodings: Array.isArray(res?.encodings) ? res.encodings : [],
			sampleRate: res?.sampleRate ?? null,
			raw: res,
		};
	}

	/** Probe the Audio2Face lane: configuration, synthesis support, fps, accepted inputs. */
	async function lipsyncInfo(opts = {}) {
		const res = await request('/api/a2f', { signal: opts?.signal });
		return {
			configured: Boolean(res?.configured),
			canSynthesize: Boolean(res?.canSynthesize),
			model: res?.model ?? null,
			functionId: res?.functionId ?? null,
			fps: res?.fps ?? null,
			blendshapeFormat: res?.blendshapeFormat ?? null,
			sampleRate: res?.sampleRate ?? null,
			accepts: res?.accepts ?? null,
			raw: res,
		};
	}

	return { transcribe, speak, lipsync, say, voices, asrInfo, lipsyncInfo };
}

// A module-level default client for the zero-config path: `import { speak }`.
let shared = null;
function defaultClient() {
	return (shared ||= createVoice());
}

/** Speech → text (free Riva ASR lane). */
export function transcribe(audio, opts) {
	return defaultClient().transcribe(audio, opts);
}
/** Text → a voiced audio clip (free Magpie TTS lane, paid backstop). */
export function speak(text, opts) {
	return defaultClient().speak(text, opts);
}
/** Speech → ARKit blendshape track (free Audio2Face-3D lane). */
export function lipsync(audio, opts) {
	return defaultClient().lipsync(audio, opts);
}
/** One-shot text → speech → face. */
export function say(text, opts) {
	return defaultClient().say(text, opts);
}
/** The live voice catalog. */
export function voices(opts) {
	return defaultClient().voices(opts);
}
/** Probe the ASR lane. */
export function asrInfo(opts) {
	return defaultClient().asrInfo(opts);
}
/** Probe the Audio2Face lane. */
export function lipsyncInfo(opts) {
	return defaultClient().lipsyncInfo(opts);
}

// ── Raw fetch: binary request bodies + the binary speak response ──────────────
// Mirrors createHttp's base-URL resolution, auth, and error envelope, but lets a
// call send raw audio bytes (or a JSON body) and read back binary instead of the
// JSON-only core. The platform's error responses are always JSON, so non-2xx is
// mapped exactly like createHttp regardless of the requested `parse`.
function createRawFetch(opts = {}) {
	const baseUrl = resolveBaseUrl(opts.baseUrl);
	const fetchImpl = opts.fetch || (typeof globalThis !== 'undefined' ? globalThis.fetch : undefined);
	if (typeof fetchImpl !== 'function') {
		throw new ThreeWsError('No fetch implementation available — run on Node 18+ or pass { fetch }.', { code: 'no_fetch' });
	}
	const baseHeaders = { accept: 'application/json', ...(opts.headers || {}) };
	if (opts.apiKey) baseHeaders.authorization = `Bearer ${opts.apiKey}`;

	return async function rawRequest(path, { method = 'POST', query, body, jsonBody, contentType, headers, signal, parse = 'json' } = {}) {
		const url = new URL(String(path).replace(/^\/+/, '/'), baseUrl + '/');
		if (query && typeof query === 'object') {
			for (const [k, v] of Object.entries(query)) {
				if (v === undefined || v === null) continue;
				url.searchParams.set(k, String(v));
			}
		}
		const init = { method, headers: { ...baseHeaders, ...(headers || {}) }, signal };
		if (jsonBody !== undefined) {
			init.body = JSON.stringify(jsonBody);
			init.headers['content-type'] = 'application/json';
		} else if (body !== undefined) {
			init.body = body;
			if (contentType) init.headers['content-type'] = contentType;
		}

		let res;
		try {
			res = await fetchImpl(url, init);
		} catch (err) {
			if (err?.name === 'AbortError') throw err;
			throw new ThreeWsError(`Network request to ${url.pathname} failed: ${err?.message || err}`, { code: 'network_error' });
		}

		if (!res.ok) throw await mapError(res, url);

		if (parse === 'binary') {
			const buffer = await res.arrayBuffer();
			return {
				bytes: buffer,
				headers: res.headers,
				contentType: headerOf(res, 'content-type'),
			};
		}
		const text = await res.text();
		if (!text) return null;
		try { return JSON.parse(text); } catch { return { raw: text }; }
	};
}

// Map a non-2xx response onto the same typed errors createHttp produces, so a
// binary call and a JSON call surface identical error codes (402 →
// PaymentRequiredError, everything else → ThreeWsError).
async function mapError(res, url) {
	let payload = null;
	try {
		const text = await res.text();
		if (text) {
			try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
		}
	} catch {
		// A body that can't be read shouldn't mask the status code.
	}
	const code = payload?.error || payload?.code || `http_${res.status}`;
	const message = payload?.message || payload?.error_description || payload?.detail || `Request to ${url.pathname} failed with ${res.status}`;
	const retryAfter = numberOr(headerOf(res, 'retry-after'), payload?.retry_after);

	if (res.status === 402) {
		return new PaymentRequiredError(message, { code, status: 402, accepts: payload?.accepts ?? null, detail: payload?.detail, body: payload });
	}
	return new ThreeWsError(message, { code, status: res.status, detail: payload?.detail, retryAfter, body: payload });
}

// ── Response shapers (snake_case → camelCase, always with a `.raw` escape hatch) ─

function shapeTranscript(res) {
	if (!res || typeof res !== 'object') {
		throw new ThreeWsError('Unexpected empty response from /api/asr.', { code: 'bad_response' });
	}
	const out = {
		text: typeof res.text === 'string' ? res.text : '',
		confidence: numberOrNull(res.confidence),
		language: res.language ?? null,
		model: res.model ?? null,
		durationSec: numberOrNull(res.durationSec),
		raw: res,
	};
	if (Array.isArray(res.words)) {
		// The endpoint already emits { word, startMs, endMs, confidence }.
		out.words = res.words.map((w) => ({
			word: w.word ?? '',
			startMs: numberOrNull(w.startMs),
			endMs: numberOrNull(w.endMs),
			confidence: numberOrNull(w.confidence),
		}));
	}
	return out;
}

function shapeClip(res) {
	const bytes = res?.bytes ?? new ArrayBuffer(0);
	const headers = res?.headers;
	const contentType = res?.contentType || 'audio/mpeg';
	const blob = makeBlob(bytes, contentType);
	return {
		blob,
		url: makeObjectUrl(blob),
		contentType,
		voice: headerValue(headers, 'x-tts-voice'),
		format: headerValue(headers, 'x-tts-format'),
		model: headerValue(headers, 'x-tts-model'),
		bytes,
	};
}

function shapeFaceTrack(anim) {
	if (!anim || typeof anim !== 'object') {
		throw new ThreeWsError('Unexpected empty animation in /api/a2f response.', { code: 'bad_response' });
	}
	const frames = Array.isArray(anim.frames)
		? anim.frames.map((f) => ({ t: numberOrNull(f.t) ?? 0, w: Array.isArray(f.w) ? f.w.map(Number) : [] }))
		: [];
	return {
		fps: numberOrNull(anim.fps),
		blendShapeNames: Array.isArray(anim.blendShapeNames) ? anim.blendShapeNames.slice() : [],
		frames,
		frameCount: numberOrNull(anim.frameCount) ?? frames.length,
		durationSec: numberOrNull(anim.durationSec),
		sampleRateHz: numberOrNull(anim.sampleRateHz),
		model: anim.model ?? null,
		functionId: anim.functionId ?? null,
		raw: anim,
	};
}

function shapeSynthAudio(audio) {
	if (!audio || typeof audio !== 'object') return null;
	// The text path returns base64; decode it to bytes + a playable Blob/URL so
	// callers handle it exactly like a speak() Clip.
	const contentType = audio.contentType || 'audio/wav';
	const bytes = typeof audio.base64 === 'string' ? base64ToBytes(audio.base64) : new ArrayBuffer(0);
	const blob = makeBlob(bytes, contentType);
	return {
		blob,
		url: makeObjectUrl(blob),
		contentType,
		format: audio.format ?? null,
		voiceName: audio.voiceName ?? null,
		sampleRateHz: numberOrNull(audio.sampleRateHz),
		base64: audio.base64 ?? null,
		bytes,
	};
}

// ── Input coercion ────────────────────────────────────────────────────────────

// Turn a Blob / ArrayBuffer / TypedArray / Buffer into the bytes fetch accepts as
// a request body, validating non-empty audio before any network call.
async function toBytes(audio, label) {
	if (audio == null) throw invalid(`${label} needs a Blob, ArrayBuffer, or Uint8Array of audio.`);
	let bytes = audio;
	if (typeof Blob !== 'undefined' && audio instanceof Blob) {
		bytes = await audio.arrayBuffer();
	} else if (audio?.arrayBuffer && typeof audio.arrayBuffer === 'function' && !(audio instanceof ArrayBuffer)) {
		// Response-like / File-like with an arrayBuffer() method.
		bytes = await audio.arrayBuffer();
	}
	const length = byteLength(bytes);
	if (!length) throw invalid(`${label} received empty audio.`);
	return bytes;
}

function byteLength(bytes) {
	if (bytes instanceof ArrayBuffer) return bytes.byteLength;
	if (ArrayBuffer.isView(bytes)) return bytes.byteLength;
	if (typeof bytes === 'string') return bytes.length;
	return 0;
}

// Read the audio's declared MIME (Blob.type / File.type) → friendly format.
function formatFromAudio(audio) {
	const type = typeof audio?.type === 'string' ? audio.type.split(';')[0].trim().toLowerCase() : '';
	return type ? MIME_TO_FORMAT[type] || undefined : undefined;
}

// ── Small shared helpers ──────────────────────────────────────────────────────

function makeBlob(bytes, contentType) {
	const view = bytes instanceof ArrayBuffer ? bytes : (ArrayBuffer.isView(bytes) ? bytes : new Uint8Array(0));
	if (typeof Blob !== 'undefined') return new Blob([view], { type: contentType });
	// Node without a Blob global is rare on 18+, but keep a faithful stand-in so
	// `.bytes` is always usable even when Blob/URL aren't present.
	return { type: contentType, size: byteLength(view), _bytes: view, arrayBuffer: async () => (view instanceof ArrayBuffer ? view : view.buffer) };
}

function makeObjectUrl(blob) {
	try {
		if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Blob !== 'undefined' && blob instanceof Blob) {
			return URL.createObjectURL(blob);
		}
	} catch {
		// Object URLs are a browser convenience; never let their absence fail a call.
	}
	return null;
}

function base64ToBytes(b64) {
	const clean = String(b64).replace(/^data:[^,]*,/, '');
	if (typeof atob === 'function') {
		const binary = atob(clean);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
		return out;
	}
	if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
	return new Uint8Array(0);
}

function headerOf(res, name) {
	return res?.headers?.get ? res.headers.get(name) : null;
}

function headerValue(headers, name) {
	if (!headers) return null;
	if (typeof headers.get === 'function') return headers.get(name) ?? null;
	return headers[name] ?? null;
}

function normalizeFormat(value, allowed, label) {
	if (value === undefined || value === null) return undefined;
	if (!allowed.includes(value)) {
		throw invalid(`Invalid ${label} "${value}". Expected one of: ${allowed.join(', ')}.`);
	}
	return value;
}

function invalid(message) {
	return new ThreeWsError(message, { code: 'invalid_input' });
}

function prune(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue;
		out[k] = v;
	}
	return out;
}

function numberOr(...vals) {
	for (const v of vals) {
		if (v == null) continue;
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return null;
}

function numberOrNull(v) {
	if (v == null) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}
