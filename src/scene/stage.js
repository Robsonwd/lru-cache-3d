// The stage: renderer, camera, controls, bloom, atmosphere, and the frame loop.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { tween, ease } from '../timeline.js';

const BACKGROUND = '#05060d';
const INTRO_SECONDS = 4.5;
const INTRO_DISTANCE = 7;
const FLOOR_Y = -1.6;

// Threshold 1.0: only HDR light blooms. Anything at or below display white
// (text, slab faces) stays crisp; to make something glow, push its colour above 1.
const BLOOM = { strength: 0.85, radius: 0.55, threshold: 1.0 };

export function createStage(canvas) {
  // No try/catch: without WebGL this throws and createScene's caller reports it.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.setClearColor(BACKGROUND, 1);

  const scene = new THREE.Scene();
  // The background the viewer sees comes from scene.background, not from the
  // clear colour above: every frame goes through the composer, whose RenderPass
  // draws scene.background over the clear, so the clear colour never reaches
  // the screen. The OutputPass then tone maps the background with ACES like
  // everything else, so scene.background is pre-compensated: it is the linear
  // colour that ACES maps to #05060d. The page and the canvas then meet without
  // a seam.
  scene.background = beforeToneMapping(BACKGROUND, renderer.toneMappingExposure);

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 400);
  camera.position.set(0, 3.4, 13);
  // The camera rides on a rig. Idle drift moves the rig, never the camera, so
  // OrbitControls only ever sees its own state and the drift cannot accumulate.
  const rig = new THREE.Group();
  rig.add(camera);
  scene.add(rig);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 5;
  controls.maxDistance = 60;
  // Every target sits above the floor, so stopping just short of horizontal
  // keeps the camera above it.
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.rotateSpeed = 0.6;
  controls.zoomSpeed = 0.7;

  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(window.innerWidth, window.innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    BLOOM.strength, BLOOM.radius, BLOOM.threshold,
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  addLights(scene);
  const sky = createSky();
  scene.add(sky);
  const stars = createStars(renderer.getPixelRatio());
  scene.add(stars);
  const floor = createFloor();
  scene.add(floor);

  window.addEventListener('resize', () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height, false);
    composer.setSize(width, height); // resizes every pass, the bloom pass included
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  });

  const updaters = [];
  function addUpdater(fn) { updaters.push(fn); }

  // Atmosphere motion. Everything is a function of elapsed time: nothing accumulates.
  addUpdater((dt, elapsed) => {
    stars.rotation.y = elapsed * 0.006;
    stars.material.uniforms.uTime.value = elapsed;
    sky.material.uniforms.uTime.value = elapsed;
  });

  // Idle drift. A camera clip marks the frame it moved the camera in; the drift
  // weight eases to 0 while clips run and back to 1 after, so it never snaps.
  // The opening: for the first seconds after load the rig also pulls back
  // along the line of sight and glides in, a slow dolly onto the stage.
  let clipFrame = false;
  let driftWeight = 1;
  const back = new THREE.Vector3();
  addUpdater((dt, elapsed) => {
    const goal = clipFrame ? 0 : 1;
    clipFrame = false;
    driftWeight += (goal - driftWeight) * Math.min(dt * 1.5, 1);
    rig.position.set(
      Math.sin(elapsed * 0.21) * 0.09 * driftWeight,
      Math.sin(elapsed * 0.29 + 1.3) * 0.05 * driftWeight,
      Math.sin(elapsed * 0.17 + 0.6) * 0.06 * driftWeight,
    );
    if (elapsed < INTRO_SECONDS) {
      const away = (1 - ease.outCubic(elapsed / INTRO_SECONDS)) * INTRO_DISTANCE;
      back.subVectors(camera.position, controls.target).normalize().multiplyScalar(away);
      rig.position.add(back);
    }
  });

  function start(tick) {
    let last = performance.now();
    let elapsed = 0;
    renderer.setAnimationLoop((now) => {
      // Clamp: after a hidden tab, one frame can report many seconds, and the
      // first frame's timestamp can precede performance.now() slightly.
      const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
      last = now;
      elapsed += dt;
      tick(dt);
      for (const fn of updaters) fn(dt, elapsed);
      controls.update();
      composer.render();
    });
  }

  function setView({ position, target }) {
    camera.position.set(...position);
    controls.target.set(...target);
    controls.update();
  }

  // getView is called when the clip starts, not when it is built (the clip rule).
  function cameraClip(getView, duration) {
    const fromPosition = new THREE.Vector3();
    const fromTarget = new THREE.Vector3();
    const toPosition = new THREE.Vector3();
    const toTarget = new THREE.Vector3();
    return tween({
      duration,
      ease: ease.inOutCubic,
      onStart() {
        const view = getView();
        fromPosition.copy(camera.position);
        fromTarget.copy(controls.target);
        toPosition.set(...view.position);
        toTarget.set(...view.target);
      },
      onUpdate(p) {
        clipFrame = true;
        camera.position.lerpVectors(fromPosition, toPosition, p);
        controls.target.lerpVectors(fromTarget, toTarget, p);
      },
    });
  }

  return { scene, camera, renderer, addUpdater, start, setView, cameraClip };
}

