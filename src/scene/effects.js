// Slab effects: shatter shards, expanding halo rings, and the scan highlight.
// Everything here is owned by slabs.js, which drives it from its clips and
// wipes it with clear() whenever the scene is rebuilt.
import * as THREE from 'three';

export const SLAB_W = 1.5;
export const SLAB_H = 2.0;
export const SLAB_D = 0.35;

const EMBER = new THREE.Color('#ff7a3c');
const SHARDS_PER_BURST = 120;
const BURST_SLOTS = 3; // concurrent shatters; a fourth steals the oldest slot
const RING_POOL = 6;

// Additive, unlit, no depth writes: the effects are light, not matter.
function glowMaterial(color = '#ffffff') {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

function roundedRect(path, w, h, r) {
  const x = -w / 2;
  const y = -h / 2;
  path.moveTo(x + r, y);
  path.lineTo(x + w - r, y);
  path.quadraticCurveTo(x + w, y, x + w, y + r);
  path.lineTo(x + w, y + h - r);
  path.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  path.lineTo(x + r, y + h);
  path.quadraticCurveTo(x, y + h, x, y + h - r);
  path.lineTo(x, y + r);
  path.quadraticCurveTo(x, y, x + r, y);
  return path;
}

// A flat rounded-rectangle outline of the given stroke width, in the XY plane.
export function frameGeometry(w, h, r, stroke) {
  const shape = roundedRect(new THREE.Shape(), w, h, r);
  shape.holes.push(roundedRect(new THREE.Path(), w - stroke * 2, h - stroke * 2, Math.max(r - stroke, 0.005)));
  return new THREE.ShapeGeometry(shape, 8);
}

// Scratch objects for per-frame maths: nothing is allocated while animating.
const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();
const scratchAxis = new THREE.Vector3();
const scratchColor = new THREE.Color();
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);
const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

