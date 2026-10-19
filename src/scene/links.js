// The doubly linked list made visible: for every pair of neighbours in the
// row, a cyan `next` tube (above centre, flowing toward TAIL) and a violet
// `prev` tube (below centre, flowing toward HEAD), each ending in a small
// arrowhead and carrying beads of light in its pointer's direction. The HEAD
// and TAIL markers are the list's sentinels and get dimmer tubes of their own.
//
// The tubes are not clips. Every frame they read slabs.order() and the live
// slab positions, so they follow slabs in flight. When the set of neighbour
// pairs changes, the old tubes let go (retract into the node that owned the
// pointer) and the new ones shoot out from their owner to their target.
//
// Also exported for hashmap.js: the filament shader (a tube bent along a
// quadratic curve on the GPU, so no geometry is rebuilt per frame) and a pool
// of glowing points.
import * as THREE from 'three';
import { SLAB_W } from './effects.js';

// ---- shared kit ----

const BODY_RINGS = 32;
const RADIAL = 8;

// A unit tube described in curve space. Each ring has a parameter (0..1 along
// the body, or 1 = shoulder / 0 = tip for the two arrowhead rings) and a head
// flag; each vertex has its unit radial offset in position.yz. The vertex
// shader places it along the curve.
export function filamentGeometry() {
  const rings = [];
  for (let i = 0; i <= BODY_RINGS; i++) rings.push([i / BODY_RINGS, 0]);
  rings.push([1, 1], [0, 1]); // arrowhead shoulder, tip
  const positions = new Float32Array(rings.length * RADIAL * 3);
  const path = new Float32Array(rings.length * RADIAL * 2);
  rings.forEach(([s, head], r) => {
    for (let j = 0; j < RADIAL; j++) {
      const a = (j / RADIAL) * Math.PI * 2;
      const v = r * RADIAL + j;
      positions[v * 3] = 0;
      positions[v * 3 + 1] = Math.cos(a);
      positions[v * 3 + 2] = Math.sin(a);
      path[v * 2] = s;
      path[v * 2 + 1] = head;
    }
  });
  const index = [];
  for (let r = 0; r < rings.length - 1; r++) {
    for (let j = 0; j < RADIAL; j++) {
      const a = r * RADIAL + j;
      const b = r * RADIAL + ((j + 1) % RADIAL);
      const c = a + RADIAL;
      const d = b + RADIAL;
      index.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aPath', new THREE.BufferAttribute(path, 2));
  geometry.setIndex(index);
  return geometry;
}

const FILAMENT_VERTEX = /* glsl */`
  attribute vec2 aPath;
  uniform vec3 uA;
  uniform vec3 uB;
  uniform vec3 uC;
  uniform float uRadius;
  uniform float uHeadLen;
  uniform float uHeadRadius;
  uniform float uExtent;
  uniform float uLen;
  varying float vT;
  varying float vHead;
  varying vec3 vRadial;
  varying vec3 vWorld;
  vec3 bez(float t) { float s = 1.0 - t; return s * s * uA + 2.0 * s * t * uC + t * t * uB; }
  vec3 bezD(float t) { return 2.0 * (1.0 - t) * (uC - uA) + 2.0 * t * (uB - uC); }
  void main() {
    float L = max(uLen, 1e-4);
    // The arrowhead keeps its size in world units, shrinking only on a tube
    // too short to hold it (one that is still growing out).
    float hl = min(uHeadLen, L * uExtent * 0.5);
    float tTip = uExtent;
    float tBody = max(tTip - hl / L, 0.0);
    float t;
    float r;
    if (aPath.y < 0.5) {
      t = aPath.x * tBody;
      r = uRadius;
    } else {
      t = tTip - aPath.x * (hl / L);
      r = uHeadLen > 0.0 ? uHeadRadius * aPath.x * (hl / uHeadLen) : 0.0;
    }
    vec3 T = bezD(t);
    T = length(T) < 1e-5 ? vec3(1.0, 0.0, 0.0) : normalize(T);
    vec3 ref = abs(T.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 N = normalize(cross(T, ref));
    vec3 Bn = cross(T, N);
    vec3 radial = N * position.y + Bn * position.z;
    vec3 world = bez(t) + radial * r;
    vT = t;
    vHead = aPath.y;
    vRadial = radial;
    vWorld = world;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }`;

const FILAMENT_FRAGMENT = /* glsl */`
  uniform vec3 uColor;
  uniform vec3 uPulseColor;
  uniform float uOpacity;
  uniform float uAlpha;
  uniform float uLen;
  uniform float uFlow;
  uniform float uSpacing;
  uniform float uFlowGain;
  uniform float uPulse;
  uniform float uPulseGain;
  varying float vT;
  varying float vHead;
  varying vec3 vRadial;
  varying vec3 vWorld;
  void main() {
    vec3 n = normalize(vRadial);
    vec3 v = normalize(cameraPosition - vWorld);
    // A filament: a hot line down the middle, softer toward the silhouette.
    float facing = abs(dot(n, v));
    float core = 0.25 + 0.75 * facing * facing;
    // Light flowing along the pointer: a short comet tail behind each bead.
    float s = vT * uLen;
    float u = fract((s - uFlow) / uSpacing);
    float dash = pow(u, 9.0) * uFlowGain;
    // A pulse: a bright head with a tail behind it.
    float d = (uPulse - vT) * uLen;
    float pulse = d >= 0.0 ? exp(-d * 1.3) : exp(d * 30.0);
    vec3 color = uColor * (core * (1.0 + vHead * 0.5) + dash) + uPulseColor * pulse * uPulseGain * (0.4 + 0.6 * core);
    gl_FragColor = vec4(color * uOpacity * uAlpha, 1.0);
  }`;

// One material per filament (its own endpoints), sharing the alpha uniform of
// its module.
export function filamentMaterial(alphaUniform) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uA: { value: new THREE.Vector3() },
      uB: { value: new THREE.Vector3(1, 0, 0) },
      uC: { value: new THREE.Vector3(0.5, 0, 0) },
      uRadius: { value: 0.02 },
      uHeadLen: { value: 0 },
      uHeadRadius: { value: 0 },
      uExtent: { value: 1 },
      uLen: { value: 1 },
      uColor: { value: new THREE.Color() },
      uPulseColor: { value: new THREE.Color() },
      uOpacity: { value: 1 },
      uAlpha: alphaUniform,
      uFlow: { value: 0 },
      uSpacing: { value: 1 },
      uFlowGain: { value: 0 },
      uPulse: { value: 0 },
      uPulseGain: { value: 0 },
    },
    vertexShader: FILAMENT_VERTEX,
    fragmentShader: FILAMENT_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

// Sets a filament's curve: from a to b, bowed by `bow` (a world-space offset
// at the midpoint). Returns the chord length.
export function setCurve(u, a, b, bow) {
  u.uA.value.copy(a);
  u.uB.value.copy(b);
  u.uC.value.addVectors(a, b).multiplyScalar(0.5).add(bow);
  const len = a.distanceTo(b);
  u.uLen.value = len;
  return len;
}

// The CPU twin of the shader's curve, for things that ride a filament.
export function curvePoint(u, t, out) {
  const s = 1 - t;
  const A = u.uA.value;
  const B = u.uB.value;
  const C = u.uC.value;
  return out.set(
    s * s * A.x + 2 * s * t * C.x + t * t * B.x,
    s * s * A.y + 2 * s * t * C.y + t * t * B.y,
    s * s * A.z + 2 * s * t * C.z + t * t * B.z,
  );
}

// A pool of soft glowing points with a hot core, sized in world units.
export function createGlowPoints(count, alphaUniform) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const color = new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage);
  const size = new THREE.BufferAttribute(sizes, 1).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', position);
  geometry.setAttribute('aColor', color);
  geometry.setAttribute('aSize', size);
  const scale = { value: 1 };
  const material = new THREE.ShaderMaterial({
    uniforms: { uScale: scale, uAlpha: alphaUniform },
    vertexShader: /* glsl */`
      attribute vec3 aColor;
      attribute float aSize;
      uniform float uScale;
      varying vec3 vColor;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
        vColor = aColor;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uAlpha;
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0) discard;
        float glow = exp(-d * d * 5.0) * (1.0 - d) + exp(-d * d * 40.0) * 0.8;
        gl_FragColor = vec4(vColor * glow * uAlpha, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const object = new THREE.Points(geometry, material);
  object.frustumCulled = false;
  object.renderOrder = 6;
  return {
    object,
    set(i, p, c, s) {
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
      sizes[i] = s;
    },
    hide(i) { sizes[i] = 0; },
    // Pixels per world unit at distance 1, from the camera and the canvas.
    frame(camera, canvas) {
      scale.value = canvas.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
      position.needsUpdate = true;
      color.needsUpdate = true;
      size.needsUpdate = true;
    },
  };
}

// A colour of pure light: the hue saturated (each channel squared against the
// peak) so it survives ACES tone mapping, then scaled above display white.
export function lightColor(hex, saturate, gain) {
  const c = new THREE.Color(hex);
  const peak = Math.max(c.r, c.g, c.b, 1e-3);
  const r = c.r / peak;
  const g = c.g / peak;
  const b = c.b / peak;
  return c.setRGB(r + (r * r - r) * saturate, g + (g * g - g) * saturate, b + (b * b - b) * saturate).multiplyScalar(gain);
}

// ---- the list ----

const NEXT = lightColor('#7de3ff', 0.55, 1.9);
const PREV = lightColor('#b48cff', 0.6, 1.9);
const NEXT_BEAD = lightColor('#7de3ff', 0.35, 4.2);
const PREV_BEAD = lightColor('#b48cff', 0.4, 4.2);
const SENTINEL_DIM = 0.42; // tubes to and from the HEAD and TAIL markers

const EDGE = SLAB_W / 2 - 0.02; // a tube meets a slab at its side edge
const LANE = 0.24; // next runs this far above centre, prev this far below
const RADIUS = 0.024;
const HEAD_LEN = 0.17;
const HEAD_RADIUS = 0.065;
const FLOW_SPEED = 1.1; // world units per second
const SPACING = 0.42;
const BEADS = 8; // per tube
const POOL = 48; // tubes: 9 live pairs at capacity 8, times two, plus the ones fading
const GROW = 0.3; // seconds for a new pointer to reach its target
const GROW_DELAY = 0.08; // so the old pointers visibly let go first
const RETRACT = 0.25;

const HEAD_END = Symbol('HEAD');
const TAIL_END = Symbol('TAIL');

const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
const outCubic = (t) => 1 - (1 - t) ** 3;
const inOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function createLinks(stage, slabs) {
  const root = new THREE.Group();
  root.name = 'links';
  stage.scene.add(root);
  const alphaUniform = { value: 1 };

  const geometry = filamentGeometry();
  const beads = createGlowPoints(POOL * BEADS, alphaUniform);
  root.add(beads.object);

  const tubes = [];
  for (let i = 0; i < POOL; i++) {
    const material = filamentMaterial(alphaUniform);
    const u = material.uniforms;
    u.uRadius.value = RADIUS;
    u.uHeadLen.value = HEAD_LEN;
    u.uHeadRadius.value = HEAD_RADIUS;
    u.uSpacing.value = SPACING;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false; // the geometry is in curve space, not world space
    mesh.visible = false;
    mesh.renderOrder = 1;
    root.add(mesh);
    tubes.push({
      index: i, mesh, u,
      state: 'free', // 'in' (growing), 'on', 'out' (retracting)
      kind: 'next', from: null, to: null, sentinel: false,
      grow: 0, delay: 0, flow: 0,
      a: new THREE.Vector3(), b: new THREE.Vector3(), known: false,
    });
  }

  function freeTube(tube) {
    tube.state = 'free';
    tube.mesh.visible = false;
    tube.from = null;
    tube.to = null;
    tube.known = false;
    for (let k = 0; k < BEADS; k++) beads.hide(tube.index * BEADS + k);
  }

  // The tubes the current order calls for, as [kind, from, to] triples.
  function wanted() {
    const nodes = [HEAD_END, ...slabs.order(), TAIL_END];
    const list = [];
    for (let i = 0; i + 1 < nodes.length; i++) {
      list.push(['next', nodes[i], nodes[i + 1]], ['prev', nodes[i + 1], nodes[i]]);
    }
    return list;
  }

  // While the internals are revealed (see reveal()), tube growth follows the
  // reveal's progress instead of the clock.
  let revealP = null;

  let seenOrder = null;
  function relink(instant) {
    seenOrder = slabs.order();
    const keep = new Set();
    for (const [kind, from, to] of wanted()) {
      let tube = tubes.find((t) => t.state !== 'free' && t.kind === kind && t.from === from && t.to === to);
      if (tube) {
        if (tube.state === 'out') tube.state = 'in';
      } else {
        tube = tubes.find((t) => t.state === 'free')
          // Pool exhausted: take the retracting tube that is nearly gone.
          ?? tubes.filter((t) => t.state === 'out').reduce((x, y) => (!x || y.grow < x.grow ? y : x), null);
        if (!tube) continue;
        freeTube(tube);
        tube.kind = kind;
        tube.from = from;
        tube.to = to;
        tube.sentinel = typeof from === 'symbol' || typeof to === 'symbol';
        tube.state = 'in';
        tube.grow = 0;
        tube.delay = GROW_DELAY;
        tube.flow = Math.random() * SPACING;
      }
      keep.add(tube);
      if (instant) {
        tube.state = 'on';
        tube.grow = 1;
        tube.delay = 0;
      }
    }
    for (const tube of tubes) {
      if (tube.state === 'free' || keep.has(tube)) continue;
      if (instant) freeTube(tube);
      else tube.state = 'out';
    }
  }

  // ---- per frame ----
  const centreA = new THREE.Vector3();
  const centreB = new THREE.Vector3();
  const bow = new THREE.Vector3();
  const at = new THREE.Vector3();
  const beadColor = new THREE.Color();

  function locate(end, out) {
    if (end === HEAD_END) return slabs.markerPosition('head', out);
    if (end === TAIL_END) return slabs.markerPosition('tail', out);
    return slabs.positionOf(end, out);
  }

  // Endpoints: a slab is met at the side edge facing the other end; a marker
  // at its post. A slab that has gone (shattered) leaves the tube on its last
  // known point while it retracts.
  function place(tube) {
    const okA = locate(tube.from, centreA) !== null;
    const okB = locate(tube.to, centreB) !== null;
    if (!okA || !okB) return tube.known;
    const lane = tube.kind === 'next' ? LANE : -LANE;
    const dir = Math.sign(centreB.x - centreA.x) || 1;
    tube.a.copy(centreA);
    tube.b.copy(centreB);
    if (typeof tube.from !== 'symbol') tube.a.x += dir * EDGE;
    if (typeof tube.to !== 'symbol') tube.b.x -= dir * EDGE;
    tube.a.y += lane;
    tube.b.y += lane;
    tube.known = true;
    return true;
  }

  // Each tube's slot in the reveal: next pointers shoot out HEAD to TAIL, and
  // each prev pointer answers a moment after its next.
  function revealGrow(tube, p) {
    const nodes = [HEAD_END, ...slabs.order(), TAIL_END];
    const owner = tube.kind === 'next' ? tube.from : tube.to;
    const rank = Math.max(nodes.indexOf(owner), 0) / Math.max(nodes.length - 1, 1);
    const start = 0.25 + rank * 0.45 + (tube.kind === 'prev' ? 0.06 : 0);
    return clamp01((p - start) / 0.22);
  }

  stage.addUpdater((dt) => {
    if (slabs.order() !== seenOrder) relink(false);
    for (const tube of tubes) {
      if (tube.state === 'free') continue;
      if (revealP !== null && tube.state !== 'out') {
        tube.state = 'in';
        tube.delay = 0;
        tube.grow = revealGrow(tube, revealP);
      } else if (tube.state === 'in') {
        if (tube.delay > 0) tube.delay -= dt;
        else tube.grow = Math.min(tube.grow + dt / GROW, 1);
        if (tube.grow >= 1) tube.state = 'on';
      } else if (tube.state === 'out') {
        tube.grow -= dt / RETRACT;
        if (tube.grow <= 0) {
          freeTube(tube);
          continue;
        }
      }
      if (!place(tube)) {
        tube.mesh.visible = false;
        continue;
      }
      const u = tube.u;
      const next = tube.kind === 'next';
      // next bows up, prev bows down; a long pointer bows a little more.
      const span = tube.a.distanceTo(tube.b);
      bow.set(0, (next ? 1 : -1) * Math.min(0.05 + 0.06 * span, 0.4), 0);
      const len = setCurve(u, tube.a, tube.b, bow);
      const extent = tube.state === 'out' ? inOutCubic(clamp01(tube.grow)) : outCubic(clamp01(tube.grow));
      u.uExtent.value = Math.max(extent, 0.0001);
      const dim = tube.sentinel ? SENTINEL_DIM : 1;
      u.uColor.value.copy(next ? NEXT : PREV).multiplyScalar(dim);
      u.uOpacity.value = Math.min(1, extent * 2.5);
      tube.flow += dt * FLOW_SPEED;
      const spacing = Math.max(SPACING, len / BEADS);
      u.uSpacing.value = spacing;
      u.uFlow.value = tube.flow % spacing;
      u.uFlowGain.value = 0.9;
      tube.mesh.visible = extent > 0.001;

      // Beads ride the curve at a fixed spacing from the owner, so a tube that
      // stretches gains beads at its tip instead of making them jump.
      const reach = extent * len;
      beadColor.copy(next ? NEXT_BEAD : PREV_BEAD).multiplyScalar(dim * u.uOpacity.value);
      for (let k = 0; k < BEADS; k++) {
        const slot = tube.index * BEADS + k;
        const s = u.uFlow.value + k * spacing;
        if (s > reach - HEAD_LEN * 0.5 || len < 1e-3) {
          beads.hide(slot);
          continue;
        }
        // Fade in leaving the owner and out arriving at the target.
        const fade = Math.min(clamp01(s / 0.12), clamp01((reach - HEAD_LEN * 0.5 - s) / 0.15));
        curvePoint(u, s / len, at);
        beads.set(slot, at, beadColor, (tube.sentinel ? 0.07 : 0.09) * fade);
      }
    }
    beads.frame(stage.camera, stage.renderer.domElement);
  });

  function setAlpha(alpha) {
    alphaUniform.value = alpha;
    root.visible = alpha > 0;
  }

  function syncTo() {
    revealP = null;
    relink(true);
  }

  // Draw the list on: p runs 0..1 over the reveal; null ends it, leaving every
  // tube fully grown.
  function reveal(p) {
    revealP = p;
    if (p === null) {
      for (const tube of tubes) {
        if (tube.state !== 'in') continue;
        tube.state = 'on';
        tube.grow = 1;
      }
    }
  }

  syncTo();

  return { setAlpha, syncTo, reveal };
}
