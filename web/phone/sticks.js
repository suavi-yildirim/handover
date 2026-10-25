// On-screen stick for touch screens. Returns -1..1 per axis and springs back
// to zero when released. Each stick follows only the finger that started on
// it, so two thumbs can work two sticks at once.

export class Stick {
  // axes: 'xy' for a joystick, 'y' for a vertical slider.
  constructor(el, { axes = 'xy', deadzone = 0.12, expo = 1.6, onChange = null } = {}) {
    Object.assign(this, { el, axes, deadzone, expo, onChange });
    this.x = 0;
    this.y = 0;
    this.pointer = null;
    this.knob = el.querySelector('.knob');
    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('pointermove', (e) => this._move(e));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      el.addEventListener(type, (e) => this._up(e));
    }
  }

  _down(e) {
    if (this.pointer !== null) return;
    e.preventDefault();
    this.pointer = e.pointerId;
    this.el.setPointerCapture?.(e.pointerId);
    this.el.classList.add('active');
    this._move(e);
  }

  _move(e) {
    if (e.pointerId !== this.pointer) return;
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    const radius = (this.axes === 'y' ? r.height : Math.min(r.width, r.height)) / 2 - this.knobRadius(r);
    let dx = this.axes === 'y' ? 0 : (e.clientX - (r.left + r.width / 2)) / radius;
    let dy = -(e.clientY - (r.top + r.height / 2)) / radius;
    const m = Math.hypot(dx, dy);
    if (m > 1) { dx /= m; dy /= m; }
    this._set(dx, dy);
  }

  _up(e) {
    if (e.pointerId !== this.pointer) return;
    this.pointer = null;
    this.el.classList.remove('active');
    this._set(0, 0);
  }

  knobRadius(r) {
    return this.knob ? this.knob.offsetWidth / 2 : Math.min(r.width, r.height) * 0.15;
  }

  _set(rawX, rawY) {
    // Knob shows the finger; output gets a deadzone and a curve for fine control.
    if (this.knob) {
      const r = this.el.getBoundingClientRect();
      const radius = (this.axes === 'y' ? r.height : Math.min(r.width, r.height)) / 2 - this.knobRadius(r);
      this.knob.style.transform = `translate(${rawX * radius}px, ${-rawY * radius}px)`;
    }
    const m = Math.hypot(rawX, rawY);
    const out = m <= this.deadzone ? 0 : Math.pow((m - this.deadzone) / (1 - this.deadzone), this.expo);
    this.x = m > 0 ? rawX / m * out : 0;
    this.y = m > 0 ? rawY / m * out : 0;
    this.onChange?.(this);
  }
}
