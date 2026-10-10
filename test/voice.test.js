import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoice, ThreeWsError, PaymentRequiredError } from '../src/index.js';

// A scripted fetch double: each call shifts the next queued response and records
// the request. No network, no real endpoints — we assert on request shaping and
// response parsing, which is all the SDK is responsible for.
//
// Extended from forge's harness with `bytes` + a matching `arrayBuffer()` so the
// binary /api/tts/speak lane can be exercised; `text()` still backs the JSON lanes.
function stubFetch(responses) {
	const calls = [];
	const queue = [...responses];
	const fetch = async (url, init) => {
		calls.push({ url: new URL(url), init });
		const next = queue.shift();
		if (!next) throw new Error('stubFetch: no more queued responses');
		const { status = 200, body = {}, bytes = null, headers = {} } = next;
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (k) => headers[k.toLowerCase()] ?? null },
			text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
			arrayBuffer: async () => (bytes instanceof Uint8Array ? bytes.buffer : (bytes ?? new ArrayBuffer(0))),
		};
	};
	return { fetch, calls };
}

// A non-empty audio payload to satisfy the SDK's pre-flight emptiness check.
const AUDIO = new Uint8Array([1, 2, 3, 4]);

test('transcribe() posts raw audio bytes and shapes the transcript', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { text: 'hello world', confidence: 0.94, language: 'en-US', model: 'riva-asr', durationSec: 1.2 } },
	]);
	const client = createVoice({ fetch, baseUrl: 'https://three.ws' });
	const res = await client.transcribe(AUDIO, { language: 'en-GB' });

	assert.equal(calls[0].url.pathname, '/api/asr');
	assert.equal(calls[0].init.method, 'POST');
	assert.equal(calls[0].init.headers['content-type'], 'audio/wav');
	assert.equal(calls[0].url.searchParams.get('language'), 'en-GB');
	assert.equal(calls[0].init.body, AUDIO); // bytes passed straight through
	assert.equal(res.text, 'hello world');
	assert.equal(res.confidence, 0.94);
	assert.equal(res.durationSec, 1.2);
});

test('transcribe(words:true) maps the query flag and word timestamps', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { text: 'hi there', words: [{ word: 'hi', startMs: 0, endMs: 320, confidence: 0.9 }] } },
	]);
	const client = createVoice({ fetch });
	const res = await client.transcribe(AUDIO, { words: true });
	assert.equal(calls[0].url.searchParams.get('words'), '1');
	assert.equal(res.words[0].word, 'hi');
	assert.equal(res.words[0].endMs, 320);
});

test('speak() posts JSON and returns the binary clip with x-tts-* metadata', async () => {
	const audioBytes = new Uint8Array([10, 20, 30]);
	const { fetch, calls } = stubFetch([
		{ bytes: audioBytes, headers: { 'content-type': 'audio/wav', 'x-tts-voice': 'onyx', 'x-tts-format': 'wav', 'x-tts-model': 'magpie' } },
	]);
	const client = createVoice({ fetch });
	const clip = await client.speak('  The only coin is $THREE.  ', { voice: 'onyx', format: 'wav' });

	assert.equal(calls[0].url.pathname, '/api/tts/speak');
	assert.equal(calls[0].init.method, 'POST');
	assert.equal(calls[0].init.headers['content-type'], 'application/json');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.text, 'The only coin is $THREE.'); // trimmed
	assert.equal(sent.voice, 'onyx');
	assert.equal(sent.format, 'wav');
	assert.equal(clip.contentType, 'audio/wav');
	assert.equal(clip.voice, 'onyx');
	assert.equal(clip.format, 'wav');
	assert.equal(clip.model, 'magpie');
	assert.equal(new Uint8Array(clip.bytes).length, 3);
});

test('lipsync() posts wav audio and shapes the ARKit face track', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { ok: true, animation: { fps: 30, blendShapeNames: ['jawOpen', 'mouthClose'], frames: [{ t: 0, w: [0.1, 0.0] }, { t: 0.033, w: [0.4, 0.2] }], frameCount: 2, durationSec: 0.066, sampleRateHz: 16000, model: 'audio2face-3d', functionId: 'fn-1' } } },
	]);
	const client = createVoice({ fetch });
	const track = await client.lipsync(AUDIO);

	assert.equal(calls[0].url.pathname, '/api/a2f');
	assert.equal(calls[0].init.headers['content-type'], 'audio/wav');
	assert.deepEqual(track.blendShapeNames, ['jawOpen', 'mouthClose']);
	assert.equal(track.frameCount, 2);
	assert.equal(track.frames[1].t, 0.033);
	assert.equal(track.fps, 30);
	assert.equal(track.functionId, 'fn-1');
});

