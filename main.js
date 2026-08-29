import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import houseSvg from './house.svg?raw';

let W = 400, H = 320;  // updated from each loaded SVG's viewBox

// Flat 2D colors — skip sRGB/linear conversions so the canvas matches
// the plain <img> exactly.
THREE.ColorManagement.enabled = false;

const canvas = document.getElementById('sketch');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x000000, 0);

// Sketchy rendering after GPU Gems 2 ch. 15 (Nienhaus & Döllner,
// "Blueprint Rendering and Sketchy Drawings"):
//   - the drawing is split into an EDGE map and a SHADE map
//     (for parsed SVG that's simply strokes vs. fills — no edge
//     detection pass needed)
//   - a turbulence-based "uncertainty" perturbs each map's texture
//     coordinates, shifted in OPPOSITE directions, so lines wander off
//     the fills and fills bleed past the lines
//   - "repeated edges" variation: the edge map is sampled again with a
//     different uncertainty as a lighter ghost stroke
//   - "frayed edges" variation: uncorrelated fine noise roughs up the
//     stroke boundary (chalk-like)
// Cameras are mapped 1:1 to the SVG viewBox (top=0, bottom=H so the
// SVG's y-down coordinates land upright).
const shadeScene = new THREE.Scene();   // fills
const edgeScene  = new THREE.Scene();   // strokes
const svgCamera = new THREE.OrthographicCamera(0, W, 0, H, -100, 100);

