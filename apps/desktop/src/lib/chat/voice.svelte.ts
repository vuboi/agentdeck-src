import { inTauri } from '../app/platform/history';
import { nextVoicePhase, type VoicePhase } from './voice-state';

type RecordedPcm = {
    audioBase64: string;
    sampleRate: number;
    channels: number;
};

/** Milliseconds per waveform bar; the strip scrolls one bar per step. */
const WAVE_STEP_MS = 60;
/** Bars kept in the strip, enough to fill the composer pill. */
const WAVE_BARS = 24;
/** RMS below this is room noise and draws as a flat line. */
const WAVE_NOISE_FLOOR = 0.006;

const recorderMimeType = () =>
    ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(
        (type) => MediaRecorder.isTypeSupported(type),
    );

const errorMessage = (error: unknown): string => {
    if (error instanceof DOMException && error.name === 'NotAllowedError')
        return 'Microphone permission was denied';
    if (error instanceof DOMException && error.name === 'NotFoundError')
        return 'No microphone was found';
    return error instanceof Error ? error.message : String(error);
};

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 32_768;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode(
            ...bytes.subarray(offset, offset + chunk),
        );
    }
    return btoa(binary);
}

async function recordedPcm(blob: Blob): Promise<RecordedPcm> {
    const context = new AudioContext();
    try {
        const audio = await context.decodeAudioData(await blob.arrayBuffer());
        const channels = audio.numberOfChannels;
        const interleaved = new Float32Array(audio.length * channels);
        for (let channel = 0; channel < channels; channel++) {
            const source = audio.getChannelData(channel);
            for (let frame = 0; frame < audio.length; frame++)
                interleaved[frame * channels + channel] = source[frame];
        }
        return {
            audioBase64: bytesToBase64(new Uint8Array(interleaved.buffer)),
            sampleRate: audio.sampleRate,
            channels,
        };
    } finally {
        await context.close();
    }
}

/** Owns one microphone recording and local Whisper transcription at a time. */
export class VoiceCapture {
    phase = $state<VoicePhase>('idle');
    elapsedMs = $state(0);
    modelProgress = $state(0);
    error = $state('');
    /** Amplitude bars, oldest first. Read per animation frame by VoiceWave, so it is not reactive. */
    wave: number[] = [];
    /** performance.now() when the newest bar was pushed, used to scroll between steps. */
    waveAt = 0;