// Inverts three's ACESFilmicToneMapping: returns the linear colour that tone
// maps to the given display colour.
const ACES_IN = new THREE.Matrix3().set(
  0.59719, 0.35458, 0.04823,
  0.07600, 0.90834, 0.01566,
  0.02840, 0.13383, 0.83777,
);
const ACES_OUT = new THREE.Matrix3().set(
  1.60475, -0.53108, -0.07367,
  -0.10208, 1.10813, -0.00605,
  -0.00327, -0.07276, 1.07602,
);
function beforeToneMapping(display, exposure) {
  const color = new THREE.Color(display);
  const v = new THREE.Vector3(color.r, color.g, color.b).applyMatrix3(ACES_OUT.clone().invert());
  // Solve y = (x(x + a) - b) / (x(cx + d) + e) for x.
  const fit = (y) => {
    const a = 0.0245786; const b = 0.000090537; const c = 0.983729; const d = 0.4329510; const e = 0.238081;
    const qa = 1 - y * c;
    const qb = a - y * d;
    const qc = -(b + y * e);
    return (-qb + Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa);
  };
  v.set(fit(v.x), fit(v.y), fit(v.z)).applyMatrix3(ACES_IN.clone().invert()).multiplyScalar(0.6 / exposure);
  return new THREE.Color(v.x, v.y, v.z);
}

// Soft fill so slab faces read: a cool sky/ground split, a key from the front,
// and a violet rim from behind.
function addLights(scene) {
  scene.add(new THREE.HemisphereLight('#7fa8ff', '#0a0614', 0.9));
  const key = new THREE.DirectionalLight('#dceeff', 1.3);
  key.position.set(4, 9, 12);
  scene.add(key);
  const rim = new THREE.DirectionalLight('#8a5cff', 0.9);
  rim.position.set(-6, 5, -10);
  scene.add(rim);
}

// The atmosphere lives in the darkest few steps of an 8-bit display, where smooth
// gradients band into visible contours. A little screen-space noise (interleaved
// gradient noise, zero mean) breaks the steps up.
const DITHER_GLSL = /* glsl */`
      #define DITHER (vec3(fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5) * 0.0024)`;

// A faint dome added over the clear colour: a cold horizon haze and a slow
// violet nebula high up, so the dark has depth instead of being flat black.
function createSky() {
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`${DITHER_GLSL}
      uniform float uTime;
      varying vec3 vDir;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      float noise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
          mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
          f.z);
      }
      float fbm(vec3 p) {
        // Rotate between octaves so the lattice of the value noise never lines up.
        const mat3 turn = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) { v += a * noise(p); p = turn * p * 2.03; a *= 0.5; }
        return v;
      }
      void main() {
        vec3 d = normalize(vDir);
        // Horizon haze: a thin cold band just above the horizon line.
        float haze = exp(-abs(d.y - 0.02) * 22.0);
        vec3 color = vec3(0.0016, 0.0032, 0.0090) * haze;
        // Nebula: a slowly drifting fbm cloud, masked to the sky behind the stage.
        float band = smoothstep(0.0, 0.25, d.y) * smoothstep(0.9, 0.3, d.y) * smoothstep(0.2, -0.7, d.z);
        if (band > 0.0) {
          float n = fbm(d * 2.4 + vec3(uTime * 0.004, 0.0, uTime * 0.003));
          float cloud = smoothstep(0.35, 0.85, n) * band;
          color += mix(vec3(0.0050, 0.0016, 0.0110), vec3(0.0012, 0.0040, 0.0110), n) * cloud;
        }
        color += DITHER;
        gl_FragColor = vec4(color, 1.0);
      }`,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 48, 24), material);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  return sky;
}

