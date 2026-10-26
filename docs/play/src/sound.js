// Sound effects, synthesized with Web Audio so the game ships no audio files.
// Off until the player turns it on in the menu; the choice is remembered per browser.
// Browsers only allow audio after a click, and turning sound on is one, so the
// AudioContext is created then and never before.

const STORAGE_KEY = 'handover.sound';
const VOLUME = 0.25;

// Each cue is a short list of tones: [startSeconds, frequencyHz, durationSeconds, endHz?, waveform?].
const CUES = {
  close: [[0, 320, 0.06, 180, 'triangle']],                       // gripper closing: a soft down-click
  open: [[0, 180, 0.06, 320, 'triangle']],                        // gripper opening: an up-click
  grasp: [[0, 620, 0.07, 620, 'sine']],                           // object picked up
  release: [[0, 440, 0.08, 440, 'sine']],                         // object set down
  drop: [[0, 260, 0.25, 90, 'sawtooth']],                         // object fell: a low thud
  success: [[0, 523, 0.14, 523, 'sine'], [0.12, 659, 0.14, 659, 'sine'],
    [0.24, 784, 0.14, 784, 'sine'], [0.36, 1047, 0.4, 1047, 'sine']], // rising chord
  fail: [[0, 220, 0.2, 200, 'square'], [0.22, 165, 0.35, 150, 'square']], // falling buzz
  shared: [[0, 880, 0.1, 880, 'sine'], [0.1, 1320, 0.16, 1320, 'sine']],   // episode sent
};

export class Sound {
  constructor() {
    this.ctx = null;
    this.onChange = () => {};
    this.on = false;
    try { this.on = localStorage.getItem(STORAGE_KEY) === 'on'; } catch { /* storage may be blocked */ }
  }

  get enabled() { return this.on; }

  // Turning sound on is a click, so it is the moment to create the AudioContext.
  set(on) {
    this.on = on;
    try { localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
    if (on) this.play('open');
    this.onChange();
  }

  toggle() { this.set(!this.on); }

  // Play a named cue. Silent when sound is off or Web Audio is unavailable.
  play(name) {
    if (!this.on) return;
    const cue = CUES[name];
    if (!cue) return;
    try {
      const ctx = this.context();
      if (!ctx) return;
      const now = ctx.currentTime;
      for (const [at, f0, dur, f1, wave] of cue) {
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = wave || 'sine';
        osc.frequency.setValueAtTime(f0, now + at);
        osc.frequency.linearRampToValueAtTime(f1, now + at + dur);
        // Short attack and release avoid clicks at the start and end of each tone.
        gain.gain.setValueAtTime(0, now + at);
        gain.gain.linearRampToValueAtTime(VOLUME, now + at + 0.005);
        gain.gain.linearRampToValueAtTime(0, now + at + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + at);
        osc.stop(now + at + dur + 0.02);
      }
    } catch { /* a failed sound must never break the game */ }
  }

  context() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
}