    private recorder: MediaRecorder | null = null;
    private stream: MediaStream | null = null;
    private meterContext: AudioContext | null = null;
    private meterSource: MediaStreamAudioSourceNode | null = null;
    private meterFrame = 0;
    private chunks: Blob[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private startedAt = 0;
    private token = 0;
    private starting = false;
    /** Loudest RMS seen since the last waveform step. */
    private wavePeak = 0;
    private waveStepAt = 0;

    /** Requests the microphone and begins a toggle-style recording. */
    async start(): Promise<void> {
        if (this.phase !== 'idle' || this.starting) return;
        if (!inTauri()) throw new Error('Voice input needs the desktop app');
        if (
            !navigator.mediaDevices?.getUserMedia ||
            typeof MediaRecorder === 'undefined'
        ) {
            throw new Error('Voice input is not available in this WebView');
        }
        this.starting = true;
        this.error = '';
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: true,
            });
            const mimeType = recorderMimeType();
            const recorder = new MediaRecorder(
                stream,
                mimeType ? { mimeType } : undefined,
            );
            this.stream = stream;
            this.recorder = recorder;
            this.chunks = [];
            this.startMeter(stream);
            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) this.chunks.push(event.data);
            };
            recorder.start(250);
            this.token++;
            this.phase = nextVoicePhase(this.phase, 'start');
            this.startedAt = performance.now();
            this.elapsedMs = 0;
            this.timer = setInterval(
                () => (this.elapsedMs = performance.now() - this.startedAt),
                200,
            );
        } catch (error) {
            this.releaseMedia();
            this.phase = nextVoicePhase(this.phase, 'fail');
            this.error = errorMessage(error);
            throw new Error(this.error, { cause: error });
        } finally {
            this.starting = false;
        }
    }

    /** Stops recording, downloads the model when needed, and returns editable transcript text. */
    async stop(): Promise<string | null> {
        if (this.phase !== 'recording' || !this.recorder) return null;
        const mine = this.token;
        this.phase = nextVoicePhase(this.phase, 'stop');
        this.stopTimer();
        this.modelProgress = 0;
        try {
            const blob = await this.stopRecorder();
            if (mine !== this.token) return null;
            const pcm = await recordedPcm(blob);
            if (mine !== this.token) return null;
            const { invoke } = await import('@tauri-apps/api/core');
            let off = () => {};
            try {
                const { listen } = await import('@tauri-apps/api/event');
                off = await listen<{ done: number; total: number }>(
                    'voice-model-progress',
                    ({ payload }) => {
                        if (mine === this.token)
                            this.modelProgress = payload.total
                                ? Math.min(1, payload.done / payload.total)
                                : 0;
                    },
                );
            } catch {
                // Event listening not permitted or in preview
            }
            try {
                const text = await invoke<string>('voice_transcribe', pcm);
                if (mine !== this.token) return null;
                return text.trim();
            } finally {
                off();
            }
        } catch (error) {
            this.releaseMedia();
            if (mine === this.token) {
                this.phase = nextVoicePhase(this.phase, 'fail');
                this.error = errorMessage(error);
            }
            throw new Error(errorMessage(error), { cause: error });
        } finally {
            if (mine === this.token) {
                this.phase = nextVoicePhase(this.phase, 'finish');
                this.modelProgress = 0;
            }
        }
    }

    /** Cancels an active recording without sending audio for transcription. */
    cancel(): void {
        if (this.phase !== 'recording') return;
        this.token++;
        this.phase = nextVoicePhase(this.phase, 'cancel');
        this.stopTimer();
        const recorder = this.recorder;
        if (recorder && recorder.state !== 'inactive') {
            recorder.onstop = () => this.releaseMedia();
            recorder.stop();
        } else this.releaseMedia();
    }

    private stopRecorder(): Promise<Blob> {
        const recorder = this.recorder;
        if (!recorder)
            return Promise.reject(new Error('The microphone is not recording'));
        return new Promise((resolve, reject) => {
            recorder.onerror = () => {
                this.releaseMedia();
                reject(new Error('The microphone stopped unexpectedly'));
            };
            recorder.onstop = () => {
                const blob = new Blob(this.chunks, { type: recorder.mimeType });
                this.releaseMedia();
                if (blob.size > 0) resolve(blob);
                else
                    reject(
                        new Error('The microphone did not record any audio'),
                    );
            };
            recorder.stop();
        });
    }

    private stopTimer(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private startMeter(stream: MediaStream): void {
        const context = new AudioContext();
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        if (context.state === 'suspended') void context.resume();
        const samples = new Float32Array(analyser.fftSize);
        this.meterContext = context;
        this.meterSource = source;
        this.wave = [];
        this.wavePeak = 0;
        this.waveAt = performance.now();
        this.waveStepAt = this.waveAt;
        const sample = (now: number) => {
            analyser.getFloatTimeDomainData(samples);
            let sum = 0;
            for (const value of samples) sum += value * value;
            this.wavePeak = Math.max(
                this.wavePeak,
                Math.sqrt(sum / samples.length),
            );

            // Every step pushes one bar, so silence keeps the strip moving as a flat line.
            if (now - this.waveStepAt >= WAVE_STEP_MS) {
                const amplitude =
                    Math.sqrt(Math.max(0, this.wavePeak - WAVE_NOISE_FLOOR)) *
                    2.4;
                this.wave = [...this.wave, Math.min(1, amplitude)].slice(
                    -WAVE_BARS,
                );
                this.waveAt = now;
                this.waveStepAt = now;
                this.wavePeak = 0;
            }
            this.meterFrame = requestAnimationFrame(sample);
        };
        this.meterFrame = requestAnimationFrame(sample);
    }

    private stopMeter(): void {
        if (this.meterFrame) cancelAnimationFrame(this.meterFrame);
        this.meterFrame = 0;
        this.meterSource?.disconnect();
        this.meterSource = null;
        if (this.meterContext) void this.meterContext.close();
        this.meterContext = null;
        this.wave = [];
    }

    private releaseMedia(): void {
        this.stopTimer();
        this.stopMeter();
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = null;
        this.recorder = null;
        this.chunks = [];
    }
}

// Plain object on purpose: voiceOf runs inside a $derived, and writing reactive state there throws state_unsafe_mutation.
// Each VoiceCapture is itself reactive, so the UI still follows its fields.
const voices: Record<string, VoiceCapture | undefined> = Object.create(null);

/** Returns the independent voice capture state owned by one chat session. */
export function voiceOf(sessionId: string): VoiceCapture {
    let voice = voices[sessionId];
    if (!voice) {
        voice = new VoiceCapture();
        voices[sessionId] = voice;
    }
    return voice;
}