test('lipsync() with pcm format passes the sample rate as ?rate', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { animation: { fps: 30, blendShapeNames: [], frames: [{ t: 0, w: [] }] } } },
	]);
	const client = createVoice({ fetch });
	await client.lipsync(AUDIO, { format: 'pcm', sampleRate: 24000 });
	assert.equal(calls[0].init.headers['content-type'], 'audio/pcm');
	assert.equal(calls[0].url.searchParams.get('rate'), '24000');
});

test('say() posts { text } and returns decoded audio + animation', async () => {
	const wavB64 = Buffer.from(new Uint8Array([82, 73, 70, 70])).toString('base64'); // "RIFF"
	const { fetch, calls } = stubFetch([
		{ body: { ok: true, audio: { base64: wavB64, contentType: 'audio/wav', format: 'wav', voiceName: 'Nova', sampleRateHz: 44100 }, animation: { fps: 30, blendShapeNames: ['jawOpen'], frames: [{ t: 0, w: [0.2] }], frameCount: 1, durationSec: 0.03 } } },
	]);
	const client = createVoice({ fetch });
	const { audio, animation } = await client.say('Welcome back.', { voice: 'nova' });

	assert.equal(calls[0].url.pathname, '/api/a2f');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.text, 'Welcome back.');
	assert.equal(sent.voice, 'nova');
	assert.ok(!('audio' in sent), 'text path sends no audio field');
	assert.equal(audio.format, 'wav');
	assert.equal(audio.voiceName, 'Nova');
	assert.equal(new Uint8Array(audio.bytes)[0], 82); // decoded "R"
	assert.equal(animation.blendShapeNames[0], 'jawOpen');
});

test('voices() reads the catalog endpoint and reports configured lanes', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { enabled: true, default: 'nova', voices: [{ id: 'nova', name: 'Nova', description: 'Bright' }], providers: { nvidia: true, openai: false } } },
	]);
	const client = createVoice({ fetch });
	const cat = await client.voices();
	assert.equal(calls[0].url.pathname, '/api/tts/voices');
	assert.equal(cat.voices[0].id, 'nova');
	assert.equal(cat.providers.nvidia, true);
});

test('inputs are validated before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createVoice({ fetch });
	await assert.rejects(() => client.speak('   '), /non-empty/);
	await assert.rejects(() => client.speak('x', { format: 'webm' }), /Invalid format/);
	await assert.rejects(() => client.transcribe(new Uint8Array(0)), /empty audio/);
	await assert.rejects(() => client.transcribe(AUDIO, { format: 'webm' }), /Invalid format/);
	await assert.rejects(() => client.lipsync(AUDIO, { format: 'mp3' }), /Invalid format/);
	assert.equal(calls.length, 0);
});

test('not_configured (503) surfaces as a typed ThreeWsError', async () => {
	const { fetch } = stubFetch([{ status: 503, body: { error: 'not_configured', message: 'Speech-to-text is not configured' } }]);
	const client = createVoice({ fetch });
	await assert.rejects(() => client.transcribe(AUDIO), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'not_configured');
		assert.equal(e.status, 503);
		return true;
	});
});

test('429 carries the retry-after through the binary lane', async () => {
	const { fetch } = stubFetch([{ status: 429, headers: { 'retry-after': '12' }, body: { error: 'rate_limited', message: 'TTS rate limit exceeded' } }]);
	const client = createVoice({ fetch });
	await assert.rejects(() => client.speak('hi'), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'rate_limited');
		assert.equal(e.retryAfter, 12);
		return true;
	});
});

test('402 on the paid backstop surfaces as PaymentRequiredError with the challenge', async () => {
	const accepts = [{ scheme: 'exact', asset: 'USDC', network: 'eip155:8453', maxAmountRequired: '5000' }];
	const { fetch } = stubFetch([{ status: 402, body: { error: 'payment_required', message: 'pay', accepts } }]);
	const client = createVoice({ fetch });
	await assert.rejects(() => client.speak('hi', { voice: 'onyx' }), (e) => {
		assert.ok(e instanceof PaymentRequiredError);
		assert.deepEqual(e.accepts, accepts);
		return true;
	});
});