const handDrawnShader = {
  uniforms: {
    tShade:     { value: null },
    tEdge:      { value: null },
    resolution: { value: new THREE.Vector2(W, H) },
    uncertFreq: { value: 0.012 },  // turbulence frequency of the uncertainty
    shadeAmp:   { value: 3.5 },    // shade-map displacement, px
    edgeAmp:    { value: 7.0 },    // edge-map displacement, px (opposite dir)
    ghostAmp:   { value: 3.5 },    // repeated-edge displacement, px
    ghostAlpha: { value: 0.55 },   // repeated-edge opacity
    ghostThin:  { value: 0.8 },    // repeated-edge thinning (threshold shift)
    ghostOff:   { value: 7.0 },    // constant down-right offset, px (cast-shadow look)
    ghostGray:  { value: 0.65 },   // 0 = ink-colored ghost, 1 = light gray
    grainFreq:  { value: 0.12 },   // frayed-edge noise frequency
    grainScale: { value: 1.2 },    // frayed-edge strength, px
    blurRadius: { value: 1.1 },    // edge softening ("wet ink")
    inkSlope:   { value: 6.0 },    // edge alpha contrast
    inkOffset:  { value: -0.95 },  // edge alpha threshold shift
    pressFreq:  { value: 0.02 },   // brush-pressure noise frequency
    pressAmp:   { value: 2.6 },    // stroke width variation strength
    inkVar:     { value: 0.10 }    // ink density unevenness (0..1)
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tShade, tEdge;
    uniform vec2 resolution;
    uniform float uncertFreq, shadeAmp, edgeAmp, ghostAmp, ghostAlpha, ghostThin;
    uniform float ghostOff, ghostGray;
    uniform float grainFreq, grainScale;
    uniform float blurRadius, inkSlope, inkOffset;
    uniform float pressFreq, pressAmp, inkVar;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i),              hash(i + vec2(1, 0)), u.x),
                 mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
    }
    float turbulence(vec2 p) {  // ~ Perlin turbulence, 3 octaves, in [0,1]
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 3; i++) { v += a * vnoise(p); p *= 2.0; a *= 0.5; }
      return v / 0.875;  // renormalize octave sum so 0.5 is the true mean
    }
    // GPU Gems 2 ch.15 uncertainty:
    //   offs = turbulence(s, t); offt = turbulence(1-s, 1-t)
    // returned in [-1, 1] per component
    vec2 uncert(vec2 px) {
      float offs = turbulence(px * uncertFreq);
      float offt = turbulence((resolution - px) * uncertFreq + vec2(9.2, 4.7));
      return (vec2(offs, offt) - 0.5) * 2.0;
    }

    // sample the edge map, displaced by "disp", with frayed edges,
    // ink-like soft/contrasted alpha and brush-pressure width variation
    vec4 sampleEdge(vec2 px, vec2 disp, float thin) {
      vec4 acc = vec4(0.0);
      float wsum = 0.0;
      for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec2 o = vec2(float(x), float(y)) * blurRadius;
        vec2 sp = px + o;
        vec2 fray = (vec2(vnoise(sp * grainFreq),
                          vnoise(sp * grainFreq + vec2(11.3, 57.9))) - 0.5)
                    * 2.0 * grainScale;
        float wgt = exp(-dot(o, o) / (2.0 * blurRadius * blurRadius));
        acc += texture2D(tEdge, (sp + disp + fray) / resolution) * wgt;
        wsum += wgt;
      }
      vec4 c = acc / wsum;
      float pressure = (turbulence(px * pressFreq + vec2(71.7, 13.1)) - 0.5) * pressAmp;
      float a = clamp(c.a * inkSlope + inkOffset + pressure - thin, 0.0, 1.0);
      a *= mix(1.0, vnoise(px * 0.09 + vec2(5.0, 23.0)), inkVar);
      vec3 rgb = c.a > 0.001 ? c.rgb / c.a : vec3(0.0);
      return vec4(rgb, a);
    }

    vec4 over(vec4 top, vec4 bot) {  // straight-alpha "over"
      float a = top.a + bot.a * (1.0 - top.a);
      vec3 rgb = (top.rgb * top.a + bot.rgb * bot.a * (1.0 - top.a)) / max(a, 1e-4);
      return vec4(rgb, a);
    }

    void main() {
      vec2 px = vUv * resolution;
      vec2 u = uncert(px);

      // shade map shifted one way...
      vec4 s = texture2D(tShade, (px + u * shadeAmp) / resolution);
      vec4 shade = vec4(s.a > 0.001 ? s.rgb / s.a : vec3(0.0), s.a);

      // ...edge map the opposite way, so they misregister
      vec4 edge = sampleEdge(px, -u * edgeAmp, 0.0);

      // repeated edges: lighter ghost stroke with its own uncertainty, plus a
      // constant down-right offset and gray tint for a cast-shadow feel
      vec4 ghost = sampleEdge(px,
        // texture v runs opposite to screen y, so (-x, +y) puts the ghost
        // down-right on screen like a cast shadow
        -uncert(px + vec2(157.0, 113.0)) * ghostAmp + vec2(-1.0, 0.7) * ghostOff,
        ghostThin);
      ghost.rgb = mix(ghost.rgb, vec3(0.72, 0.70, 0.71), ghostGray);
      ghost.a *= ghostAlpha;

      vec4 col = over(edge, over(ghost, shade));
      gl_FragColor = vec4(col.rgb * col.a, col.a);  // premultiplied
    }
  `
};

const postScene = new THREE.Scene();
const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const postMaterial = new THREE.ShaderMaterial({
  ...handDrawnShader,
  transparent: true,
  depthTest: false,
  depthWrite: false
});
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial));

const dpr = renderer.getPixelRatio();
let shadeTarget = null, edgeTarget = null;

// fit the canvas, camera and render targets to an SVG viewBox;
// very large drawings are displayed scaled down (long side <= 640px)
function setSize(vb) {
  const scale = Math.min(1, 640 / Math.max(vb.w, vb.h));
  W = Math.max(1, Math.round(vb.w * scale));
  H = Math.max(1, Math.round(vb.h * scale));
  renderer.setSize(W, H);
  svgCamera.left = vb.x;
  svgCamera.right = vb.x + vb.w;
  svgCamera.top = vb.y;
  svgCamera.bottom = vb.y + vb.h;
  svgCamera.updateProjectionMatrix();
  shadeTarget?.dispose();
  edgeTarget?.dispose();
  shadeTarget = new THREE.WebGLRenderTarget(W * dpr, H * dpr, { samples: 4 });
  edgeTarget  = new THREE.WebGLRenderTarget(W * dpr, H * dpr, { samples: 4 });
  postMaterial.uniforms.tShade.value = shadeTarget.texture;
  postMaterial.uniforms.tEdge.value  = edgeTarget.texture;
  postMaterial.uniforms.resolution.value.set(W, H);
  const img = document.getElementById('plain');
  img.width = W;
  img.height = H;
}

// --- Tunable parameters ---------------------------------------------
const PARAMS = [
  { group: 'Wobble' },
  { key: 'uncertFreq',  label: 'uncert freq',  min: 0.002, max: 0.05, step: 0.001 },
  { key: 'shadeAmp',    label: 'shade shift',  min: 0,     max: 15,   step: 0.5 },
  { key: 'edgeAmp',     label: 'edge shift',   min: 0,     max: 20,   step: 0.5 },
  { group: 'Ghost stroke' },
  { key: 'ghostAmp',    label: 'ghost shift',  min: 0,     max: 30,   step: 0.5 },
  { key: 'ghostAlpha',  label: 'ghost alpha',  min: 0,     max: 1,    step: 0.05 },
  { key: 'ghostThin',   label: 'ghost thin',   min: 0,     max: 2,    step: 0.05 },
  { key: 'ghostOff',    label: 'ghost offset', min: 0,     max: 12,   step: 0.5 },
  { key: 'ghostGray',   label: 'ghost gray',   min: 0,     max: 1,    step: 0.05 },
  { group: 'Edge texture' },
  { key: 'grainFreq',   label: 'grain freq',   min: 0.01,  max: 0.5,  step: 0.01 },
  { key: 'grainScale',  label: 'grain scale',  min: 0,     max: 6,    step: 0.1 },
  { key: 'blurRadius',  label: 'blur radius',  min: 0.2,   max: 3,    step: 0.1 },
  { group: 'Ink' },
  { key: 'inkSlope',    label: 'ink slope',    min: 1,     max: 10,   step: 0.5 },
  { key: 'inkOffset',   label: 'ink offset',   min: -2,    max: 0,    step: 0.05 },
  { key: 'inkVar',      label: 'ink density',  min: 0,     max: 1,    step: 0.02 },
  { group: 'Brush' },
  { key: 'pressFreq',   label: 'press freq',   min: 0.005, max: 0.1,  step: 0.005 },
  { key: 'pressAmp',    label: 'press amp',    min: 0,     max: 4,    step: 0.1 },
  { key: 'strokeBoost', label: 'stroke width', min: 0.3,   max: 1,    step: 0.05 }
];
const STORAGE_KEY = 'sketchy-house-params';

const defaults = { strokeBoost: 1.0 };
for (const p of PARAMS) {
  if (p.key && p.key !== 'strokeBoost')
    defaults[p.key] = postMaterial.uniforms[p.key].value;
}
const params = { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
for (const p of PARAMS) {  // saved values may predate a slider's range
  if (p.key && params[p.key] != null)
    params[p.key] = Math.min(p.max, Math.max(p.min, params[p.key]));
}

function applyParams() {
  for (const [key, value] of Object.entries(params)) {
    if (postMaterial.uniforms[key]) postMaterial.uniforms[key].value = value;
  }
}

// --- Build the control panel ----------------------------------------
const slidersEl = document.querySelector('#controls .sliders');
const inputs = {};
for (const p of PARAMS) {
  if (p.group) {
    const g = document.createElement('div');
    g.className = 'group';
    g.textContent = p.group;
    slidersEl.append(g);
    continue;
  }
  const wrap = document.createElement('label');
  wrap.className = 'ctl';
  const name = document.createElement('span');
  name.textContent = p.label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = p.min;
  input.max = p.max;
  input.step = p.step;
  input.value = params[p.key];
  const out = document.createElement('output');
  out.value = String(params[p.key]);
  input.addEventListener('input', () => {
    params[p.key] = Number(input.value);
    out.value = input.value;
    if (p.key === 'strokeBoost') buildScenes();
    else applyParams();
    render();
  });
  inputs[p.key] = input;
  wrap.append(name, input, out);
  slidersEl.append(wrap);
}

const status = document.getElementById('status');
function flash(msg) {
  status.textContent = msg;
  setTimeout(() => { if (status.textContent === msg) status.textContent = ''; }, 2500);
}
document.getElementById('save').addEventListener('click', () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(params));
  flash('saved — restored automatically on reload');
});
document.getElementById('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(JSON.stringify(params, null, 2));
  flash('copied to clipboard');
});
document.getElementById('reset').addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEY);
  Object.assign(params, defaults);
  for (const [key, input] of Object.entries(inputs)) {
    input.value = params[key];
    input.nextElementSibling.value = String(params[key]);
  }
  applyParams();
  buildScenes();
  render();
  flash('reset to defaults');
});

// --- Load SVG text; fills -> shade scene, strokes -> edge scene ---------
let svgData = null;

// punches transparent holes in the edge map: in SVG painter's order a
// later fill hides earlier strokes, so each fill erases what's beneath
// it before that path's own strokes are drawn (hidden-line removal)
const eraserMaterial = new THREE.MeshBasicMaterial({
  // transparent: false keeps it in the opaque queue, where renderOrder
  // interleaves it with the strokes; NoBlending writes (0,0,0,0) directly
  color: 0x000000, opacity: 0, transparent: false,
  blending: THREE.NoBlending,
  side: THREE.DoubleSide,
  depthTest: false, depthWrite: false
});

function buildScenes() {
  if (!svgData) return;
  shadeScene.clear();
  edgeScene.clear();
  let order = 0;
  for (const path of svgData.paths) {
    const style = path.userData.style;

    if (style.fill && style.fill !== 'none') {
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color().setStyle(style.fill),
        // the y-flipped ortho camera reverses winding, so don't cull
        side: THREE.DoubleSide,
        depthTest: false, depthWrite: false
      });
      for (const shape of SVGLoader.createShapes(path)) {
        const geometry = new THREE.ShapeGeometry(shape);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = order++;  // painter's order, like SVG
        shadeScene.add(mesh);

        const eraser = new THREE.Mesh(geometry, eraserMaterial);
        eraser.renderOrder = order++;
        edgeScene.add(eraser);
      }
    }

    if (style.stroke && style.stroke !== 'none') {
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color().setStyle(style.stroke),
        side: THREE.DoubleSide,
        depthTest: false, depthWrite: false
      });
      for (const subPath of path.subPaths) {
        // scale the source SVG's pen line (1 = as drawn, the maximum)
        const boosted = { ...style, strokeWidth: style.strokeWidth * params.strokeBoost };
        const geometry = SVGLoader.pointsToStroke(subPath.getPoints(), boosted);
        if (geometry) {
          const mesh = new THREE.Mesh(geometry, material);
          mesh.renderOrder = order++;
          edgeScene.add(mesh);
        }
      }
    }
  }
}

// parse SVG text, size everything to its viewBox, rebuild and render
function loadSVGText(text, name) {
  let data;
  try {
    data = new SVGLoader().parse(text);
  } catch (e) {
    flash('could not parse that SVG');
    return false;
  }
  if (!data.paths.length) {
    flash('no drawable paths found in that SVG');
    return false;
  }
  svgData = data;

  // viewBox attr, else width/height attrs, else bounds of the geometry
  let vb = null;
  const root = data.xml;
  const vbAttr = root?.getAttribute?.('viewBox');
  if (vbAttr) {
    const [x, y, w, h] = vbAttr.trim().split(/[\s,]+/).map(Number);
    if (w > 0 && h > 0) vb = { x, y, w, h };
  }
  if (!vb) {
    const w = parseFloat(root?.getAttribute?.('width'));
    const h = parseFloat(root?.getAttribute?.('height'));
    if (w > 0 && h > 0) vb = { x: 0, y: 0, w, h };
  }
  if (!vb) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const path of data.paths)
    for (const subPath of path.subPaths)
    for (const pt of subPath.getPoints()) {
      minX = Math.min(minX, pt.x); maxX = Math.max(maxX, pt.x);
      minY = Math.min(minY, pt.y); maxY = Math.max(maxY, pt.y);
    }
    const pad = 15;
    vb = { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
  }

  setSize(vb);
  applyParams();
  buildScenes();
  render();
  document.getElementById('caption-sketch').textContent = `${name} via SVGLoader + shader`;
  document.getElementById('caption-plain').textContent = `${name}, no effect`;
  return true;
}

// show an SVG string in the comparison <img> (blob URL, works on file://)
function showPlain(text) {
  const img = document.getElementById('plain');
  URL.revokeObjectURL(img.dataset.blobUrl || '');
  img.src = img.dataset.blobUrl =
    URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
}

// upload a different SVG (client-side only)
const fileInput = document.getElementById('file');
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  const text = await file.text();
  if (loadSVGText(text, file.name)) {
    showPlain(text);
    flash(`loaded ${file.name}`);
  }
  fileInput.value = '';  // allow re-selecting the same file
});

// initial drawing: house.svg is bundled in as a string
showPlain(houseSvg);
loadSVGText(houseSvg, 'house.svg');

function render() {
  if (!shadeTarget) return;  // nothing loaded yet
  renderer.setRenderTarget(shadeTarget);
  renderer.clear();
  renderer.render(shadeScene, svgCamera);
  renderer.setRenderTarget(edgeTarget);
  renderer.clear();
  renderer.render(edgeScene, svgCamera);
  renderer.setRenderTarget(null);
  renderer.clear();
  renderer.render(postScene, postCamera);
}

// console handle: sketch.params, sketch.uniforms, sketch.render()
window.sketch = { params, uniforms: postMaterial.uniforms, render };
