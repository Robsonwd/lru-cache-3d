// The hash map: a gold instrument panel of BUCKET_COUNT cells behind and above
// the row. An occupied cell is lit, shows its key, and holds a fine beam to
// its slab that follows the slab wherever it goes. A lookup flashes the cell
// and fires a pulse down the beam: one hop from key to entry. A miss flashes
// an empty cell red and its pulse fizzles out going nowhere.
//
// The clip rule: every clip captures only its arguments; buckets are read and
// assigned in onStart. Each clip takes ownership of its cell with a token, and
// syncTo() clears every token, so a clip cancelled mid-flight can never touch
// the rebuilt wall.
import * as THREE from 'three';
import { tween, ease } from '../timeline.js';
import { createLabel } from './text.js';
import { assignBucket, homeBucket, bucketPosition, BUCKET_COUNT } from './layout.js';
import { frameGeometry, SLAB_H } from './effects.js';
import {
  filamentGeometry, filamentMaterial, setCurve, curvePoint, createGlowPoints, lightColor,
} from './links.js';

const DURATION = { lookup: 0.6, mapSet: 0.45, mapDelete: 0.45 };

const CELL_W = 1.36;
const CELL_H = 0.96;
const KEY_HEIGHT = 0.5;
const KEY_MAX_WIDTH = 1.0;
const SLAB_TOP = SLAB_H / 2 + 0.03; // a beam lands on the top edge of its slab
const BEAM_RADIUS = 0.014;
const MISS_RADIUS = 0.024;

// Colours. Lines and light are HDR (above 1) so they bloom; the cell glass
// and every label stay at or below 1 so the type stays crisp.
const GOLD_LINE = lightColor('#ffc46b', 0.35, 1);
const GOLD_FILL = new THREE.Color('#ffc46b');
const GOLD_TEXT = new THREE.Color('#ffe4b8');
const DIM_TEXT = new THREE.Color('#c99a52');
const FLASH_LINE = lightColor('#ffe9c4', 0.2, 1);
const MISS_LINE = lightColor('#ff3b5c', 0.75, 1);
const MISS_TEXT = new THREE.Color('#ff5a74');
// An emoji keeps its own colours: a gold tint turns them muddy and dim.
const EMOJI_TEXT = new THREE.Color('#ffffff');
const EMOJI = /\p{Extended_Pictographic}/u;
const BEAM = lightColor('#ffc46b', 0.45, 1.25);
const PULSE = lightColor('#fff0d6', 0.15, 6);
const PULSE_BEAD = lightColor('#ffe0a8', 0.25, 7);
const PORT = lightColor('#ffc46b', 0.35, 3);
const MISS_BEAM = lightColor('#ff3b5c', 0.85, 2.4);
const MISS_BEAD = lightColor('#ff3b5c', 0.8, 6);

const COMETS = 4;
const COMET_POINTS = 6;

const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
const outCubic = ease.outCubic;
const inOutCubic = ease.inOutCubic;
const linear = ease.linear;

function addScaled(target, color, s) {
  target.r += color.r * s;
  target.g += color.g * s;
  target.b += color.b * s;
  return target;
}

function fitLabel(label, maxWidth) {
  const width = label.mesh.geometry.parameters.width;
  label.mesh.scale.setScalar(Math.min(1, maxWidth / width));
}

// Four corner brackets of a w x h box, as one geometry: the mark of an empty
// slot on the panel.
function bracketGeometry(w, h, arm, stroke) {
  const positions = [];
  const index = [];
  const quad = (x0, y0, x1, y1) => {
    const base = positions.length / 3;
    positions.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0);
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const x = (sx * w) / 2;
      const y = (sy * h) / 2;
      quad(Math.min(x, x - sx * arm), y - (sy > 0 ? stroke : 0), Math.max(x, x - sx * arm), y + (sy < 0 ? stroke : 0));
      quad(x - (sx > 0 ? stroke : 0), Math.min(y, y - sy * arm), x + (sx < 0 ? stroke : 0), Math.max(y, y - sy * arm));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  return geometry;
}

