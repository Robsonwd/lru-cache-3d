export const ease = {
  linear: (t) => t,
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - (1 - t) ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outBack: (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
};

// A clip is { duration, advance(time) }. advance receives non-decreasing local
// time in seconds; Infinity means "finish now". A clip is single-use: build a
// fresh one for each play.

// The Player item whose clip is being advanced right now. Clips check it before
// every callback or child, so a cancelAll() from inside a callback stops the
// rest of that pass, at any nesting depth.
let current = null;
const halted = () => current !== null && current.cancelled;
export function tween({ duration, ease: easing = ease.inOutCubic, onStart, onUpdate, onComplete }) {
  let started = false;
  let done = false;
  return {
    duration,
    advance(time) {
      if (done || halted()) return;
      if (!started) {
        started = true;
        onStart?.();
        if (halted()) return;
      }
      const progress = duration <= 0 ? 1 : Math.min(time / duration, 1);
      onUpdate?.(easing(progress));
      if (halted()) return;
      if (progress >= 1) {
        done = true;
        onComplete?.();
      }
    },
  };
}

export const wait = (duration) => tween({ duration });
export const call = (fn) => tween({ duration: 0, onComplete: fn });

export function seq(...clips) {
  const offsets = [];
  let total = 0;
  for (const clip of clips) {
    offsets.push(total);
    total += clip.duration;
  }
  return {
    duration: total,
    advance(time) {
      for (let i = 0; i < clips.length; i++) {
        if (time < offsets[i] || halted()) break;
        // Once the next clip is due, force this one to finish. Subtracting
        // offsets can round to just under the duration and leave it at 0.999.
        const end = i + 1 < clips.length ? offsets[i + 1] : total;
        clips[i].advance(time >= end ? Infinity : time - offsets[i]);
      }
    },
  };
}

export function par(...clips) {
  return {
    duration: clips.reduce((longest, clip) => Math.max(longest, clip.duration), 0),
    advance(time) {
      for (const clip of clips) {
        if (halted()) break;
        clip.advance(time);
      }
    },
  };
}

export function rate(clip, factor) {
  return {
    duration: clip.duration / factor,
    advance(time) {
      clip.advance(time * factor);
    },
  };
}

export class Player {
  speed = 1;
  paused = false;
  #active = [];

  play(clip) {
    return new Promise((resolve) => {
      this.#active.push({ clip, time: 0, resolve, cancelled: false });
    });
  }

  update(dt) {
    if (this.paused) return;
    const step = dt * this.speed;
    for (const item of [...this.#active]) {
      // A callback earlier in this loop may have cancelled everything.
      if (!this.#active.includes(item)) continue;
      item.time += step;
      const finished = item.time >= item.clip.duration;
      const previous = current;
      current = item;
      try {
        item.clip.advance(finished ? Infinity : item.time);
      } finally {
        current = previous;
      }
      if (!finished) continue;
      const index = this.#active.indexOf(item);
      if (index !== -1) {
        this.#active.splice(index, 1);
        item.resolve(true);
      }
    }
  }

  cancelAll() {
    const cancelled = this.#active;
    this.#active = [];
    for (const item of cancelled) {
      item.cancelled = true;
      item.resolve(false);
    }
  }

  get busy() {
    return this.#active.length > 0;
  }
}
