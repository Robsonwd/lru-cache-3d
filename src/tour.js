import { wait, par, seq } from './timeline.js';
import { describeStep, formatCall } from './animator.js';

const ZERO_STATS = { hits: 0, misses: 0, evictions: 0 };
// A slow operation spends 0.9 s between steps: the gap after one step's motion,
// then the lead between the next step's caption and its motion, so each caption
// has faded in and can be read before the step it describes starts to move.
const SLOW_STEP_GAP = 0.5;
const SLOW_STEP_LEAD = 0.4;
// The pause after an operation, before the next beat. A slow operation's last
// caption (hit, miss, inserted, updated) needs time to be read.
const AFTER_OP = { slow: 1.5, fast: 0.15, normal: 0.6 };
// How long the chapter title card holds the screen. A chapter that opens on
// a scene change (the internals fading in) waits this long, so the change is
// its own moment and not hidden under the title.
const TITLE_CLEAR = 1.4;

export function createTour({ chapters, animator, scene, player, ui, onEnd = () => {} }) {
  let chapterIndex = 0;
  let beatIndex = 0;
  // True once the current beat has passed the pause gate and begun playing.
  let beatStarted = false;
  // Each run() claims a new id; a run whose id is stale stops at its next await.
  let runId = 0;
  // states[i] is what the world looked like just before beat i started.
  let states = [];
  let internals = false;
  let view = 'wide';
  let playing = false;
  let stopAfterOp = false;

  // Resolves the gate in run() when playback resumes.
  let wake = null;

  function setPlaying(value) {
    playing = value;
    player.paused = !value;
    ui.setPlaying(value);
    if (value && wake) {
      wake();
      wake = null;
    }
  }

  function whenPlaying() {
    return new Promise((resolve) => { wake = resolve; });
  }

  function clearTransient() {
    ui.showCard(null);
    ui.setCounter(null);
    ui.setOp(null);
  }

  function start(index = 0, { paused = false } = {}) {
    const chapter = chapters[index];
    chapterIndex = index;
    beatIndex = 0;
    states = [];
    stopAfterOp = false;
    animator.restore({ snapshot: chapter.initial, stats: ZERO_STATS });
    internals = chapter.internals;
    view = 'wide';
    scene.setInternals(internals ? 1 : 0);
    scene.setView(view);
    clearTransient();
    ui.clearLog();
    ui.setCaption('');
    ui.setChapter(index, chapter.title, chapters.length);
    setPlaying(!paused);
    run(0);
  }

  async function run(fromBeat) {
    const id = ++runId;
    const alive = () => id === runId;
    const { beats } = chapters[chapterIndex];
    for (let i = fromBeat; i < beats.length; i++) {
      beatIndex = i;
      beatStarted = false;
      // While paused, do not start the next beat: an op beat would change the
      // model ahead of what is on screen.
      if (!playing) {
        await whenPlaying();
        if (!alive()) return;
      }
      beatStarted = true;
      states[i] = { ...animator.state(), internals, view };
      await playBeat(beats[i], alive, i);
      if (!alive()) return;
      if (beats[i].type === 'op' && stopAfterOp) {
        stopAfterOp = false;
        setPlaying(false);
      }
    }
    // A step forward that finds no operation left stops at the next chapter.
    if (chapterIndex + 1 < chapters.length) start(chapterIndex + 1, { paused: stopAfterOp });
    else onEnd();
  }

  async function playBeat(beat, alive, index) {
    if (beat.caption) ui.setCaption(beat.caption);
    switch (beat.type) {
      case 'caption':
        ui.setOp(null);
        ui.setCaption(beat.text);
        await player.play(wait(beat.hold));
        return;
      case 'op': {
        ui.setOp(formatCall(beat.op));
        let opts = {};
        if (beat.pace === 'slow') {
          opts = {
            stepGap: SLOW_STEP_GAP,
            stepLead: SLOW_STEP_LEAD,
            onStep: (step) => { if (alive()) ui.setCaption(describeStep(step)); },
          };
        } else if (beat.pace === 'fast') {
          opts = { rate: 2 };
        }
        await animator.enqueue(beat.op, opts);
        if (!alive()) return;
        await player.play(wait(AFTER_OP[beat.pace] ?? AFTER_OP.normal));
        return;
      }
      case 'camera':
        view = beat.view;
        await player.play(par(scene.cameraTo(beat.view, beat.duration ?? 1.6), wait(beat.hold ?? 0)));
        return;
      case 'internals':
        internals = beat.visible;
        await player.play(par(
          seq(wait(index === 0 ? TITLE_CLEAR : 0), scene.fadeInternals(beat.visible ? 1 : 0, 1.6)),
          wait(beat.hold ?? 0),
        ));
        return;
      case 'scan':
        ui.setCounter('checks', 0);
        await player.play(scene.scan({
          onVisit: (n) => { if (alive()) ui.setCounter('checks', n); },
        }));
        if (!alive()) return;
        // The counter stays up for the captions that follow; start() clears it.
        await player.play(wait(beat.hold ?? 1.5));
        return;
      case 'card':
        ui.setOp(null);
        ui.showCard({ title: beat.title, lines: beat.lines });
        await player.play(wait(beat.hold));
        if (alive()) ui.showCard(null);
        return;
      default:
        throw new Error(`unknown beat type: ${beat.type}`);
    }
  }

  function togglePlaying() {
    stopAfterOp = false;
    setPlaying(!playing);
  }

  function stepForward() {
    stopAfterOp = true;
    setPlaying(true);
  }

  // While paused after a step back, show what is about to replay: an operation's
  // call and its own caption, or the caption of any other beat.
  function showReplay(beat) {
    if (beat.type === 'op') {
      ui.setOp(formatCall(beat.op));
      ui.setCaption(beat.caption ?? '');
    } else {
      ui.setCaption(beat.text ?? beat.caption ?? '');
    }
  }

  // Undo the most recent operation that has started: the current beat if it is
  // an op under way, otherwise the nearest earlier op (or beat 0). At beat 0, a
  // beat that has started restarts this chapter; one still waiting at the gate
  // goes back to the start of the previous chapter.
  function stepBack() {
    const { beats } = chapters[chapterIndex];
    let target = beatIndex;
    if (!(beatStarted && beats[beatIndex].type === 'op')) {
      if (beatIndex === 0) {
        const index = beatStarted ? chapterIndex : Math.max(chapterIndex - 1, 0);
        start(index, { paused: true });
        showReplay(chapters[index].beats[0]);
        return;
      }
      target = beatIndex - 1;
      while (target > 0 && beats[target].type !== 'op') target--;
    }
    const state = states[target];
    animator.restore(state);
    internals = state.internals;
    view = state.view;
    scene.setInternals(internals ? 1 : 0);
    scene.setView(view);
    clearTransient();
    showReplay(beats[target]);
    ui.truncateLog(beats.slice(0, target).filter((beat) => beat.type === 'op').length);
    stopAfterOp = false;
    setPlaying(false);
    run(target);
  }

  function stop() {
    runId++;
    stopAfterOp = false;
    clearTransient();
  }

  return {
    start,
    togglePlaying,
    stepForward,
    stepBack,
    stop,
    position: () => ({ chapter: chapterIndex, beat: beatIndex }),
    isPlaying: () => playing,
  };
}
