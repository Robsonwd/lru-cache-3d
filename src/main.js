import { Player } from './timeline.js';
import { createScene } from './scene/index.js';
import { createAnimator, describeStep, formatCall } from './animator.js';
import { createTour } from './tour.js';
import { chapters } from './chapters.js';
import { createUI } from './ui.js';
import { validateOp, validateCapacity } from './validate.js';

const TOUR_CAPACITY = 3;
const SANDBOX_CAPACITY = 4;
const SANDBOX_PROMPT = 'Your turn. Predict what a get or put will do, then run it.';

function showFatal(message) {
  const el = document.getElementById('fatal');
  el.textContent = message;
  el.hidden = false;
}
window.addEventListener('error', (e) => showFatal(`Something went wrong: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => {
  showFatal(`Something went wrong: ${e.reason?.message ?? e.reason}`);
});

function boot() {
  let scene;
  try {
    scene = createScene(document.getElementById('stage'));
  } catch (error) {
    // Without a scene nothing is wired up, so the controls would be inert:
    // hide them and let the message stand alone.
    document.getElementById('overlay').hidden = true;
    // Only blame WebGL when it really is missing; anything else is a bug in
    // the scene code and must not hide behind the WebGL message.
    if (!document.createElement('canvas').getContext('webgl2')) {
      showFatal('This page needs WebGL, and this browser has it turned off or does not support it.');
    } else {
      console.error(error);
      showFatal(`Something went wrong: ${error.message}`);
    }
    return;
  }

  const player = new Player();
  let mode = 'tour';

  const ui = createUI({
    onPlayPause() {
      if (mode === 'tour') {
        tour.togglePlaying();
      } else {
        player.paused = !player.paused;
        ui.setPlaying(!player.paused);
      }
    },
    onStepForward() { if (mode === 'tour') tour.stepForward(); },
    onStepBack() { if (mode === 'tour') tour.stepBack(); },
    onSpeed(value) {
      player.speed = value;
      ui.setSpeed(value);
    },
    onChapter(index) { enterTour(index); },
    onMode(next) {
      if (next === 'sandbox') enterSandbox();
      else enterTour(0);
    },
    onSubmit(raw) {
      const checked = validateOp(raw);
      if (!checked.ok) {
        ui.showFieldError(checked.field, checked.message);
        return;
      }
      ui.showFieldError(null);
      // Submitting while paused would queue the op forever.
      player.paused = false;
      ui.setPlaying(true);
      const { op } = checked;
      animator.enqueue(op, {
        onStep(step, index) {
          if (index === 0) ui.setOp(formatCall(op));
          ui.setCaption(describeStep(step));
        },
      });
    },
    onCapacity(raw) {
      const capacity = validateCapacity(raw);
      if (capacity !== null) resetSandbox(capacity);
    },
    onReset() { resetSandbox(animator.state().snapshot.capacity); },
  });

  const animator = createAnimator({
    scene,
    player,
    capacity: TOUR_CAPACITY,
    onLog: (entry) => ui.log(entry),
    onStats: (stats) => ui.setStats(stats),
  });
  const tour = createTour({ chapters, animator, scene, player, ui, onEnd: enterSandbox });

  function resetSandbox(capacity) {
    animator.reset(capacity);
    scene.setInternals(1);
    scene.setView('wide');
    ui.clearLog();
    ui.setOp(null);
    ui.showFieldError(null);
    ui.setCapacity(capacity);
    ui.setCaption(SANDBOX_PROMPT);
    player.paused = false;
    ui.setPlaying(true);
  }

  function enterSandbox() {
    mode = 'sandbox';
    tour.stop();
    ui.setMode('sandbox');
    resetSandbox(SANDBOX_CAPACITY);
  }

  function enterTour(index) {
    mode = 'tour';
    ui.setMode('tour');
    tour.start(index);
  }

  // Deep links: #ch=4 starts at chapter 4, #sandbox opens the sandbox, #speed=4 sets the speed.
  const params = new URLSearchParams(location.hash.slice(1));
  const speed = Number(params.get('speed'));
  if (speed > 0 && speed <= 8) player.speed = speed;
  ui.setSpeed(player.speed);

  scene.start((dt) => player.update(dt));
  if (params.has('sandbox')) {
    enterSandbox();
  } else {
    const chapter = (Number(params.get('ch')) || 1) - 1;
    enterTour(Math.min(Math.max(chapter, 0), chapters.length - 1));
  }

  window.__lru = { scene, player, animator, tour, ui };
}

boot();
