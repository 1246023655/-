const MUSIC_ENABLED_KEY = "gomoku.musicEnabled";
const MUSIC_TRACK_KEY = "gomoku.musicTrack";
const MUSIC_TRACKS = ["calm", "joy"] as const;

type MusicTrack = (typeof MUSIC_TRACKS)[number];

const AudioContextCtor =
  window.AudioContext ??
  (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

class GomokuAudio {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicTimer: number | null = null;
  private melodyIndex = 0;
  private enabled = localStorage.getItem(MUSIC_ENABLED_KEY) !== "off";
  private track: MusicTrack = readTrack();

  isEnabled(): boolean {
    return this.enabled;
  }

  getTrackLabel(): string {
    return this.track === "calm" ? "清雅" : "欢快";
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    localStorage.setItem(MUSIC_ENABLED_KEY, enabled ? "on" : "off");

    if (enabled) {
      void this.startMusic();
      return;
    }

    this.stopMusic();
  }

  switchTrack(): string {
    this.track = this.track === "calm" ? "joy" : "calm";
    this.melodyIndex = 0;
    localStorage.setItem(MUSIC_TRACK_KEY, this.track);

    if (this.enabled && this.context) {
      this.stopMusic();
      void this.startMusic();
    }

    return this.getTrackLabel();
  }

  async unlock(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    await this.startMusic();
  }

  async startMusic(): Promise<void> {
    if (!this.enabled || !AudioContextCtor) {
      return;
    }

    const context = this.ensureContext();

    if (context.state === "suspended") {
      await context.resume();
    }

    if (!this.musicTimer) {
      this.scheduleMusicBar();
    }
  }

  stopMusic(): void {
    if (this.musicTimer) {
      window.clearTimeout(this.musicTimer);
      this.musicTimer = null;
    }
  }

  playMove(): void {
    if (!this.enabled || !AudioContextCtor) {
      return;
    }

    const context = this.ensureContext();

    if (context.state === "suspended") {
      void context.resume();
    }

    const now = context.currentTime;
    const body = context.createOscillator();
    const tap = context.createOscillator();
    const bodyGain = context.createGain();
    const tapGain = context.createGain();

    body.type = "triangle";
    body.frequency.setValueAtTime(180, now);
    body.frequency.exponentialRampToValueAtTime(92, now + 0.08);
    bodyGain.gain.setValueAtTime(0.0001, now);
    bodyGain.gain.exponentialRampToValueAtTime(0.18, now + 0.008);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

    tap.type = "sine";
    tap.frequency.setValueAtTime(860, now);
    tap.frequency.exponentialRampToValueAtTime(420, now + 0.045);
    tapGain.gain.setValueAtTime(0.0001, now);
    tapGain.gain.exponentialRampToValueAtTime(0.08, now + 0.004);
    tapGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);

    body.connect(bodyGain).connect(this.sfxGain!);
    tap.connect(tapGain).connect(this.sfxGain!);
    body.start(now);
    tap.start(now);
    body.stop(now + 0.18);
    tap.stop(now + 0.08);
  }

  private ensureContext(): AudioContext {
    if (this.context) {
      return this.context;
    }

    this.context = new AudioContextCtor!();
    this.masterGain = this.context.createGain();
    this.musicGain = this.context.createGain();
    this.sfxGain = this.context.createGain();
    this.masterGain.gain.value = 0.72;
    this.musicGain.gain.value = 0.16;
    this.sfxGain.gain.value = 0.34;
    this.musicGain.connect(this.masterGain);
    this.sfxGain.connect(this.masterGain);
    this.masterGain.connect(this.context.destination);
    return this.context;
  }

  private scheduleMusicBar(): void {
    if (!this.enabled || !this.context || !this.musicGain) {
      this.musicTimer = null;
      return;
    }

    const context = this.context;
    const startAt = context.currentTime + 0.04;
    if (this.track === "joy") {
      this.scheduleJoyBar(startAt);
    } else {
      this.scheduleCalmBar(startAt);
    }

    this.musicTimer = window.setTimeout(() => this.scheduleMusicBar(), this.track === "joy" ? 3840 : 3600);
  }

  private scheduleCalmBar(startAt: number): void {
    const scale = [261.63, 293.66, 329.63, 392, 440, 523.25];
    const pattern = [0, 2, 4, 3, 1, 2, 5, 4];

    this.playSoftTone(130.81, startAt, 3.6, "sine", 0.026);
    for (let i = 0; i < 4; i += 1) {
      const noteIndex = pattern[(this.melodyIndex + i) % pattern.length];
      this.playSoftTone(scale[noteIndex], startAt + i * 0.92, 0.7, "triangle", 0.034);
    }

    this.melodyIndex = (this.melodyIndex + 2) % pattern.length;
  }

  private scheduleJoyBar(startAt: number): void {
    const melody = [
      587.33,
      739.99,
      880,
      987.77,
      880,
      739.99,
      659.25,
      587.33,
      659.25,
      739.99,
      880,
      739.99,
      659.25,
      587.33,
      493.88,
      587.33
    ];
    const step = 0.24;

    for (let i = 0; i < melody.length; i += 1) {
      const frequency = melody[(this.melodyIndex + i) % melody.length];
      const time = startAt + i * step;
      const accent = i % 4 === 0 ? 0.038 : 0.026;
      this.playPluckTone(frequency, time, 0.18, "square", accent);
      this.playPluckTone(frequency * 2, time + 0.018, 0.12, "triangle", accent * 0.42);
    }

    for (let beat = 0; beat < 4; beat += 1) {
      const time = startAt + beat * 0.96;
      this.playPluckTone(146.83, time, 0.34, "triangle", 0.04);
      this.playPluckTone(220, time + 0.48, 0.2, "triangle", 0.026);
      this.playJoyChord(time + 0.03);
      this.playMusicClick(time + 0.46, 0.028);
      this.playMusicClick(time + 0.72, 0.016);
    }

    this.melodyIndex = (this.melodyIndex + 5) % melody.length;
  }

  private playJoyChord(startAt: number): void {
    const chord = [293.66, 369.99, 440];
    chord.forEach((frequency, index) => {
      this.playPluckTone(frequency, startAt + index * 0.012, 0.32, "triangle", 0.014);
    });
  }

  private playMusicClick(startAt: number, volume: number): void {
    this.playPluckTone(1320, startAt, 0.045, "sine", volume);
    this.playPluckTone(660, startAt + 0.006, 0.055, "triangle", volume * 0.45);
  }

  private playPluckTone(
    frequency: number,
    startAt: number,
    duration: number,
    type: OscillatorType,
    volume: number
  ): void {
    if (!this.context || !this.musicGain) {
      return;
    }

    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    oscillator.connect(gain).connect(this.musicGain);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.03);
  }

  private playSoftTone(
    frequency: number,
    startAt: number,
    duration: number,
    type: OscillatorType,
    volume: number
  ): void {
    if (!this.context || !this.musicGain) {
      return;
    }

    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    oscillator.connect(gain).connect(this.musicGain);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.05);
  }
}

function readTrack(): MusicTrack {
  const saved = localStorage.getItem(MUSIC_TRACK_KEY);
  return MUSIC_TRACKS.includes(saved as MusicTrack) ? (saved as MusicTrack) : "calm";
}

export const gomokuAudio = new GomokuAudio();
