// The cache entries: glowing crystal slabs in a row from HEAD to TAIL, their
// ghost slots and end markers, and every clip that moves or lights them.
//
// The clip rule: each clip function captures only its arguments. Slabs are
// looked up by key inside onStart, so a clip built before its slab exists (the
// animator builds a whole operation up front) still finds it, and a clip for a
// key that does not exist plays out its duration doing nothing.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { tween, seq, call, ease } from '../timeline.js';
import { createLabel } from './text.js';
import { slotX, recencyT, LIFT } from './layout.js';
import { createEffects, frameGeometry, SLAB_W, SLAB_H, SLAB_D } from './effects.js';
import { lightColor } from './links.js';

const FLOOR_Y = -1.6; // matches the floor grid in stage.js

// Recency ramp. HEAD is hot and bright, TAIL cold and dim.
const HOT = new THREE.Color('#c8f7ff');
const MID = new THREE.Color('#4aa8ff');
const COLD = new THREE.Color('#5b2a9d');
const GLOW_HOT = 1.0;
const GLOW_COLD = 0.3;
const SAT_HOT = 0.8; // how far the edge light is saturated (see SLAB_FRAGMENT)
const SAT_COLD = 0.15;
const MISS = new THREE.Color('#ff3b5c');
// Miss light: the miss red saturated so it stays red through ACES instead of
// washing out to pink, then pushed above 1 so it blooms.
const MISS_LIGHT = lightColor('#ff3b5c', 0.9, 1);
const MISS_TEXT = new THREE.Color('#ff6b82');
const EMBER_LIGHT = lightColor('#ff7a3c', 0.6, 1);
const EMBER = new THREE.Color('#ff7a3c');
const SCAN = new THREE.Color('#bff4ff');
const GHOST = new THREE.Color('#3a6fc4');
const GHOST_FILL = new THREE.Color('#0a1830');
const MARKER_POST = new THREE.Color('#2b4a7a');
const WHITE = new THREE.Color('#ffffff');
const EMOJI = /\p{Extended_Pictographic}/u;

const DURATION = {
  create: 0.6, detach: 0.6, attachHead: 0.9, update: 0.6, evict: 1.1, result: 0.4, miss: 0.48, glint: 0.2,
  scanSlot: 0.54, scanTail: 0.72,
};

const linear = ease.linear;
const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
// outBack with a tunable overshoot: s = 1.70158 is the classic 10 %.
const outBack = (t, s) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2;
const outCubic = ease.outCubic;
const inOutCubic = ease.inOutCubic;

function rampColor(t, out) {
  if (t <= 0.5) return out.lerpColors(HOT, MID, t * 2);
  return out.lerpColors(MID, COLD, (t - 0.5) * 2);
}
// The colour of light a slab gives off, at full brightness: the ramp colour
// saturated the way the shader saturates its edge light. Used for shards and
// rings, which are pure light and must keep the hue through tone mapping.
function glowColor(t, out) {
  rampColor(t, out);
  const peak = Math.max(out.r, out.g, out.b, 1e-3);
  const amount = SAT_HOT + (SAT_COLD - SAT_HOT) * t;
  const r = out.r / peak;
  const g = out.g / peak;
  const b = out.b / peak;
  return out.setRGB(r + (r * r * r - r) * amount, g + (g * g * g - g) * amount, b + (b * b * b - b) * amount);
}
const rampGlow = (t) => GLOW_HOT + (GLOW_COLD - GLOW_HOT) * t ** 0.85;

// The crystal: a dark glass body, a bright edge where the face meets the
// rounded rim, a fainter inner facet line, Fresnel light on the bevels, and a
// slow sheen. Everything bright is above 1.0 so it blooms; the face behind the
// text stays well below 1.0 so the labels read.
const SLAB_VERTEX = /* glsl */`
  varying vec3 vLocal;
  varying vec3 vLocalNormal;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vLocal = position;
    vLocalNormal = normal;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = -mv.xyz;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mv;
  }`;

