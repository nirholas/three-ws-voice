// Type definitions for @three-ws/voice

export declare class ThreeWsError extends Error {
	name: string;
	code: string;
	status: number | null;
	detail?: string;
	retryAfter?: number;
	body: unknown;
}

export declare class PaymentRequiredError extends ThreeWsError {
	accepts: unknown | null;
}

export declare const DEFAULT_BASE_URL: string;

/** Anything the SDK can read audio bytes out of. */
export type AudioInput = Blob | ArrayBuffer | Uint8Array | { arrayBuffer(): Promise<ArrayBuffer>; type?: string };

export type AsrFormat = 'wav' | 'pcm' | 'flac' | 'ogg';
export type TtsFormat = 'mp3' | 'wav' | 'opus' | 'aac' | 'flac' | 'pcm';
export type TtsModel = 'tts-1' | 'tts-1-hd' | 'gpt-4o-mini-tts';

export interface TranscribeOptions {
	/** Audio encoding. Inferred from the blob's MIME type when omitted. */
	format?: AsrFormat;
	/** BCP-47 language code (default `en-US`). */
	language?: string;
	/** Sample rate for raw `pcm` (WAV carries its own rate). */
	sampleRate?: number;
	/** Return word-level timestamps. */
	words?: boolean;
	/** Override the Riva model name. */
	model?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export interface TranscriptWord {
	word: string;
	startMs: number | null;
	endMs: number | null;
	confidence: number | null;
}

export interface Transcript {
	text: string;
	confidence: number | null;
	language: string | null;
	model: string | null;
	durationSec: number | null;
	/** Present only when `words: true`. */
	words?: TranscriptWord[];
	raw: unknown;
}

export interface SpeakOptions {
	/** Voice id (default `nova`). See the live catalog via `voices()`. */
	voice?: string;
	/** Output container (default `mp3`). Magpie serves non-`pcm` as WAV. */
	format?: TtsFormat;
	/** BCP-47 language code (default `en-US`). */
	language?: string;
	/** Playback speed 0.5–2.0 (paid backstop only). */
	speed?: number;
	/** Backstop model id. */
	model?: TtsModel;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export interface Clip {
	/** The synthesized audio. */
	blob: Blob;
	/** Object URL for `blob` (browser only; `null` where unavailable). */
	url: string | null;
	contentType: string;
	/** Voice that produced the bytes (from `x-tts-voice`). */
	voice: string | null;
	/** Container actually served (from `x-tts-format`). */
	format: string | null;
	/** Model that produced the bytes (from `x-tts-model`). */
	model: string | null;
	/** Raw audio bytes. */
	bytes: ArrayBuffer;
}

export interface LipsyncOptions {
	/** `wav` or `pcm`. Inferred from the blob's MIME type when omitted. */
	format?: 'wav' | 'pcm';
	/** Sample rate for raw `pcm`. */
	sampleRate?: number;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export interface FaceFrame {
	/** Seconds from clip start. */
	t: number;
	/** Weights (0–1) in `blendShapeNames` order. */
	w: number[];
}

export interface FaceTrack {
	fps: number | null;
	/** ARKit-52 names, the order `frames[i].w` follows. */
	blendShapeNames: string[];
	frames: FaceFrame[];
	frameCount: number | null;
	durationSec: number | null;
	sampleRateHz: number | null;
	model: string | null;
	functionId: string | null;
	raw: unknown;
}

export interface SayOptions {
	voice?: string;
	language?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export interface SynthAudio {
	blob: Blob;
	url: string | null;
	contentType: string;
	format: string | null;
	voiceName: string | null;
	sampleRateHz: number | null;
	base64: string | null;
	bytes: ArrayBuffer | Uint8Array;
}

export interface SayResult {
	audio: SynthAudio | null;
	animation: FaceTrack;
	raw: unknown;
}

export interface Voice {
	id: string;
	name: string;
	description: string;
}

export interface VoiceCatalog {
	enabled: boolean;
	default: string;
	voices: Voice[];
	providers: Record<string, boolean>;
	raw: unknown;
}

export interface AsrInfo {
	configured: boolean;
	encodings: string[];
	sampleRate: number | null;
	raw: unknown;
}

export interface LipsyncInfo {
	configured: boolean;
	canSynthesize: boolean;
	model: string | null;
	functionId: string | null;
	fps: number | null;
	blendshapeFormat: string | null;
	sampleRate: number | null;
	accepts: unknown | null;
	raw: unknown;
}

export interface VoiceClientOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
	/** Bearer token — lifts the anonymous per-IP rate limit to a per-user budget. */
	apiKey?: string;
	headers?: Record<string, string>;
}

export interface VoiceClient {
	transcribe(audio: AudioInput, opts?: TranscribeOptions): Promise<Transcript>;
	speak(text: string, opts?: SpeakOptions): Promise<Clip>;
	lipsync(audio: AudioInput, opts?: LipsyncOptions): Promise<FaceTrack>;
	say(text: string, opts?: SayOptions): Promise<SayResult>;
	voices(opts?: { signal?: AbortSignal }): Promise<VoiceCatalog>;
	asrInfo(opts?: { signal?: AbortSignal }): Promise<AsrInfo>;
	lipsyncInfo(opts?: { signal?: AbortSignal }): Promise<LipsyncInfo>;
}

export declare function createVoice(options?: VoiceClientOptions): VoiceClient;
export declare function transcribe(audio: AudioInput, opts?: TranscribeOptions): Promise<Transcript>;
export declare function speak(text: string, opts?: SpeakOptions): Promise<Clip>;
export declare function lipsync(audio: AudioInput, opts?: LipsyncOptions): Promise<FaceTrack>;
export declare function say(text: string, opts?: SayOptions): Promise<SayResult>;
export declare function voices(opts?: { signal?: AbortSignal }): Promise<VoiceCatalog>;
export declare function asrInfo(opts?: { signal?: AbortSignal }): Promise<AsrInfo>;
export declare function lipsyncInfo(opts?: { signal?: AbortSignal }): Promise<LipsyncInfo>;