// The glass of a cell: lit from its edges and, more, from the port at its
// foot, like a backlit gauge. uColor carries brightness and alpha; it stays
// well under 1 so the key on top reads.
const FILL_VERTEX = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const FILL_FRAGMENT = /* glsl */`
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    vec2 q = abs(vUv - 0.5) * 2.0;
    float edge = 1.0 - max(q.x, q.y);
    float rim = exp(-edge * 9.0);
    float foot = exp(-vUv.y * 3.2) * (1.0 - q.x * 0.6);
    gl_FragColor = vec4(uColor * (0.25 + 0.55 * rim + 0.7 * foot), 1.0);
  }`;

function additive(color) {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: true,
  });
}

export function createHashMap(stage, slabs) {
  const root = new THREE.Group();
  root.name = 'hashmap';
  stage.scene.add(root);
  const alphaUniform = { value: 1 };
  let alpha = 1;

  // ---- the panel ----
  const cellFrame = frameGeometry(CELL_W, CELL_H, 0.09, 0.032);
  const cellBrackets = bracketGeometry(CELL_W + 0.07, CELL_H + 0.07, 0.17, 0.032);
  const cellFill = new THREE.PlaneGeometry(CELL_W - 0.03, CELL_H - 0.03);
  const tickGeometry = new THREE.PlaneGeometry(0.22, 0.03);
  const filament = filamentGeometry();
  const points = createGlowPoints(BUCKET_COUNT * 2 + COMETS * COMET_POINTS, alphaUniform);
  root.add(points.object);

  const first = bucketPosition(0);
  const last = bucketPosition(BUCKET_COUNT - 1);
  const panelW = last.x - first.x + CELL_W + 0.5;
  const panelH = first.y - last.y + CELL_H + 1.05;
  const panelX = (first.x + last.x) / 2;
  const panelY = (first.y + last.y) / 2 + 0.24;
  const wallZ = first.z;

  // Dark glass behind the cells, so the panel reads as an object and not as
  // lines floating in the sky; normal blending, it darkens what is behind.
  const plateMaterial = new THREE.MeshBasicMaterial({
    color: '#070912', transparent: true, opacity: 0.7, depthWrite: false,
  });
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(panelW, panelH), plateMaterial);
  plate.position.set(panelX, panelY, wallZ - 0.06);
  plate.renderOrder = -2;
  const borderMaterial = additive('#000000');
  const border = new THREE.Mesh(frameGeometry(panelW, panelH, 0.16, 0.03), borderMaterial);
  border.position.set(panelX, panelY, wallZ - 0.05);
  border.renderOrder = -1;
  root.add(plate, border);

  // Title: small gold type, flanked by two short rules.
  const titleY = first.y + CELL_H / 2 + 0.36;
  const title = createLabel({ text: 'hash map', height: 0.3, weight: 600 });
  title.mesh.position.set(panelX, titleY, wallZ);
  title.mesh.renderOrder = 3;
  root.add(title.mesh);
  const ruleGeometry = new THREE.PlaneGeometry(panelW * 0.3, 0.03);
  const ruleMaterial = additive('#000000');
  for (const side of [-1, 1]) {
    const rule = new THREE.Mesh(ruleGeometry, ruleMaterial);
    rule.position.set(panelX + side * (panelW * 0.15 + 0.95), titleY, wallZ);
    root.add(rule);
  }

  const cells = [];
  for (let i = 0; i < BUCKET_COUNT; i++) {
    const p = bucketPosition(i);
    const group = new THREE.Group();
    group.position.set(p.x, p.y, p.z);
    const frameMaterial = additive('#000000');
    const frame = new THREE.Mesh(cellFrame, frameMaterial);
    frame.renderOrder = 1;
    const bracketMaterial = additive('#000000');
    const brackets = new THREE.Mesh(cellBrackets, bracketMaterial);
    brackets.renderOrder = 1;
    const fillMaterial = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() } },
      vertexShader: FILL_VERTEX,
      fragmentShader: FILL_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const fill = new THREE.Mesh(cellFill, fillMaterial);
    fill.position.z = -0.01;
    fill.renderOrder = 0;
    // A tick at the bottom edge: the port a beam leaves from.
    const tickMaterial = additive('#000000');
    const tick = new THREE.Mesh(tickGeometry, tickMaterial);
    tick.position.y = -CELL_H / 2;
    tick.renderOrder = 1;
    const indexLabel = createLabel({ text: String(i), height: 0.2, weight: 500 });
    indexLabel.mesh.position.set(-CELL_W / 2 + 0.2, CELL_H / 2 - 0.17, 0.005);
    indexLabel.mesh.renderOrder = 3;
    const label = createLabel({ text: ' ', height: KEY_HEIGHT, weight: 700 });
    label.mesh.position.set(0, 0.02, 0.01);
    label.mesh.renderOrder = 3;
    label.mesh.visible = false;
    group.add(fill, frame, brackets, tick, indexLabel.mesh, label.mesh);
    root.add(group);

    const beamMaterial = filamentMaterial(alphaUniform);
    beamMaterial.uniforms.uRadius.value = BEAM_RADIUS;
    beamMaterial.uniforms.uPulseColor.value.copy(PULSE);
    beamMaterial.uniforms.uSpacing.value = 0.7;
    const beam = new THREE.Mesh(filament, beamMaterial);
    beam.frustumCulled = false;
    beam.visible = false;
    beam.renderOrder = 1;
    root.add(beam);

    cells.push({
      index: i,
      frameMaterial, bracketMaterial, fillMaterial, tickMaterial, indexLabel, label, text: ' ',
      port: new THREE.Vector3(p.x, p.y - CELL_H / 2, p.z + 0.01),
      key: null, // the key the map holds here
      owner: null, // the clip animating this cell
      lit: 0, flash: 0, miss: 0, labelAlpha: 0, labelMiss: false,
      beam, u: beamMaterial.uniforms,
      beamKey: null, beamMode: 'gold', extent: 0, vis: 0, known: false,
      end: new THREE.Vector3(), flow: Math.random(), land: 0,
    });
  }

  function setText(cell, text) {
    if (cell.text === text) return;
    cell.text = text;
    cell.emoji = EMOJI.test(text);
    cell.label.setText(text);
    fitLabel(cell.label, KEY_MAX_WIDTH);
  }

  function resetCell(cell) {
    cell.key = null;
    cell.owner = null;
    cell.lit = 0;
    cell.flash = 0;
    cell.miss = 0;
    cell.labelAlpha = 0;
    cell.labelMiss = false;
    cell.beamKey = null;
    cell.beamMode = 'gold';
    cell.extent = 0;
    cell.vis = 0;
    cell.known = false;
    cell.land = 0;
    cell.u.uPulseGain.value = 0;
    cell.u.uRadius.value = BEAM_RADIUS;
  }

  const occupiedIndices = () => {
    const set = new Set();
    for (const cell of cells) if (cell.key !== null) set.add(cell.index);
    return set;
  };
  const cellOf = (key) => cells.find((cell) => cell.key === key) ?? null;

  // ---- comets: the pulse heads, pooled ----
  const comets = [];
  for (let i = 0; i < COMETS; i++) comets.push({ index: i, owner: null, used: 0 });
  let cometClock = 0;
  function acquireComet(owner) {
    let comet = comets.find((c) => c.owner === null);
    if (!comet) comet = comets.reduce((a, b) => (a.used <= b.used ? a : b));
    comet.owner = owner;
    comet.used = ++cometClock;
    hideComet(comet);
    return comet;
  }
  function hideComet(comet) {
    const base = BUCKET_COUNT * 2 + comet.index * COMET_POINTS;
    for (let k = 0; k < COMET_POINTS; k++) points.hide(base + k);
  }
  function releaseComet(comet, owner) {
    if (!comet || comet.owner !== owner) return;
    comet.owner = null;
    hideComet(comet);
  }
  // A head at parameter t on a filament, with a tail of fading points behind
  // it; `jitter` scatters the tail into sparks.
  const cometAt = new THREE.Vector3();
  const cometColor = new THREE.Color();
  function drawComet(comet, owner, u, t, color, size, jitter = 0) {
    if (comet.owner !== owner) return;
    const base = BUCKET_COUNT * 2 + comet.index * COMET_POINTS;
    const len = Math.max(u.uLen.value, 1e-3);
    for (let k = 0; k < COMET_POINTS; k++) {
      const tk = t - (k * 0.07) / len;
      if (tk < 0 || size <= 0) {
        points.hide(base + k);
        continue;
      }
      curvePoint(u, tk, cometAt);
      if (jitter > 0 && k > 0) {
        cometAt.x += Math.sin(k * 12.9 + t * 40) * jitter * k * 0.05;
        cometAt.y += Math.cos(k * 7.3 + t * 33) * jitter * k * 0.05;
      }
      const fall = 1 - k / COMET_POINTS;
      points.set(base + k, cometAt, cometColor.copy(color).multiplyScalar(fall ** 1.5), size * (k === 0 ? 1 : 0.6 * fall));
    }
  }

  // ---- the reveal ----
  // While the internals fade in, the occupied cells power on one after
  // another and fire their beams. p runs 0..1; null ends it.
  let revealP = null;
  function applyReveal() {
    const lit = cells.filter((cell) => cell.key !== null && cell.owner === null);
    lit.forEach((cell, rank) => {
      if (revealP === null) {
        cell.lit = 1;
        cell.flash = 0;
        cell.labelAlpha = 1;
        cell.extent = 1;
        return;
      }
      const start = 0.1 + rank * (0.4 / Math.max(lit.length - 1, 1));
      const on = clamp01((revealP - start) / 0.2);
      cell.lit = outCubic(on);
      cell.flash = Math.sin(on * Math.PI) * 0.7;
      cell.labelAlpha = outCubic(on);
      cell.extent = Math.max(outCubic(clamp01((revealP - start - 0.12) / 0.3)), 0.0001);
    });
  }
  function reveal(p) {
    revealP = p;
    applyReveal();
  }

  // ---- per frame ----
  const tmp = new THREE.Vector3();
  const zero = new THREE.Vector3();
  const color = new THREE.Color();

  stage.addUpdater((dt, elapsed) => {
    borderMaterial.color.copy(GOLD_LINE).multiplyScalar(0.3 * alpha);
    plateMaterial.opacity = 0.7 * alpha;
    ruleMaterial.color.copy(GOLD_LINE).multiplyScalar(0.4 * alpha);
    title.mesh.material.color.copy(GOLD_TEXT).multiplyScalar(0.85);
    title.mesh.material.opacity = alpha;

    for (const cell of cells) {
      // A slow shimmer on the lit cells, so the panel feels live.
      const hum = 0.08 * Math.sin(elapsed * 1.7 + cell.index * 0.9);
      // An empty slot is four dim corner marks; a lit one gets a full frame.
      const frame = cell.frameMaterial.color.copy(GOLD_LINE).multiplyScalar((1.65 + hum) * cell.lit);
      addScaled(addScaled(frame, FLASH_LINE, 2.8 * cell.flash), MISS_LINE, 3.2 * cell.miss);
      cell.frameMaterial.opacity = alpha;
      cell.bracketMaterial.color.copy(GOLD_LINE).multiplyScalar(0.42 + 0.9 * cell.lit + 1.5 * cell.flash);
      addScaled(cell.bracketMaterial.color, MISS_LINE, 2.5 * cell.miss);
      cell.bracketMaterial.opacity = alpha;
      const fill = addScaled(cell.fillMaterial.uniforms.uColor.value.copy(GOLD_FILL)
        .multiplyScalar(0.018 + 0.16 * cell.lit + 0.3 * cell.flash), MISS_LINE, 0.45 * cell.miss);
      fill.multiplyScalar(alpha);
      addScaled(cell.tickMaterial.color.copy(GOLD_LINE).multiplyScalar(0.25 + 2.2 * cell.lit + 2 * cell.flash),
        MISS_LINE, 2.5 * cell.miss);
      cell.tickMaterial.opacity = alpha;
      cell.indexLabel.mesh.material.color.copy(DIM_TEXT).multiplyScalar(0.55 + 0.35 * cell.lit);
      cell.indexLabel.mesh.material.opacity = alpha;
      const label = cell.label.mesh;
      label.visible = cell.labelAlpha > 0.001;
      label.material.color.copy(cell.labelMiss ? MISS_TEXT : cell.emoji ? EMOJI_TEXT : GOLD_TEXT);
      label.material.opacity = cell.labelAlpha * alpha;

      // The beam.
      const u = cell.u;
      let show = false;
      if (cell.beamMode === 'gold' && cell.beamKey !== null) {
        if (slabs.positionOf(cell.beamKey, tmp)) {
          cell.end.copy(tmp);
          cell.end.y += SLAB_TOP;
          cell.vis = 1;
          cell.known = true;
        } else {
          // The slab is gone (shattered): let the beam go out quickly.
          cell.vis = Math.max(0, cell.vis - dt * 7);
        }
        show = cell.known && cell.vis > 0 && cell.extent > 0.001;
        if (show) {
          setCurve(u, cell.port, cell.end, zero);
          u.uExtent.value = cell.extent;
          // The beam being looked up (its cell flares) burns brighter and
          // thicker, so it stands out when many beams cross.
          u.uColor.value.copy(BEAM).multiplyScalar(1 + 1.6 * cell.flash);
          u.uRadius.value = BEAM_RADIUS * (1 + 0.9 * cell.flash);
          u.uOpacity.value = cell.vis;
          cell.flow += dt * 1.3;
          u.uFlow.value = cell.flow % u.uSpacing.value;
          u.uFlowGain.value = 0.55;
        }
      } else if (cell.beamMode === 'miss') {
        show = cell.extent > 0.001 && cell.vis > 0.001;
        u.uExtent.value = cell.extent;
        u.uColor.value.copy(MISS_BEAM);
        u.uOpacity.value = cell.vis;
        u.uFlowGain.value = 0;
      }
      cell.beam.visible = show;

      // Two small lights: the port on the cell and the landing on the slab.
      const portSlot = cell.index * 2;
      if (cell.lit > 0.01) {
        points.set(portSlot, cell.port, color.copy(PORT).multiplyScalar(cell.lit + cell.flash * 1.5), 0.075);
      } else {
        points.hide(portSlot);
      }
      if (show && cell.beamMode === 'gold' && cell.extent > 0.98) {
        points.set(portSlot + 1, cell.end, color.copy(PORT).multiplyScalar(cell.vis * (0.8 + 3 * cell.land)), 0.07 + 0.32 * cell.land);
      } else {
        points.hide(portSlot + 1);
      }
    }
    points.frame(stage.camera, stage.renderer.domElement);
  });

  // ---- instant rebuild ----
  function syncTo(snapshot) {
    revealP = null;
    for (const comet of comets) {
      comet.owner = null;
      hideComet(comet);
    }
    for (const cell of cells) resetCell(cell);
    // Oldest first, so the buckets fall where an insertion history would put them.
    const occupied = new Set();
    for (let i = snapshot.entries.length - 1; i >= 0; i--) {
      const { key } = snapshot.entries[i];
      const index = assignBucket(key, occupied);
      if (index < 0) continue;
      occupied.add(index);
      const cell = cells[index];
      cell.key = key;
      setText(cell, key);
      cell.lit = 1;
      cell.labelAlpha = 1;
      cell.beamKey = key;
      cell.extent = 1;
      cell.known = slabs.positionOf(key, cell.end) !== null;
      if (cell.known) cell.end.y += SLAB_TOP;
      cell.vis = cell.known ? 1 : 0;
    }
  }

  // ---- clips ----
  function lookup(key, found) {
    return found ? lookupHit(key) : lookupMiss(key);
  }

  function lookupHit(key) {
    const owner = {};
    let cell = null;
    let comet = null;
    return tween({
      duration: DURATION.lookup,
      ease: linear,
      onStart() {
        cell = cellOf(key);
        if (!cell) return;
        cell.owner = owner;
        comet = acquireComet(owner);
      },
      onUpdate(p) {
        if (!cell || cell.owner !== owner) return;
        // The cell flares first: the hash lands on this bucket.
        cell.flash = p < 0.08 ? outCubic(p / 0.08) : (1 - clamp01((p - 0.08) / 0.5)) ** 2;
        // Then one hop: the pulse runs the whole beam, accelerating.
        const travel = clamp01((p - 0.05) / 0.5);
        const along = travel ** 1.6;
        const arrived = p >= 0.55;
        const u = cell.u;
        const beamUp = cell.beam.visible || (cell.known && cell.vis > 0);
        u.uPulse.value = along * cell.extent;
        u.uPulseGain.value = arrived ? 1 - clamp01((p - 0.55) / 0.1) : clamp01(travel * 8);
        cell.land = arrived ? (1 - clamp01((p - 0.55) / 0.45)) ** 2 : 0;
        if (!beamUp || !comet) {
          if (comet) hideComet(comet);
          return;
        }
        if (!arrived) {
          drawComet(comet, owner, u, along * cell.extent, PULSE_BEAD, 0.26);
        } else {
          // Impact: the head swells and burns out on the slab.
          const q = clamp01((p - 0.55) / 0.12);
          drawComet(comet, owner, u, cell.extent, PULSE_BEAD, q < 1 ? 0.26 + 0.9 * outCubic(q) * (1 - q) : 0);
        }
      },
      onComplete() {
        if (!cell || cell.owner !== owner) return;
        cell.flash = 0;
        cell.land = 0;
        cell.u.uPulseGain.value = 0;
        cell.owner = null;
        releaseComet(comet, owner);
      },
    });
  }

  function lookupMiss(key) {
    const owner = {};
    let cell = null;
    let comet = null;
    const tip = new THREE.Vector3();
    return tween({
      duration: DURATION.lookup,
      ease: linear,
      onStart() {
        // The bucket the key would live in: its home, or the first free cell
        // after it. It is empty, which is what "not found" means.
        const occupied = occupiedIndices();
        const index = occupied.has(homeBucket(key)) ? assignBucket(key, occupied) : homeBucket(key);
        if (index < 0) return;
        cell = cells[index];
        cell.owner = owner;
        setText(cell, key);
        cell.labelMiss = true;
        cell.beamMode = 'miss';
        cell.extent = 0;
        cell.vis = 1;
        // A short stub out of the port, down and toward the row.
        tip.set(0, -0.6, 0.8).normalize().multiplyScalar(1.5).add(cell.port);
        setCurve(cell.u, cell.port, tip, zero);
        cell.u.uRadius.value = MISS_RADIUS;
        cell.u.uPulseGain.value = 0;
        comet = acquireComet(owner);
      },
      onUpdate(p) {
        if (!cell || cell.owner !== owner) return;
        const flicker = 0.7 + 0.3 * Math.sin(p * 70);
        cell.miss = p < 0.08 ? outCubic(p / 0.08) : (1 - clamp01((p - 0.08) / 0.9)) ** 1.4 * flicker;
        cell.labelAlpha = 0.9 * outCubic(clamp01(p / 0.12)) * (1 - clamp01((p - 0.6) / 0.4));
        // The pulse sets out, loses speed, sputters, and dies.
        const run = outCubic(clamp01(p / 0.45));
        cell.extent = run;
        const die = clamp01((p - 0.25) / 0.3);
        cell.vis = (1 - die) * (0.65 + 0.35 * Math.sin(p * 95));
        const size = 0.44 * (1 - die) * (0.6 + 0.4 * Math.sin(p * 120));
        if (comet) drawComet(comet, owner, cell.u, run, MISS_BEAD, size, 1 + die * 6);
      },
      onComplete() {
        if (!cell || cell.owner !== owner) return;
        cell.miss = 0;
        cell.labelAlpha = 0;
        cell.labelMiss = false;
        cell.beamMode = 'gold';
        cell.u.uRadius.value = BEAM_RADIUS;
        cell.extent = cell.key !== null ? 1 : 0;
        cell.vis = 0;
        cell.owner = null;
        releaseComet(comet, owner);
      },
    });
  }

  function mapSet(key) {
    const owner = {};
    let cell = null;
    let comet = null;
    return tween({
      duration: DURATION.mapSet,
      ease: linear,
      onStart() {
        cell = cellOf(key);
        if (!cell) {
          const index = assignBucket(key, occupiedIndices());
          if (index < 0) return;
          cell = cells[index];
        }
        cell.owner = owner;
        cell.key = key;
        setText(cell, key);
        cell.labelMiss = false;
        cell.miss = 0;
        cell.beamMode = 'gold';
        cell.u.uRadius.value = BEAM_RADIUS;
        cell.beamKey = key;
        cell.extent = 0;
        cell.known = false;
        cell.vis = 0;
        comet = acquireComet(owner);
      },
      onUpdate(p) {
        if (!cell || cell.owner !== owner) return;
        // The cell switches on with a flare, the key fades up, and the beam
        // reaches out from the port to the slab with a bright tip.
        const on = clamp01(p / 0.3);
        cell.lit = outCubic(on);
        cell.flash = Math.sin(on * Math.PI) * 0.8;
        cell.labelAlpha = outCubic(clamp01((p - 0.05) / 0.3));
        const reach = outCubic(clamp01((p - 0.12) / 0.6));
        cell.extent = Math.max(reach, 0.0001);
        cell.u.uPulse.value = reach;
        cell.u.uPulseGain.value = 0.7 * (1 - clamp01((p - 0.72) / 0.28));
        cell.land = reach >= 0.98 ? Math.sin(clamp01((p - 0.7) / 0.3) * Math.PI) * 0.6 : 0;
        if (comet && cell.beam.visible) drawComet(comet, owner, cell.u, reach, PULSE_BEAD, p < 0.72 ? 0.16 : 0);
        else if (comet) hideComet(comet);
      },
      onComplete() {
        if (!cell || cell.owner !== owner) return;
        cell.lit = 1;
        cell.flash = 0;
        cell.labelAlpha = 1;
        cell.extent = 1;
        cell.land = 0;
        cell.u.uPulseGain.value = 0;
        cell.owner = null;
        releaseComet(comet, owner);
      },
    });
  }

  function mapDelete(key) {
    const owner = {};
    let cell = null;
    let fromExtent = 1;
    return tween({
      duration: DURATION.mapDelete,
      ease: linear,
      onStart() {
        cell = cellOf(key);
        if (!cell) return;
        cell.owner = owner;
        cell.key = null; // the map no longer holds it; the cell is free
        fromExtent = cell.extent;
        cell.u.uPulseGain.value = 0;
      },
      onUpdate(p) {
        if (!cell || cell.owner !== owner) return;
        // The beam pulls back into the port, the key fades, and the cell
        // gutters out.
        cell.extent = fromExtent * (1 - inOutCubic(clamp01(p / 0.6)));
        const off = clamp01((p - 0.1) / 0.8);
        cell.lit = (1 - off) ** 2 * (0.8 + 0.2 * Math.sin(p * 60));
        cell.labelAlpha = 1 - outCubic(clamp01(p / 0.55));
      },
      onComplete() {
        if (!cell || cell.owner !== owner) return;
        cell.lit = 0;
        cell.labelAlpha = 0;
        cell.extent = 0;
        cell.beamKey = null;
        cell.known = false;
        cell.vis = 0;
        cell.owner = null;
      },
    });
  }

  function setAlpha(value) {
    alpha = value;
    alphaUniform.value = value;
    root.visible = value > 0;
  }

  syncTo({ capacity: slabs.capacity(), entries: [] });

  return { setAlpha, syncTo, lookup, mapSet, mapDelete, reveal };
}