const SLAB_FRAGMENT = /* glsl */`
  uniform vec3 uColor;
  uniform float uGlow;
  uniform float uFlash;
  uniform float uSat;
  uniform float uTime;
  uniform float uPhase;
  uniform float uOpacity;
  uniform float uMiss;
  uniform vec3 uMissColor;
  varying vec3 vLocal;
  varying vec3 vLocalNormal;
  varying vec3 vNormal;
  varying vec3 vView;
  const vec2 HALF = vec2(${(SLAB_W / 2).toFixed(3)}, ${(SLAB_H / 2).toFixed(3)});
  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(vView);
    float fresnel = pow(1.0 - abs(dot(n, v)), 3.0);
    float front = smoothstep(0.55, 0.95, vLocalNormal.z);
    float back = smoothstep(0.55, 0.95, -vLocalNormal.z);
    vec2 q = abs(vLocal.xy);
    float d = max(min(HALF.x - q.x, HALF.y - q.y), 0.0);
    // Edge light: the rim and bevel blaze, falling off fast across the face.
    float rim = exp(-d * 30.0) * (1.0 - back);
    // Light carried in from the edges through the glass, as in an edge-lit
    // panel: bright near the rim, dark in the middle where the text sits.
    float inner = exp(-d * 7.0) * front;
    float facet = exp(-abs(d - 0.12) * 120.0) * front * 0.45;
    // Divider under the key.
    float divider = exp(-abs(vLocal.y + 0.17) * 160.0) * smoothstep(0.42, 0.30, q.x) * front * 0.35;
    // Glass body: darker at the foot, lighter toward the top.
    float h = vLocal.y / (2.0 * HALF.y) + 0.5;
    // A slow diagonal sheen sweeping across the face.
    float band = fract((vLocal.x * 0.55 + vLocal.y * 0.4) * 0.35 - uTime * 0.06 + uPhase);
    float sheen = smoothstep(0.06, 0.0, abs(band - 0.5)) * front * 0.07;
    // The face keeps the ramp colour. The light is a saturated version of it:
    // near-white cyan pushed far above 1 would tone map to plain white and lose
    // its hue. uSat is high at HEAD and low at TAIL, where the violet needs red.
    float peak = max(max(uColor.r, uColor.g), uColor.b);
    vec3 sat = uColor * uColor / max(peak, 1e-3);
    vec3 edge = mix(uColor, sat * sat / max(peak, 1e-3), uSat);
    vec3 face = mix(uColor, sat, 0.5);
    vec3 body = face * (0.014 + 0.030 * h + inner * 0.11 + sheen) * (0.45 + 0.55 * uGlow);
    vec3 light = edge * (rim * 2.1 + fresnel * 0.9 + facet + divider) * uGlow;
    // A flash lights the edges, never the face: the key and the value must
    // survive every flare, bloom included.
    vec3 flash = uFlash * (edge * (rim * 1.7 + fresnel * 0.8) + face * 0.02);
    // A miss: the whole row answers in red, rim and bevels, "not here".
    vec3 miss = uMiss * uMissColor * (rim * 2.6 + fresnel * 1.2 + inner * 0.18);
    gl_FragColor = vec4(body * (1.0 - 0.6 * uMiss) + light * (1.0 - 0.9 * uMiss) + flash + miss, uOpacity);
  }`;

const FLOOR_FRAGMENT = /* glsl */`
  uniform vec3 uColor;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * vec2(2.0, 2.0);
    float g = exp(-dot(p * vec2(1.0, 1.5), p * vec2(1.0, 1.5)) * 3.2);
    gl_FragColor = vec4(uColor * g * uStrength, 1.0);
  }`;

const UV_VERTEX = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const KEY_HEIGHT = 0.95;
const KEY_MAX_WIDTH = 1.36;
const KEY_Y = 0.3;
const VALUE_HEIGHT = 0.52;
const VALUE_MAX_WIDTH = 1.3;
const VALUE_Y = -0.55;
const MARKER_OFFSET = SLAB_W / 2 + 0.58;

// Labels are drawn white and tinted through the material, so a slab can dim
// its text with its recency and a marker can flash red.
function fitLabel(label, maxWidth) {
  const width = label.mesh.geometry.parameters.width;
  label.mesh.scale.setScalar(Math.min(1, maxWidth / width));
}

