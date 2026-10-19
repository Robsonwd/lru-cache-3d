// Text labels: a canvas-drawn string on a transparent plane.
import * as THREE from 'three';

const FONT_PX = 48; // intended on-screen size of the type
const SCALE = 4; // drawn at 4x for crisp edges and clean mipmaps
const DRAW_PX = FONT_PX * SCALE;
const PAD_X = DRAW_PX * 0.18;
const CANVAS_HEIGHT = Math.ceil(DRAW_PX * 1.35);

export function createLabel({
  text, height, color = '#ffffff', font = '"SF Mono", ui-monospace, Menlo, monospace', weight = 600,
}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontString = `${weight} ${DRAW_PX}px ${font}`;
  // Centre on the cap height, so the line of type sits optically in the middle
  // whatever mix of ascenders, descenders, or emoji it contains.
  ctx.font = fontString;
  const capHeight = ctx.measureText('H').actualBoundingBoxAscent || DRAW_PX * 0.7;

  const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, height), material);
  let texture = null;

  function draw(value) {
    const string = String(value);
    ctx.font = fontString;
    const width = Math.max(Math.ceil(ctx.measureText(string).width + PAD_X * 2), CANVAS_HEIGHT * 0.5);
    const resized = canvas.width !== width || canvas.height !== CANVAS_HEIGHT;
    if (resized) {
      canvas.width = width;
      canvas.height = CANVAS_HEIGHT;
    }
    // Resizing a canvas resets its context state, so set it every time.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = fontString;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    // A soft dark halo around the glyphs. On a dark face it is invisible; when
    // a flare's bloom washes over the face it keeps the glyph edges crisp.
    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
    ctx.shadowBlur = DRAW_PX * 0.09;
    // The font stack falls back per character, so emoji and symbols still draw.
    ctx.fillText(string, canvas.width / 2, canvas.height / 2 + capHeight / 2);
    ctx.shadowColor = 'transparent';
    ctx.fillText(string, canvas.width / 2, canvas.height / 2 + capHeight / 2);

    // A texture's storage is fixed at first upload: a new size needs a new texture.
    if (!texture || resized) {
      texture?.dispose();
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
      material.map = texture;
      material.needsUpdate = true;
    }
    texture.needsUpdate = true;

    // Width follows the measured text so glyphs keep their proportions.
    if (resized) {
      mesh.geometry.dispose();
      mesh.geometry = new THREE.PlaneGeometry(height * (canvas.width / canvas.height), height);
    }
  }

  draw(text);

  return {
    mesh,
    setText: draw,
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
      texture?.dispose();
    },
  };
}