export function createEffects(root) {
  const ringGeometry = frameGeometry(SLAB_W + 0.06, SLAB_H + 0.06, 0.16, 0.045);
  const highlightGeometry = frameGeometry(SLAB_W + 0.34, SLAB_H + 0.34, 0.24, 0.05);

  // ---- shards ----
  // One InstancedMesh for every shard there will ever be: BURST_SLOTS ranges
  // of SHARDS_PER_BURST instances, all per-shard data preallocated. An idle
  // instance has a zero matrix, so it draws nothing.
  const total = SHARDS_PER_BURST * BURST_SLOTS;
  // A sliver: a tetrahedron squashed per instance into a thin, uneven shard.
  const shards = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(1, 0), glowMaterial(), total);
  shards.frustumCulled = false;
  shards.renderOrder = 5;
  shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < total; i++) {
    shards.setMatrixAt(i, ZERO_MATRIX);
    shards.setColorAt(i, scratchColor.setRGB(0, 0, 0));
  }
  shards.instanceColor.setUsage(THREE.DynamicDrawUsage);
  root.add(shards);
  const start = new Float32Array(total * 3);
  const velocity = new Float32Array(total * 3);
  const axis = new Float32Array(total * 3);
  const spin = new Float32Array(total);
  const size = new Float32Array(total * 3);
  const burn = new Float32Array(total); // how early each shard turns to ember
  const heat = new Float32Array(total); // sparks burn hotter than chunks

  let burstClock = 0;
  const slots = [];
  for (let k = 0; k < BURST_SLOTS; k++) {
    const slot = { index: k, owner: null, used: 0, tint: new THREE.Color(), duration: 1 };
    slots.push(slot);
  }

  function clearSlot(slot) {
    slot.owner = null;
    const from = slot.index * SHARDS_PER_BURST;
    for (let i = from; i < from + SHARDS_PER_BURST; i++) shards.setMatrixAt(i, ZERO_MATRIX);
    shards.instanceMatrix.needsUpdate = true;
  }

  function drawSlot(slot, t) {
    const life = Math.min(t / slot.duration, 1);
    const drag = 2.2;
    const travel = (1 - Math.exp(-drag * t)) / drag;
    const fall = 1.5 * t * t;
    const from = slot.index * SHARDS_PER_BURST;
    // White-hot for an instant, then the slab's colour, then ember.
    const flash = 1 + 0.8 * Math.exp(-t * 16);
    // Embers stay above the bloom threshold and die by shrinking, so the burst
    // ends as glowing sparks winking out, not as dull flakes.
    const dim = 1 - 0.55 * smoothstep(0.45, 1, life);
    for (let i = from; i < from + SHARDS_PER_BURST; i++) {
      const i3 = i * 3;
      scratchPosition.set(
        start[i3] + velocity[i3] * travel,
        start[i3 + 1] + velocity[i3 + 1] * travel - fall,
        start[i3 + 2] + velocity[i3 + 2] * travel,
      );
      scratchAxis.set(axis[i3], axis[i3 + 1], axis[i3 + 2]);
      scratchQuaternion.setFromAxisAngle(scratchAxis, spin[i] * travel * 1.8 + i);
      const shrink = 1 - smoothstep(0.35 + burn[i], 1, life);
      scratchScale.set(size[i3] * shrink, size[i3 + 1] * shrink, size[i3 + 2] * shrink);
      scratchMatrix.compose(scratchPosition, scratchQuaternion, scratchScale);
      shards.setMatrixAt(i, scratchMatrix);
      const ember = Math.min(life / burn[i], 1);
      scratchColor.copy(slot.tint).lerp(EMBER, ember * ember);
      scratchColor.multiplyScalar(heat[i] * flash * dim);
      shards.setColorAt(i, scratchColor);
    }
    shards.instanceMatrix.needsUpdate = true;
    shards.instanceColor.needsUpdate = true;
  }

  // Shards start inside the slab's volume, so the first frame still reads as
  // the slab; then they blow outward and a little up, tumble, burn from the
  // slab's colour to ember, and wink out. Returns a handle whose update(t)
  // takes seconds since the shatter; it does nothing once its slot is reused
  // or cleared.
  function shatter(origin, color, duration) {
    let slot = slots.find((s) => s.owner === null);
    if (!slot) slot = slots.reduce((a, b) => (a.used <= b.used ? a : b));
    const owner = {};
    slot.owner = owner;
    slot.used = ++burstClock;
    slot.duration = duration;
    // Normalise the colour to full brightness: a dim TAIL slab still shatters
    // in its own hue, not in a muddy dark version of it.
    const peak = Math.max(color.r, color.g, color.b, 1e-3);
    slot.tint.copy(color).multiplyScalar(1 / peak);
    const from = slot.index * SHARDS_PER_BURST;
    for (let i = from; i < from + SHARDS_PER_BURST; i++) {
      const i3 = i * 3;
      const lx = (Math.random() - 0.5) * SLAB_W;
      const ly = (Math.random() - 0.5) * SLAB_H;
      const lz = (Math.random() - 0.5) * SLAB_D;
      start[i3] = origin.x + lx;
      start[i3 + 1] = origin.y + ly;
      start[i3 + 2] = origin.z + lz;
      // Outward from the centre, biased up and toward the viewer.
      const spark = i - from < SHARDS_PER_BURST * 0.3; // a third are small fast sparks
      const speed = (spark ? 2.6 : 1.1) + Math.random() * (spark ? 2.4 : 1.5);
      const len = Math.hypot(lx, ly * 0.8, lz) || 1;
      velocity[i3] = (lx / len) * speed + (Math.random() - 0.5) * 0.8;
      velocity[i3 + 1] = (ly / len) * speed * 0.8 + 1.3 + Math.random() * 1.2;
      velocity[i3 + 2] = (lz / len) * speed * 0.6 + 0.4 + Math.random() * 1.6;
      scratchAxis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      axis[i3] = scratchAxis.x;
      axis[i3 + 1] = scratchAxis.y;
      axis[i3 + 2] = scratchAxis.z;
      spin[i] = (4 + Math.random() * 10) * (Math.random() < 0.5 ? -1 : 1);
      const s = spark ? 0.022 + Math.random() * 0.022 : 0.05 + Math.random() * 0.1;
      size[i3] = s * (0.5 + Math.random() * 0.7);
      size[i3 + 1] = s * (0.9 + Math.random() * 1.1);
      size[i3 + 2] = s * 0.25;
      burn[i] = spark ? 0.15 + Math.random() * 0.15 : 0.3 + Math.random() * 0.35;
      heat[i] = spark ? 2.4 : 1.2 + Math.random() * 0.5;
    }
    drawSlot(slot, 0);
    return {
      update(t) { if (slot.owner === owner) drawSlot(slot, t); },
      dispose() { if (slot.owner === owner) clearSlot(slot); },
    };
  }

  // Rings: a small pool of halo outlines that grow out from a slab and fade.
  const rings = [];
  for (let i = 0; i < RING_POOL; i++) {
    const mesh = new THREE.Mesh(ringGeometry, glowMaterial());
    mesh.visible = false;
    mesh.renderOrder = 4;
    root.add(mesh);
    rings.push({ mesh, owner: null, used: 0 });
  }
  let ringClock = 0;

  function acquireRing(owner) {
    let ring = rings.find((r) => r.owner === null);
    if (!ring) ring = rings.reduce((a, b) => (a.used <= b.used ? a : b));
    ring.owner = owner;
    ring.used = ++ringClock;
    return ring;
  }

  // Draw a ring at a position, `p` in 0..1 of its life. Returns false if
  // someone else has taken the ring since.
  function drawRing(ring, owner, position, color, p, { grow = 0.45, strength = 2.4 } = {}) {
    if (ring.owner !== owner) return false;
    const s = 1 + grow * (1 - (1 - p) ** 3);
    ring.mesh.position.copy(position);
    ring.mesh.scale.set(s, 1 + (s - 1) * (SLAB_W / SLAB_H), 1);
    ring.mesh.material.color.copy(color).multiplyScalar(strength * (1 - p) ** 2);
    ring.mesh.visible = p < 1;
    return true;
  }

  function releaseRing(ring, owner) {
    if (ring.owner !== owner) return;
    ring.owner = null;
    ring.mesh.visible = false;
  }

  // The scan highlight: one frame, owned by one scan at a time.
  const highlight = new THREE.Mesh(highlightGeometry, glowMaterial());
  highlight.visible = false;
  highlight.renderOrder = 6;
  root.add(highlight);
  let highlightOwner = null;

  function clear() {
    for (const slot of slots) clearSlot(slot);
    for (const ring of rings) {
      ring.owner = null;
      ring.mesh.visible = false;
    }
    highlightOwner = null;
    highlight.visible = false;
  }

  return {
    shatter,
    acquireRing,
    drawRing,
    releaseRing,
    highlight: {
      mesh: highlight,
      acquire(owner) { highlightOwner = owner; },
      owns: (owner) => highlightOwner === owner,
      release(owner) {
        if (highlightOwner !== owner) return;
        highlightOwner = null;
        highlight.visible = false;
      },
    },
    clear,
  };
}