export function createSlabs(stage) {
  const root = new THREE.Group();
  root.name = 'slabs';
  stage.scene.add(root);
  const effects = createEffects(root);

  // Shared across every slab.
  const slabGeometry = new RoundedBoxGeometry(SLAB_W, SLAB_H, SLAB_D, 5, 0.1);
  const floorGeometry = new THREE.PlaneGeometry(3.4, 2.2);
  const ghostGeometry = frameGeometry(SLAB_W + 0.16, SLAB_H + 0.16, 0.18, 0.018);
  const ghostFillGeometry = new THREE.PlaneGeometry(SLAB_W + 0.1, SLAB_H + 0.1);
  const ghostMaterial = new THREE.MeshBasicMaterial({
    color: GHOST, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const ghostFillMaterial = new THREE.MeshBasicMaterial({
    color: GHOST_FILL, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const slabMaterialTemplate = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color() },
      uGlow: { value: 1 },
      uFlash: { value: 0 },
      uSat: { value: 0.8 },
      uTime: { value: 0 },
      uPhase: { value: 0 },
      uOpacity: { value: 0.93 },
      uMiss: { value: 0 },
      uMissColor: { value: MISS_LIGHT },
    },
    vertexShader: SLAB_VERTEX,
    fragmentShader: SLAB_FRAGMENT,
    transparent: true,
  });
  const floorMaterialTemplate = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uStrength: { value: 0 } },
    vertexShader: UV_VERTEX,
    fragmentShader: FLOOR_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  let cap = 3;
  let order = [];
  let orderView = Object.freeze([]);
  const slabs = new Map(); // key -> slab record, live slabs only
  const dying = new Set(); // shattered slabs waiting for their burst to end
  let missPulse = 0;
  let phaseSeed = 0;

  function setOrder(next) {
    order = next;
    orderView = Object.freeze([...next]);
  }

  // ---- ghosts and markers ----
  const ghosts = [];
  // The empty slots power on one after another when they are built (page
  // load, a new capacity); the markers rise at the start of the sequence.
  let clock = 0;
  let ghostsBornAt = 0;
  function buildGhosts() {
    ghostsBornAt = clock;
    for (const ghost of ghosts) {
      root.remove(ghost);
      ghost.userData.material.dispose();
    }
    ghosts.length = 0;
    for (let i = 0; i < cap; i++) {
      const ghost = new THREE.Group();
      // Each slot has its own frame material, so a free slot can shimmer.
      const material = ghostMaterial.clone();
      ghost.userData.material = material;
      const frame = new THREE.Mesh(ghostGeometry, material);
      const fill = new THREE.Mesh(ghostFillGeometry, ghostFillMaterial);
      frame.renderOrder = 1;
      fill.renderOrder = 0;
      fill.position.z = -SLAB_D / 2 - 0.01;
      ghost.add(fill, frame);
      ghost.position.set(slotX(i, cap), 0, 0);
      root.add(ghost);
      ghosts.push(ghost);
    }
    head.group.position.x = slotX(0, cap) - MARKER_OFFSET;
    tail.group.position.x = slotX(cap - 1, cap) + MARKER_OFFSET;
  }

  const postGeometry = new THREE.CylinderGeometry(0.018, 0.018, 1, 8);
  const capGeometry = new THREE.OctahedronGeometry(0.085);
  const postMaterial = new THREE.MeshBasicMaterial({
    color: MARKER_POST, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  function createMarker(text, color, labelTint) {
    const group = new THREE.Group();
    const top = 1.2;
    const post = new THREE.Mesh(postGeometry, postMaterial);
    post.scale.y = top - FLOOR_Y;
    post.position.y = (top + FLOOR_Y) / 2;
    const capMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    const capMesh = new THREE.Mesh(capGeometry, capMaterial);
    capMesh.position.y = top + 0.08;
    const label = createLabel({ text, height: 0.34, weight: 700 });
    label.mesh.position.y = top + 0.42;
    label.mesh.renderOrder = 3;
    group.add(post, capMesh, label.mesh);
    root.add(group);
    return {
      group, capMesh, capMaterial, label,
      base: new THREE.Color(color), tint: new THREE.Color(labelTint),
    };
  }
  const head = createMarker('HEAD', '#c8f7ff', '#d8f8ff');
  const tail = createMarker('TAIL', '#8a5cff', '#c9b6ff');
  const markers = [head, tail];

  // ---- the miss phantom ----
  // On a miss, an outline of the key that was asked for appears above the
  // row, shakes "no", and dissolves: the row has no slab for it. It is light
  // only (additive), so it never hides a slab, and it sits low enough to stay
  // clear of the hash-map wall.
  const phantomMaterial = new THREE.MeshBasicMaterial({
    color: '#000000', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const phantomFillMaterial = new THREE.MeshBasicMaterial({
    color: '#000000', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const phantom = new THREE.Group();
  const phantomFrame = new THREE.Mesh(frameGeometry(SLAB_W, SLAB_H, 0.16, 0.05), phantomMaterial);
  const phantomFill = new THREE.Mesh(ghostFillGeometry, phantomFillMaterial);
  const phantomLabel = createLabel({ text: ' ', height: KEY_HEIGHT, weight: 700 });
  phantomFrame.renderOrder = 4;
  phantomFill.renderOrder = 4;
  phantomFill.position.z = -0.01;
  phantomLabel.mesh.position.set(0, 0.1, 0.01);
  phantomLabel.mesh.renderOrder = 5;
  phantom.add(phantomFill, phantomFrame, phantomLabel.mesh);
  phantom.visible = false;
  root.add(phantom);
  let phantomOwner = null;
  function hidePhantom() {
    phantomOwner = null;
    phantom.visible = false;
  }

  // ---- slabs ----
  function buildSlab(key, value) {
    const group = new THREE.Group();
    const bob = new THREE.Group();
    group.add(bob);
    const material = slabMaterialTemplate.clone();
    const body = new THREE.Mesh(slabGeometry, material);
    body.renderOrder = 2;
    const keyLabel = createLabel({ text: key, height: KEY_HEIGHT, weight: 700 });
    fitLabel(keyLabel, KEY_MAX_WIDTH);
    keyLabel.mesh.position.set(0, KEY_Y, SLAB_D / 2 + 0.012);
    keyLabel.mesh.renderOrder = 3;
    const valueLabel = createLabel({ text: value, height: VALUE_HEIGHT, weight: 500 });
    fitLabel(valueLabel, VALUE_MAX_WIDTH);
    // A pivot so the value can flip over on its own horizontal axis.
    const valuePivot = new THREE.Group();
    valuePivot.position.set(0, VALUE_Y, SLAB_D / 2 + 0.012);
    valuePivot.add(valueLabel.mesh);
    valueLabel.mesh.renderOrder = 3;
    bob.add(body, keyLabel.mesh, valuePivot);
    const floorMaterial = floorMaterialTemplate.clone();
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y + 0.004;
    floor.renderOrder = -4;
    // The pool lives on root, not on the slab's group: it must stay flat on
    // the floor whatever the slab does. A tilted pool dips half below the
    // floor, whose depth slices it into a hard-edged wedge.
    root.add(floor);
    root.add(group);
    phaseSeed += 1;
    return {
      key, group, bob, body, material, keyLabel, valueLabel, valuePivot, floor, floorMaterial,
      keyEmoji: EMOJI.test(key),
      heat: 0, flash: 0, ember: 0, phase: (phaseSeed * 2.399) % (Math.PI * 2), hidden: false, disposed: false,
    };
  }

  function disposeSlab(rec) {
    if (rec.disposed) return;
    rec.disposed = true;
    root.remove(rec.group);
    root.remove(rec.floor);
    rec.material.dispose();
    rec.floorMaterial.dispose();
    rec.keyLabel.dispose();
    rec.valueLabel.dispose();
  }

  // A slab that can be animated: present and not shattered.
  const live = (key) => {
    const rec = slabs.get(key);
    return rec && !rec.disposed && !rec.hidden ? rec : null;
  };

  const tmpColor = new THREE.Color();
  function applyLook(rec, elapsed) {
    const u = rec.material.uniforms;
    rampColor(rec.heat, u.uColor.value);
    const glow = rampGlow(rec.heat);
    u.uGlow.value = glow;
    u.uFlash.value = rec.flash;
    u.uSat.value = SAT_HOT + (SAT_COLD - SAT_HOT) * rec.heat;
    u.uTime.value = elapsed;
    u.uPhase.value = rec.phase;
    // The rim light for "chosen to go" (ember, before a shatter) or the
    // row-wide miss pulse (red).
    if (rec.ember > 0) {
      u.uMiss.value = rec.ember;
      u.uMissColor.value = EMBER_LIGHT;
    } else {
      u.uMiss.value = missPulse;
      u.uMissColor.value = MISS_LIGHT;
    }
    // Text: white at HEAD, a cool lavender-grey at TAIL; never above 1. An
    // emoji keeps its own colours. A flare pulls the text to pure white, so
    // the value a hit returns stays legible at the flare's peak.
    const dim = 1 - 0.3 * rec.heat;
    const lift = clamp01(rec.flash);
    tmpColor.setRGB(1, 1, 1).lerp(u.uColor.value, (0.25 + 0.2 * rec.heat) * (1 - lift)).multiplyScalar(dim + (1 - dim) * lift);
    rec.keyLabel.mesh.material.color.copy(rec.keyEmoji ? WHITE : tmpColor);
    rec.valueLabel.mesh.material.color.copy(tmpColor).multiplyScalar(0.86 + 0.14 * lift);
    // Light pool on the floor, flat under the slab; fades as the slab rises.
    const g = rec.group;
    const height = g.position.y;
    rec.floor.position.x = g.position.x;
    rec.floor.position.z = g.position.z;
    rec.floor.scale.set(g.scale.x, g.scale.x, 1);
    rec.floorMaterial.uniforms.uColor.value.copy(u.uColor.value).lerp(MISS, missPulse);
    rec.floorMaterial.uniforms.uStrength.value = (0.10 + 0.22 * glow + 0.15 * rec.flash) * g.scale.x
      * (1 - 0.45 * clamp01(height / LIFT));
  }

  // Idle life: a gentle bob and sway on the inner group (the outer group's
  // position belongs to the clips), plus the per-frame look.
  stage.addUpdater((dt, elapsed) => {
    clock = elapsed;
    const age = elapsed - ghostsBornAt;
    if (age < 3.5) {
      ghosts.forEach((ghost, i) => {
        const on = clamp01((age - 0.45 - i * 0.16) / 0.5);
        const s = Math.max(outBack(on, 1.8), 0.001);
        ghost.scale.set(s, s, 1);
      });
      markers.forEach((marker, i) => {
        const on = clamp01((age - 0.15 - i * (0.3 + ghosts.length * 0.16)) / 0.55);
        marker.group.scale.setScalar(Math.max(outBack(on, 1.4), 0.001));
      });
    }
    for (const rec of slabs.values()) {
      // LIFT equals the slab height, so a lifted slab would touch the one
      // below it; the bob rides a few centimetres higher there to keep a gap.
      const lifted = clamp01(rec.group.position.y / LIFT);
      rec.bob.position.y = Math.sin(elapsed * 1.25 + rec.phase) * 0.035 + 0.08 * lifted;
      rec.bob.rotation.x = Math.sin(elapsed * 0.9 + rec.phase * 1.3) * 0.018;
      rec.bob.rotation.z = Math.sin(elapsed * 0.7 + rec.phase * 1.7) * 0.012;
      applyLook(rec, elapsed);
    }
    // Ghosts and markers: base colour, pulled toward miss red by the pulse.
    // The red is the saturated miss light, so it reads red, not pink. Free
    // slots (past the last entry) carry a slow shimmer from HEAD to TAIL, so
    // free capacity looks alive; occupied slots never shimmer, because there
    // brightness means recency.
    const sweep = (elapsed * 0.22) % 1.6 - 0.3;
    ghosts.forEach((ghost, i) => {
      const u = cap <= 1 ? 0 : i / (cap - 1);
      const free = i >= order.length;
      const glint = free ? Math.exp(-((sweep - u) ** 2) * 40) * 0.9 : 0;
      ghost.userData.material.color.copy(GHOST).multiplyScalar(1 + glint)
        .lerp(tmpColor.copy(MISS_LIGHT).multiplyScalar(3.4), missPulse);
    });
    ghostFillMaterial.color.copy(GHOST_FILL).lerp(tmpColor.copy(MISS_LIGHT).multiplyScalar(0.35), missPulse);
    for (const marker of markers) {
      marker.capMaterial.color.copy(marker.base).multiplyScalar(2.2 + 0.4 * Math.sin(elapsed * 2.1))
        .lerp(tmpColor.copy(MISS_LIGHT).multiplyScalar(3), missPulse);
      marker.capMesh.rotation.y = elapsed * 0.8;
      marker.label.mesh.material.color.copy(marker.tint).lerp(MISS_TEXT, missPulse);
    }
    postMaterial.color.copy(MARKER_POST).lerp(tmpColor.copy(MISS_LIGHT).multiplyScalar(2), missPulse);
  });

  function positionOf(key, target = new THREE.Vector3()) {
    const rec = live(key);
    if (!rec) return null;
    return rec.bob.getWorldPosition(target);
  }

  // ---- instant rebuild ----
  function syncTo(snapshot) {
    effects.clear();
    for (const rec of slabs.values()) disposeSlab(rec);
    for (const rec of dying) disposeSlab(rec);
    slabs.clear();
    dying.clear();
    missPulse = 0;
    hidePhantom();
    if (snapshot.capacity !== cap || ghosts.length !== snapshot.capacity) {
      cap = snapshot.capacity;
      buildGhosts();
    }
    const keys = [];
    snapshot.entries.forEach(({ key, value }, i) => {
      const rec = buildSlab(key, value);
      rec.group.position.set(slotX(i, cap), 0, 0);
      rec.heat = recencyT(i, cap);
      slabs.set(key, rec);
      keys.push(key);
    });
    setOrder(keys);
  }

  // ---- clips ----
  // A clip that does nothing unless its slab exists when it starts.
  function slabTween(key, duration, { start, update, complete } = {}) {
    let rec = null;
    return tween({
      duration,
      ease: linear,
      onStart() {
        rec = live(key);
        if (rec) start?.(rec);
      },
      onUpdate(p) {
        if (rec && !rec.disposed) update?.(rec, p);
      },
      onComplete() {
        if (rec && !rec.disposed) complete?.(rec);
      },
    });
  }

  function create(key, value) {
    return tween({
      duration: DURATION.create,
      ease: linear,
      onStart() {
        const old = slabs.get(key);
        if (old) disposeSlab(old);
        const rec = buildSlab(key, value);
        rec.group.position.set(slotX(0, cap), LIFT, 0);
        rec.group.scale.setScalar(0.001);
        rec.heat = 0;
        rec.flash = 2;
        slabs.set(key, rec);
        setOrder(order.filter((k) => k !== key));
      },
      onUpdate(p) {
        const rec = live(key);
        if (!rec) return;
        // Pops in with a springy overshoot, spinning to face the viewer.
        const s = Math.max(outBack(p, 2.2), 0.001);
        rec.group.scale.set(s, s, s);
        rec.group.rotation.y = (1 - outCubic(p)) * -1.4;
        rec.flash = 2 * (1 - p) ** 2;
      },
    });
  }

  function detach(key) {
    let fromY = 0;
    return slabTween(key, DURATION.detach, {
      start(rec) {
        setOrder(order.filter((k) => k !== key));
        fromY = rec.group.position.y;
      },
      update(rec, p) {
        // A small dip of anticipation, then up with a soft overshoot.
        const dip = Math.sin(Math.min(p / 0.2, 1) * Math.PI) * -0.08 * (p < 0.2 ? 1 : 0);
        const rise = outBack(clamp01((p - 0.1) / 0.9), 1.3);
        rec.group.position.y = fromY + (LIFT - fromY) * rise + dip;
        rec.group.position.z = Math.sin(clamp01(p) * Math.PI) * 0.15;
        rec.group.rotation.x = 0.12 * outCubic(p);
        rec.flash = 0.5 * Math.sin(p * Math.PI);
      },
      complete(rec) {
        rec.flash = 0;
      },
    });
  }

  function attachHead(key) {
    const moves = [];
    let arriving = null;
    return tween({
      duration: DURATION.attachHead,
      ease: linear,
      onStart() {
        const rec = live(key);
        if (!rec) return;
        arriving = rec;
        setOrder([key, ...order.filter((k) => k !== key)]);
        // Capture every slab in the row: where it is, how hot it is, where it goes.
        order.forEach((k, i) => {
          const r = live(k);
          if (!r) return;
          moves.push({
            rec: r,
            from: r.group.position.clone(),
            fromRotX: r.group.rotation.x,
            fromRotY: r.group.rotation.y,
            fromHeat: r.heat,
            toX: slotX(i, cap),
            toHeat: recencyT(i, cap),
          });
        });
      },
      onUpdate(p) {
        for (const m of moves) {
          const { rec } = m;
          if (rec.disposed) continue;
          const g = rec.group;
          if (rec === arriving) {
            // An arc: up and out toward the viewer, then down into slot 0,
            // landing with a small overshoot below the line and a squash.
            const travel = outBack(p, 0.9);
            g.position.x = m.from.x + (m.toX - m.from.x) * travel;
            const fall = outBack(clamp01((p - 0.25) / 0.75), 1.6);
            const arc = Math.sin(clamp01(p / 0.8) * Math.PI) * 0.55;
            g.position.y = m.from.y * (1 - fall) + arc;
            g.position.z = m.from.z + (0 - m.from.z) * p + Math.sin(p * Math.PI) * 0.9;
            g.rotation.x = m.fromRotX * (1 - outCubic(p)) - Math.sin(p * Math.PI) * 0.12;
            g.rotation.y = m.fromRotY * (1 - p);
            g.rotation.z = Math.sin(p * Math.PI) * 0.1 * Math.sign(m.from.x - m.toX || 1);
            const land = clamp01((p - 0.78) / 0.22);
            const squash = Math.sin(land * Math.PI) * 0.05;
            g.scale.set(1 + squash, 1 - squash, 1 + squash);
            rec.flash = 0.6 * Math.sin(p * Math.PI);
          } else {
            // Neighbours slide along the row, starting a beat late.
            const q = outBack(clamp01((p - 0.12) / 0.75), 1.1);
            g.position.x = m.from.x + (m.toX - m.from.x) * q;
            g.position.y = m.from.y * (1 - q);
            g.position.z = m.from.z * (1 - q);
          }
          rec.heat = m.fromHeat + (m.toHeat - m.fromHeat) * inOutCubic(p);
        }
      },
      onComplete() {
        for (const m of moves) {
          if (m.rec.disposed) continue;
          const g = m.rec.group;
          g.position.set(m.toX, 0, 0);
          g.rotation.set(0, 0, 0);
          g.scale.set(1, 1, 1);
          m.rec.heat = m.toHeat;
          m.rec.flash = 0;
        }
      },
    });
  }

  function update(key, value) {
    let swapped = false;
    return slabTween(key, DURATION.update, {
      update(rec, p) {
        // Flip closed on the horizontal axis, swap the text edge-on, flip open.
        if (p < 0.5) {
          rec.valuePivot.rotation.x = (Math.PI / 2) * ease.inCubic(p / 0.5);
        } else {
          if (!swapped) {
            swapped = true;
            rec.valueLabel.setText(value);
            fitLabel(rec.valueLabel, VALUE_MAX_WIDTH);
          }
          rec.valuePivot.rotation.x = (-Math.PI / 2) * (1 - outBack((p - 0.5) / 0.5, 2.0));
        }
        rec.flash = 0.9 * Math.sin(p * Math.PI) ** 2;
      },
      complete(rec) {
        rec.valuePivot.rotation.x = 0;
        rec.flash = 0;
      },
    });
  }

  // The TAIL slab is chosen: for the first part of the clip it heats to ember
  // and trembles, unlinked from the list; then it shatters.
  const EVICT_WINDUP = 0.2;
  function evict(key) {
    let burst = null;
    let ring = null;
    let rec = null;
    let homeX = 0;
    const owner = {};
    const at = new THREE.Vector3();
    const color = new THREE.Color();
    const shatterTime = DURATION.evict * (1 - EVICT_WINDUP);
    return tween({
      duration: DURATION.evict,
      ease: linear,
      onStart() {
        rec = live(key);
        if (!rec) return;
        setOrder(order.filter((k) => k !== key));
        homeX = rec.group.position.x;
      },
      onUpdate(p) {
        if (!rec) return;
        if (p < EVICT_WINDUP) {
          if (rec.disposed) return;
          const w = p / EVICT_WINDUP;
          rec.ember = outCubic(w);
          rec.group.position.x = homeX + Math.sin(w * Math.PI * 7) * 0.035 * w;
          return;
        }
        if (!burst && !rec.disposed) {
          rec.group.position.x = homeX;
          rec.ember = 0;
          rec.bob.getWorldPosition(at);
          glowColor(rec.heat, color);
          rec.hidden = true;
          rec.group.visible = false;
          rec.floor.visible = false; // the pool is not in the group: hide it too
          if (slabs.get(key) === rec) slabs.delete(key);
          dying.add(rec);
          burst = effects.shatter(at, color, shatterTime);
          ring = effects.acquireRing(owner);
        }
        if (!burst) return;
        const q = (p - EVICT_WINDUP) / (1 - EVICT_WINDUP);
        burst.update(q * shatterTime);
        if (ring) effects.drawRing(ring, owner, at, EMBER, clamp01(q / 0.55), { grow: 0.9, strength: 2 });
      },
      onComplete() {
        burst?.dispose();
        if (ring) effects.releaseRing(ring, owner);
        if (rec) {
          dying.delete(rec);
          disposeSlab(rec);
        }
      },
    });
  }

  function miss(key) {
    const owner = {};
    return tween({
      duration: DURATION.miss,
      ease: linear,
      onStart() {
        phantomOwner = owner;
        phantomLabel.setText(key ?? '?');
        fitLabel(phantomLabel, KEY_MAX_WIDTH);
        phantom.visible = true;
      },
      onUpdate(p) {
        // The row: a fast red attack, a slower release.
        missPulse = p < 0.14 ? outCubic(p / 0.14) : (1 - (p - 0.14) / 0.86) ** 1.6;
        if (phantomOwner !== owner) return;
        // The phantom: snaps in, shakes its head, sinks a little and fades.
        const appear = outCubic(clamp01(p / 0.14));
        const fade = 1 - clamp01((p - 0.5) / 0.5) ** 1.5;
        const strength = appear * fade;
        const s = 0.78 * (1.12 - 0.12 * appear) * (1 - 0.08 * clamp01((p - 0.5) / 0.5));
        phantom.scale.set(s, s, s);
        phantom.position.set(
          Math.sin(clamp01((p - 0.1) / 0.6) * Math.PI * 4) * 0.16 * (1 - clamp01((p - 0.1) / 0.6)),
          2.15 - 0.25 * clamp01((p - 0.5) / 0.5),
          0.9,
        );
        phantomMaterial.color.copy(MISS_LIGHT).multiplyScalar(2.6 * strength);
        phantomFillMaterial.color.copy(MISS).multiplyScalar(0.05 * strength);
        phantomLabel.mesh.material.color.copy(MISS_TEXT).multiplyScalar(strength);
      },
      onComplete() {
        missPulse = 0;
        if (phantomOwner === owner) hidePhantom();
      },
    });
  }

  function result(kind, key) {
    if (kind === 'miss') return miss(key);
    // Two halos: a bright one that leaps out, and a softer echo a beat later.
    const owners = [{}, {}];
    const rings = [null, null];
    const at = new THREE.Vector3();
    const color = new THREE.Color();
    return slabTween(key, DURATION.result, {
      start(rec) {
        rings[0] = effects.acquireRing(owners[0]);
        rings[1] = effects.acquireRing(owners[1]);
        glowColor(rec.heat, color);
      },
      update(rec, p) {
        // Fast attack, slow release: a spike of light that settles. The
        // halos carry most of the burst; the slab's own flash stays low
        // enough that its bloom never smothers the key and the value.
        rec.flash = p < 0.12 ? 1.1 * outCubic(p / 0.12) : 1.1 * (1 - (p - 0.12) / 0.88) ** 2.2;
        rec.bob.getWorldPosition(at);
        effects.drawRing(rings[0], owners[0], at, color, p, { grow: 0.6, strength: 3.0 });
        const echo = clamp01((p - 0.22) / 0.78);
        effects.drawRing(rings[1], owners[1], at, color, echo, { grow: 0.3, strength: echo > 0 ? 1.8 : 0 });
        const s = 1 + 0.05 * Math.sin(clamp01(p / 0.6) * Math.PI);
        rec.group.scale.set(s, s, s);
      },
      complete(rec) {
        rec.flash = 0;
        rec.group.scale.set(1, 1, 1);
        effects.releaseRing(rings[0], owners[0]);
        effects.releaseRing(rings[1], owners[1]);
      },
    });
  }

  function glint(key) {
    return slabTween(key, DURATION.glint, {
      update(rec, p) { rec.flash = 1.2 * Math.sin(p * Math.PI); },
      complete(rec) { rec.flash = 0; },
    });
  }

  function scan({ onVisit } = {}) {
    const owner = {};
    const hl = effects.highlight;
    const mesh = hl.mesh;
    let keys = [];
    let visited = 0;
    let last = null;
    const target = new THREE.Vector3();
    const from = new THREE.Vector3();

    const begin = call(() => {
      keys = [...order];
      visited = 0;
      last = null;
      hl.acquire(owner);
    });

    const slots = [];
    for (let i = 0; i < cap; i++) {
      let rec = null;
      let landed = false;
      let first = false;
      slots.push(tween({
        duration: DURATION.scanSlot,
        ease: linear,
        onStart() {
          rec = i < keys.length ? live(keys[i]) : null;
          if (!rec || !hl.owns(owner)) rec = null;
          if (!rec) return;
          first = last === null;
          from.copy(mesh.position);
        },
        onUpdate(p) {
          if (!hl.owns(owner)) return;
          if (!rec || rec.disposed) {
            // An empty slot: the frame waits on the slab it last visited.
            if (last && !last.disposed) {
              last.bob.getWorldPosition(mesh.position);
              mesh.position.z += 0.2;
            }
            return;
          }
          rec.bob.getWorldPosition(target);
          target.z += 0.2;
          const glide = clamp01(p / 0.4);
          if (first) {
            mesh.position.copy(target);
            const s = 1.25 - 0.25 * outCubic(glide);
            mesh.scale.set(s, s, 1);
            mesh.material.color.copy(SCAN).multiplyScalar(1.5 * outCubic(glide));
          } else {
            mesh.position.lerpVectors(from, target, inOutCubic(glide));
            mesh.position.y += Math.sin(glide * Math.PI) * 0.25;
            const pulse = landed ? Math.exp(-(p - 0.4) * 14) * 0.08 : 0;
            mesh.scale.set(1 + pulse, 1 + pulse, 1);
            mesh.material.color.copy(SCAN).multiplyScalar(1.5 + (landed ? 1.2 * Math.exp(-(p - 0.4) * 12) : 0));
          }
          mesh.visible = true;
          if (!landed && glide >= 1) {
            landed = true;
            last = rec;
            visited += 1;
            rec.flash = 0.6;
            onVisit?.(visited);
          }
          if (landed) rec.flash = 0.6 * Math.exp(-(p - 0.4) * 10);
        },
        onComplete() {
          if (rec && !rec.disposed) rec.flash = 0;
        },
      }));
    }

    const mark = tween({
      duration: DURATION.scanTail,
      ease: linear,
      onUpdate(p) {
        if (!last || last.disposed || !hl.owns(owner)) return;
        // The least recently used entry: the frame burns ember and beats twice.
        last.bob.getWorldPosition(target);
        target.z += 0.2;
        mesh.position.copy(target);
        const beat = Math.abs(Math.sin(p * Math.PI * 2));
        const s = 1 + 0.07 * beat;
        mesh.scale.set(s, s, 1);
        mesh.material.color.copy(SCAN).lerp(EMBER, outCubic(clamp01(p / 0.3)))
          .multiplyScalar(1.6 + 1.2 * beat);
        last.flash = 0.6 * beat;
      },
      onComplete() {
        if (last && !last.disposed) last.flash = 0;
        hl.release(owner);
      },
    });

    return seq(begin, ...slots, mark);
  }

  syncTo({ capacity: cap, entries: [] });

  return {
    syncTo,
    create,
    detach,
    attachHead,
    update,
    evict,
    result,
    glint,
    scan,
    order: () => orderView,
    positionOf,
    // Where the HEAD ('head') or TAIL ('tail') marker post stands, at row height.
    markerPosition: (which, target = new THREE.Vector3()) => target.copy((which === 'head' ? head : tail).group.position),
    capacity: () => cap,
  };
}