// About 1500 stars in a shell of radius 60 to 120. Most are dim specks; a few
// are bright enough to catch the bloom. Each twinkles on its own phase.
function createStars(pixelRatio) {
  const COUNT = 1500;
  const positions = new Float32Array(COUNT * 3);
  const colors = new Float32Array(COUNT * 3);
  const sizes = new Float32Array(COUNT);
  const phases = new Float32Array(COUNT);
  const tints = [new THREE.Color('#cfe2ff'), new THREE.Color('#9fc4ff'), new THREE.Color('#ffffff'), new THREE.Color('#ffd9b0'), new THREE.Color('#c9b0ff')];
  const color = new THREE.Color();
  // Deterministic, so every load shows the same sky.
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  for (let i = 0; i < COUNT; i++) {
    const u = random() * 2 - 1;
    const theta = random() * Math.PI * 2;
    const r = 60 + random() * 60;
    const s = Math.sqrt(1 - u * u);
    // Fewer stars below the horizon: the floor hides most of that half anyway.
    const y = u < -0.25 && random() < 0.6 ? -u : u;
    positions[i * 3] = r * s * Math.cos(theta);
    positions[i * 3 + 1] = r * y;
    positions[i * 3 + 2] = r * s * Math.sin(theta);
    const bright = random() ** 6; // heavy tail: a handful of bright stars
    const tint = tints[Math.floor(random() * tints.length)];
    color.copy(tint).multiplyScalar(0.18 + bright * 1.6);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
    sizes[i] = 1.1 + bright * 2.6;
    phases[i] = random() * Math.PI * 2;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('phase', new THREE.BufferAttribute(phases, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixelRatio: { value: pixelRatio } },
    vertexShader: /* glsl */`
      attribute vec3 color;
      attribute float size;
      attribute float phase;
      uniform float uTime;
      uniform float uPixelRatio;
      varying vec3 vColor;
      void main() {
        float twinkle = 0.75 + 0.25 * sin(uTime * (0.6 + fract(phase * 3.7) * 1.4) + phase);
        vColor = color * twinkle;
        gl_PointSize = size * uPixelRatio;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.0, d);
        gl_FragColor = vec4(vColor * a * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const stars = new THREE.Points(geometry, material);
  stars.renderOrder = -5;
  stars.frustumCulled = false;
  return stars;
}

// A floor grid that glows faintly under the row and dissolves into the dark.
// Lines are antialiased with screen-space derivatives and fade out where they
// would turn to moire at grazing angles.
function createFloor() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMinor: { value: new THREE.Color('#2a4f8a') },
      uMajor: { value: new THREE.Color('#4aa8ff') },
      uPool: { value: new THREE.Color('#1b3f8f') },
    },
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */`${DITHER_GLSL}
      uniform vec3 uMinor;
      uniform vec3 uMajor;
      uniform vec3 uPool;
      varying vec3 vWorld;
      float grid(vec2 p, float spacing, float width) {
        vec2 c = p / spacing;
        vec2 w = fwidth(c);
        vec2 g = abs(fract(c - 0.5) - 0.5) / max(w, 1e-4);
        float line = 1.0 - min(min(g.x, g.y) / width, 1.0);
        // Fade lines whose cells shrink below a few pixels.
        float density = max(w.x, w.y);
        return line * (1.0 - smoothstep(0.08, 0.35, density));
      }
      void main() {
        vec2 p = vWorld.xz;
        // Centre the falloff a little behind the row, under the wall.
        float d = length((p - vec2(0.0, -1.5)) * vec2(0.75, 1.0));
        float fade = 1.0 - smoothstep(1.5, 18.0, d);
        fade *= fade;
        float minor = grid(p, 1.1, 1.0);
        float major = grid(p, 4.4, 1.2);
        vec3 color = uMinor * minor * 0.12 + uMajor * major * 0.12;
        // A soft pool of light under the row, like a stage lit from above.
        float pool = exp(-d * d * 0.03);
        color += uPool * pool * 0.03;
        gl_FragColor = vec4(color * fade + DITHER, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    // Writes depth, and draws before the stars, so it hides the stars below
    // the horizon: the floor reads as ground, not as a pane of glass.
    depthWrite: true,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), material);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  floor.renderOrder = -6;
  return floor;
}
