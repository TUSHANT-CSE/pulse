// Original Pulse signal sculpture; visual inspiration: ReactDrops Liquid Glass Orb. No ReactDrops code or media used.
// A decorative, dependency-free ES module. Its colors are not monitoring measurements.

const mountedScenes = new WeakMap();
const FRAME_INTERVAL = 1000 / 30;
const PALETTES = {
  up: [213 / 255, 1, 112 / 255],
  degraded: [1, 0.73, 0.34],
  down: [1, 0.34, 0.48],
  unknown: [185 / 255, 160 / 255, 1]
};

const VERTEX_SOURCE = `
attribute vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT_SOURCE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uResolution;
uniform float uTime;
uniform float uView;
uniform vec3 uTint;
uniform float uConnected;
uniform float uDemo;
const vec3 LIME = vec3(0.835294, 1.0, 0.439216);
const vec3 LILAC = vec3(0.72549, 0.627451, 1.0);

mat2 turn(float a) {
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c);
}

// A conservative distance field: a twisted, folded sphere with a toroidal pinch.
// All warps are bounded; marching steps are reduced to accommodate their slopes.
float sculpture(vec3 p) {
  p.y -= 0.026 * sin(uTime * 0.32);
  p.xy = turn(-0.38) * p.xy;
  p.yz = turn(0.29) * p.yz;
  p.xz = turn(-0.31 + 0.14 * sin(uTime * 0.17) + uDemo * 0.08) * p.xz;
  p.xz = turn(0.46 * p.y + 0.14 * sin(2.3 * p.y + uTime * 0.22)) * p.xz;
  float phase = 9.0 * p.y + 2.0 * sin(1.8 * p.x + uTime * 0.27)
    + 0.8 * sin(2.4 * p.z - uTime * 0.19);
  float folds = 0.115 * sin(phase) + 0.028 * sin(2.0 * phase + 0.45);
  float body = length(p) - 0.985 - folds;
  vec2 ring = vec2(length(p.xy - vec2(0.09, -0.04)) - 0.56, p.z);
  float torus = length(ring) - 0.57 - folds * 0.65;
  return mix(body, torus, 0.24);
}

vec3 normalAt(vec3 p) {
  const vec2 e = vec2(0.0024, 0.0);
  return normalize(vec3(
    sculpture(p + e.xyy) - sculpture(p - e.xyy),
    sculpture(p + e.yxy) - sculpture(p - e.yxy),
    sculpture(p + e.yyx) - sculpture(p - e.yyx)
  ));
}

// Original procedural studio: luminous rectangular softboxes, dark flags,
// and two colored side cards. No textures, downloaded media, or cubemaps.
float softbox(vec3 direction, vec3 facing, vec3 horizontal, vec2 size, float softness) {
  vec3 vertical = normalize(cross(facing, horizontal));
  float forward = dot(direction, facing);
  vec2 q = vec2(dot(direction, horizontal), dot(direction, vertical))
    / max(0.001, forward);
  vec2 mask = vec2(1.0) - smoothstep(size, size + vec2(softness), abs(q));
  return mask.x * mask.y * step(0.001, forward);
}

vec3 studio(vec3 r) {
  vec3 color = vec3(0.003, 0.004, 0.006);
  color += vec3(0.06, 0.064, 0.075) * smoothstep(-0.1, 0.85, r.y);
  color += vec3(4.2, 4.05, 3.85) * softbox(r,
    normalize(vec3(-0.48, 0.72, 0.50)), normalize(vec3(0.721, 0.0, 0.693)),
    vec2(0.82, 0.39), 0.10);
  color += vec3(2.25, 2.35, 2.55) * softbox(r,
    normalize(vec3(0.76, 0.12, 0.64)), normalize(vec3(0.644, 0.0, -0.765)),
    vec2(0.14, 1.12), 0.045);
  color += vec3(1.55, 1.58, 1.68) * softbox(r,
    normalize(vec3(-0.32, -0.74, 0.59)), normalize(vec3(0.879, 0.0, 0.477)),
    vec2(1.25, 0.11), 0.035);
  color += vec3(0.40, 0.43, 0.49) * softbox(r,
    normalize(vec3(0.0, 0.48, -0.88)), vec3(1.0, 0.0, 0.0),
    vec2(1.6, 0.60), 0.28);
  vec3 tint = mix(vec3(dot(uTint, vec3(0.2126, 0.7152, 0.0722))), uTint,
    0.58 + 0.42 * uConnected);
  color += mix(LIME, tint, 0.62) * 0.60 * softbox(r,
    normalize(vec3(-0.91, 0.06, 0.41)), normalize(vec3(0.411, 0.0, 0.912)),
    vec2(0.10, 0.65), 0.065);
  color += mix(LILAC, tint, 0.22) * 0.65 * softbox(r,
    normalize(vec3(0.60, -0.25, -0.76)), normalize(vec3(-0.785, 0.0, -0.620)),
    vec2(0.24, 0.80), 0.11);
  return color;
}

vec3 finish(vec3 linearColor) {
  return pow(vec3(1.0) - exp(-max(linearColor, vec3(0.0)) * 1.1), vec3(0.454545));
}

void main() {
  vec2 uv = (2.0 * gl_FragCoord.xy - uResolution) / min(uResolution.x, uResolution.y);
  uv.y -= 0.025;
  vec3 origin = vec3(0.0, 0.0, 4.65);
  vec3 ray = normalize(vec3(uv, -uView));
  vec3 rgb = vec3(0.0);
  float alpha = 0.0;
  float surfaceDepth = 100.0;

  // Analytic bounding sphere avoids marching empty space (and bounds every ray).
  float b = dot(origin, ray);
  float discriminant = b * b - dot(origin, origin) + 1.34 * 1.34;
  if (discriminant > 0.0) {
    float root = sqrt(discriminant);
    float depth = max(0.0, -b - root);
    float end = -b + root;
    bool hit = false;
    for (int i = 0; i < 88; i++) {
      float d = sculpture(origin + ray * depth);
      if (d < 0.0017) { hit = true; break; }
      depth += max(0.0006, d * 0.38);
      if (depth > end) break;
    }
    if (hit) {
      surfaceDepth = depth;
      vec3 p = origin + ray * depth;
      vec3 n = normalAt(p);
      vec3 reflected = reflect(ray, n);
      float facing = clamp(dot(n, -ray), 0.0, 1.0);
      float grazing = pow(1.0 - facing, 3.0);
      float occlusion = 0.0;
      occlusion += max(0.0, 0.075 - sculpture(p + n * 0.075)) * 5.5;
      occlusion += max(0.0, 0.18 - sculpture(p + n * 0.18)) * 1.1;
      occlusion += max(0.0, 0.32 - sculpture(p + n * 0.32)) * 0.35;
      float ao = clamp(1.0 - occlusion, 0.38, 1.0);
      vec3 metal = studio(reflected) * ao * (0.86 + 0.14 * grazing);
      metal += vec3(0.012, 0.013, 0.016) * (0.4 + 0.6 * max(0.0, n.y));
      // Thin-film color only at glancing angles: the surface remains silver.
      float filmPhase = smoothstep(-0.5, 0.5, sin(facing * 12.0 + p.y * 2.4));
      vec3 film = mix(LIME, LILAC, filmPhase);
      film = mix(film, uTint, 0.28);
      metal += film * grazing * 0.32 * (0.5 + 0.5 * uConnected);
      rgb = finish(metal);
      alpha = smoothstep(0.0, 0.065, facing);
    }
  }

  // One hairline orbit: its plane intersection gives real front/back occlusion.
  vec3 planeNormal = normalize(vec3(0.16, 0.88, 0.40));
  float denominator = dot(ray, planeNormal);
  if (abs(denominator) > 0.0001) {
    float orbitDepth = -dot(origin, planeNormal) / denominator;
    vec3 orbitPoint = origin + orbitDepth * ray;
    float distanceToRing = abs(length(orbitPoint) - 1.49);
    float pixelWidth = 4.65 / (uView * min(uResolution.x, uResolution.y));
    float line = 1.0 - smoothstep(pixelWidth * 0.45, pixelWidth * 1.9, distanceToRing);
    float sweep = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(orbitPoint.x * 2.0 + uTime * 0.10), 2.0);
    float ringAlpha = line * sweep * 0.28;
    if (orbitDepth > 0.0 && orbitDepth < surfaceDepth && ringAlpha > 0.001) {
      vec3 ringColor = mix(vec3(0.65, 0.67, 0.73), mix(LIME, uTint, 0.4), 0.35);
      float combined = ringAlpha + alpha * (1.0 - ringAlpha);
      rgb = (ringColor * ringAlpha + rgb * alpha * (1.0 - ringAlpha)) / max(combined, 0.0001);
      alpha = combined;
    }
  }

  // Six small, deterministic satellites; decorative, never a data visualization.
  vec3 axisX = normalize(cross(planeNormal, vec3(0.0, 0.0, 1.0)));
  vec3 axisY = cross(planeNormal, axisX);
  for (int j = 0; j < 6; j++) {
    float index = float(j);
    float angle = index * 1.047198 + 0.43 + uTime * 0.045;
    vec3 center = 1.49 * (axisX * cos(angle) + axisY * sin(angle));
    float projectedDepth = dot(center - origin, ray);
    float proximity = length(origin + projectedDepth * ray - center);
    float radius = 0.010 + 0.004 * mod(index, 3.0);
    float dotAlpha = 1.0 - smoothstep(radius * 0.55, radius * 1.6, proximity);
    if (projectedDepth > 0.0 && projectedDepth < surfaceDepth && dotAlpha > 0.001) {
      vec3 dotColor = mix(vec3(0.90, 0.91, 0.96), uTint, mod(index, 2.0) * 0.6);
      float combined = dotAlpha + alpha * (1.0 - dotAlpha);
      rgb = (dotColor * dotAlpha + rgb * alpha * (1.0 - dotAlpha)) / max(combined, 0.0001);
      alpha = combined;
    }
  }
  gl_FragColor = vec4(rgb, alpha);
}
`;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const normalize = (v) => {
  const length = Math.hypot(...v) || 1;
  return v.map((component) => component / length);
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const smoothstep = (a, b, value) => {
  const t = clamp((value - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// The fallback is an original projected, depth-sorted silver sculpture, not a
// flat gradient disc. Smooth per-face gradients carry the procedural reflections.
function createCanvasRenderer(context) {
  const latitudeCount = 36;
  const longitudeCount = 72;
  const directions = [];
  const cells = [];
  for (let y = 0; y <= latitudeCount; y++) {
    const latitude = -Math.PI / 2 + Math.PI * y / latitudeCount;
    for (let x = 0; x < longitudeCount; x++) {
      const longitude = Math.PI * 2 * x / longitudeCount;
      directions.push([Math.cos(latitude) * Math.cos(longitude), Math.sin(latitude), Math.cos(latitude) * Math.sin(longitude)]);
      if (y < latitudeCount) {
        const next = (x + 1) % longitudeCount;
        cells.push([y * longitudeCount + x, y * longitudeCount + next,
          (y + 1) * longitudeCount + next, (y + 1) * longitudeCount + x]);
      }
    }
  }
  const planeNormal = normalize([0.16, 0.88, 0.40]);
  const orbitX = normalize(cross(planeNormal, [0, 0, 1]));
  const orbitY = cross(planeNormal, orbitX);
  const cards = [
    [[-0.48, 0.72, 0.50], [0.721, 0, 0.693], [0.82, 0.39], 0.10, [4.2, 4.05, 3.85]],
    [[0.76, 0.12, 0.64], [0.644, 0, -0.765], [0.14, 1.12], 0.045, [2.25, 2.35, 2.55]],
    [[-0.32, -0.74, 0.59], [0.879, 0, 0.477], [1.25, 0.11], 0.035, [1.55, 1.58, 1.68]],
    [[0, 0.48, -0.88], [1, 0, 0], [1.6, 0.60], 0.28, [0.40, 0.43, 0.49]],
    [[-0.91, 0.06, 0.41], [0.411, 0, 0.912], [0.10, 0.65], 0.065, null],
    [[0.60, -0.25, -0.76], [-0.785, 0, -0.620], [0.24, 0.80], 0.11, [0.47, 0.41, 0.65]]
  ].map(([facing, horizontal, size, softness, color]) => {
    const f = normalize(facing), h = normalize(horizontal);
    return { f, h, v: normalize(cross(f, h)), size, softness, color };
  });

  return (width, height, time, state, view) => {
    const ctx = context;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, width, height);
    const unit = Math.min(width, height) / 2;
    const tint = PALETTES[state.health];
    const project = (p) => {
      const factor = view / (4.65 - p[2]) * unit;
      return [width / 2 + p[0] * factor, height / 2 - 0.025 * unit - p[1] * factor];
    };
    const rotate = (p) => {
      let [x, y, z] = p;
      let c = Math.cos(0.38), s = Math.sin(0.38);
      [x, y] = [c * x - s * y, s * x + c * y];
      c = Math.cos(-0.29); s = Math.sin(-0.29);
      [y, z] = [c * y - s * z, s * y + c * z];
      const angle = 0.31 - 0.14 * Math.sin(time * 0.17) - (state.mode === 'demo' ? 0.08 : 0);
      c = Math.cos(angle); s = Math.sin(angle);
      return [c * x - s * z, y, s * x + c * z];
    };
    const radius = (p) => {
      const phase = 9 * p[1] + 2 * Math.sin(1.8 * p[0] + time * 0.27)
        + 0.8 * Math.sin(2.4 * p[2] - time * 0.19);
      return 1.005 + 0.105 * Math.sin(phase) + 0.026 * Math.sin(2 * phase + 0.45)
        - 0.07 * Math.pow(Math.abs(p[2]), 6);
    };
    const reflectColor = (position, normal) => {
      const incident = normalize([position[0], position[1], position[2] - 4.65]);
      const d = dot(incident, normal);
      const r = incident.map((value, index) => value - 2 * d * normal[index]);
      const sky = smoothstep(-0.1, 0.85, r[1]);
      const color = [0.015 + 0.06 * sky, 0.017 + 0.064 * sky, 0.022 + 0.075 * sky];
      for (const card of cards) {
        const forward = dot(r, card.f);
        if (forward <= 0.001) continue;
        const x = Math.abs(dot(r, card.h) / forward), y = Math.abs(dot(r, card.v) / forward);
        const mask = (1 - smoothstep(card.size[0], card.size[0] + card.softness, x))
          * (1 - smoothstep(card.size[1], card.size[1] + card.softness, y));
        const cardColor = card.color || tint.map((value, index) => (value * 0.62 + PALETTES.up[index] * 0.38) * 0.6);
        for (let i = 0; i < 3; i++) color[i] += mask * cardColor[i];
      }
      const edge = Math.pow(1 - clamp(-d, 0, 1), 3) * (state.online ? 0.13 : 0.075);
      return color.map((value, index) => Math.round(255 * Math.pow(1 - Math.exp(-1.1 * (value + edge * tint[index])), 1 / 2.2)));
    };
    const positions = directions.map((direction) => {
      const point = rotate(direction.map((value) => value * radius(direction)));
      point[1] += 0.026 * Math.sin(time * 0.32);
      return point;
    });
    const vertices = positions.map((position, index) => {
      const y = Math.floor(index / longitudeCount), x = index % longitudeCount;
      const left = positions[y * longitudeCount + (x + longitudeCount - 1) % longitudeCount];
      const right = positions[y * longitudeCount + (x + 1) % longitudeCount];
      const below = positions[Math.max(0, y - 1) * longitudeCount + x];
      const above = positions[Math.min(latitudeCount, y + 1) * longitudeCount + x];
      let normal = normalize(cross(subtract(right, left), subtract(above, below)));
      if (y === 0 || y === latitudeCount) normal = normalize(position);
      if (dot(normal, position) < 0) normal = normal.map((value) => -value);
      return { p: position, xy: project(position), n: normal, color: reflectColor(position, normal) };
    });
    const faces = [];
    for (const cell of cells) {
      const points = cell.map((index) => vertices[index]);
      const center = [0, 0, 0], normal = [0, 0, 0];
      for (const vertex of points) {
        for (let i = 0; i < 3; i++) { center[i] += vertex.p[i] / 4; normal[i] += vertex.n[i] / 4; }
      }
      if (dot(normal, [-center[0], -center[1], 4.65 - center[2]]) <= 0) continue;
      faces.push({ points, depth: center[2] });
    }
    faces.sort((a, b) => a.depth - b.depth);
    const orbitPoint = (angle) => orbitX.map((value, index) => 1.49 * (value * Math.cos(angle) + orbitY[index] * Math.sin(angle)));
    const drawOrbit = (front) => {
      ctx.lineWidth = Math.max(0.55, unit / 290);
      for (let i = 0; i < 144; i++) {
        const a = orbitPoint(i * Math.PI / 72), b = orbitPoint((i + 1) * Math.PI / 72);
        if ((a[2] >= 0) !== front) continue;
        const from = project(a), to = project(b);
        const sweep = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(a[0] * 2 + time * 0.10), 2);
        ctx.strokeStyle = `rgba(188,198,177,${0.28 * sweep})`;
        ctx.beginPath(); ctx.moveTo(...from); ctx.lineTo(...to); ctx.stroke();
      }
      for (let i = 0; i < 6; i++) {
        const p = orbitPoint(i * Math.PI / 3 + 0.43 + time * 0.045);
        if ((p[2] >= 0) !== front) continue;
        const [x, y] = project(p), r = unit * view / (4.65 - p[2]) * (0.012 + 0.004 * (i % 3));
        const glow = ctx.createRadialGradient(x - r * 0.25, y - r * 0.3, 0, x, y, r * 1.5);
        glow.addColorStop(0, '#ffffff');
        glow.addColorStop(0.35, i % 2 ? `rgb(${tint.map((v) => Math.round(v * 255)).join(',')})` : '#b9a0ff');
        glow.addColorStop(1, 'rgba(185,160,255,0)');
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(x, y, r * 1.5, 0, Math.PI * 2); ctx.fill();
      }
    };
    drawOrbit(false);
    for (const { points } of faces) {
      const sorted = [...points].sort((a, b) => dot(a.color, [0.2126, 0.7152, 0.0722]) - dot(b.color, [0.2126, 0.7152, 0.0722]));
      const low = sorted[0], high = sorted[3];
      if (Math.hypot(low.xy[0] - high.xy[0], low.xy[1] - high.xy[1]) > 0.1) {
        const gradient = ctx.createLinearGradient(...low.xy, ...high.xy);
        gradient.addColorStop(0, `rgb(${low.color.join(',')})`);
        gradient.addColorStop(1, `rgb(${high.color.join(',')})`);
        ctx.fillStyle = gradient;
      } else ctx.fillStyle = `rgb(${high.color.join(',')})`;
      ctx.beginPath(); ctx.moveTo(...points[0].xy);
      for (let i = 1; i < 4; i++) ctx.lineTo(...points[i].xy);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 0.45;
      ctx.stroke();
    }
    drawOrbit(true);
    return true;
  };
}

/** Mount only the artwork; existing content, status text, and controls stay intact. */
export function mountPulseScene(container) {
  if (!container || !container.ownerDocument || !container.dataset || typeof container.appendChild !== 'function') {
    throw new TypeError('mountPulseScene requires a DOM container.');
  }
  if (mountedScenes.has(container)) return mountedScenes.get(container);
  const document = container.ownerDocument;
  const window = document.defaultView;
  const state = { health: 'unknown', online: false, mode: 'unknown' };
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let reducedMotion = Boolean(media?.matches);
  let explicitlyPaused = false;
  let pageActive = true;
  let intersecting = false;
  let destroyed = false;
  let dirty = true;
  let raf = 0;
  let frames = 0;
  let time = 1.8;
  let lastRendered = -Infinity;
  let lastMotion = null;
  let width = 0, height = 0;
  let cssWidth = 0, cssHeight = 0;
  let gl = null;
  let resources = null;
  let render2d = null;
  let canvas = makeCanvas();
  container.appendChild(canvas);
  container.dataset.frame = '0';
  container.dataset.motion = 'paused';

  function makeCanvas() {
    const element = document.createElement('canvas');
    element.className = 'signal-canvas';
    element.setAttribute('aria-hidden', 'true');
    element.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;';
    return element;
  }

  function releaseGL() {
    if (gl && resources && !gl.isContextLost()) {
      gl.deleteBuffer(resources.buffer);
      gl.deleteProgram(resources.program);
      for (const shader of resources.shaders) gl.deleteShader(shader);
    }
    resources = null;
    gl = null;
  }

  function initializeGL() {
    let program = null, buffer = null;
    const shaders = [];
    try {
      gl = canvas.getContext('webgl', {
        alpha: true, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'low-power'
      });
      if (!gl) return false;
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SOURCE], [gl.FRAGMENT_SHADER, FRAGMENT_SOURCE]]) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('Shader unavailable');
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Shader unavailable');
      }
      program = gl.createProgram();
      if (!program) throw new Error('Program unavailable');
      for (const shader of shaders) gl.attachShader(program, shader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Program unavailable');
      buffer = gl.createBuffer();
      if (!buffer) throw new Error('Buffer unavailable');
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.useProgram(program);
      const attribute = gl.getAttribLocation(program, 'aPosition');
      gl.enableVertexAttribArray(attribute);
      gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
      const uniforms = {};
      for (const name of ['uResolution', 'uTime', 'uView', 'uTint', 'uConnected', 'uDemo']) {
        uniforms[name] = gl.getUniformLocation(program, name);
      }
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      resources = { program, buffer, shaders, uniforms };
      canvas.addEventListener('webglcontextlost', onContextLost, false);
      container.dataset.renderer = 'webgl';
      return true;
    } catch {
      // Unsupported drivers silently use the equally original 2D artwork.
      if (gl && !gl.isContextLost()) {
        if (buffer) gl.deleteBuffer(buffer);
        if (program) gl.deleteProgram(program);
        for (const shader of shaders) gl.deleteShader(shader);
      }
      gl = null;
      return false;
    }
  }

  function useCanvasFallback() {
    canvas.removeEventListener('webglcontextlost', onContextLost, false);
    releaseGL();
    // A canvas cannot change context types. Replace our own canvas only.
    const previous = canvas;
    canvas = makeCanvas();
    previous.replaceWith(canvas);
    previous.width = previous.height = 1;
    canvas.width = width || 1;
    canvas.height = height || 1;
    let context = null;
    try { context = canvas.getContext('2d', { alpha: true }); } catch { /* No rendering context available. */ }
    render2d = context ? createCanvasRenderer(context) : null;
    container.dataset.renderer = 'canvas2d';
    dirty = true;
  }

  function onContextLost(event) {
    event.preventDefault();
    if (destroyed) return;
    useCanvasFallback();
    synchronize();
  }

  function eligible() {
    return !destroyed && pageActive && !document.hidden && intersecting && cssWidth > 0 && cssHeight > 0
      && container.isConnected && Boolean(resources || render2d);
  }

  function moving() { return eligible() && !explicitlyPaused && !reducedMotion; }

  function synchronize() {
    const animate = moving();
    container.dataset.motion = animate ? 'running' : 'paused';
    if (!animate) lastMotion = null;
    if (!eligible() || (!animate && !dirty)) {
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      return;
    }
    if (!raf) raf = window.requestAnimationFrame(tick);
  }

  function render() {
    const view = 3.25 * Math.min(1, cssWidth / cssHeight / 1.28);
    if (gl && resources) {
      if (gl.isContextLost()) useCanvasFallback();
      else {
        try {
          const u = resources.uniforms;
          gl.viewport(0, 0, width, height);
          gl.useProgram(resources.program);
          gl.uniform2f(u.uResolution, width, height);
          gl.uniform1f(u.uTime, time);
          gl.uniform1f(u.uView, view);
          gl.uniform3fv(u.uTint, PALETTES[state.health]);
          gl.uniform1f(u.uConnected, state.online ? 1 : 0);
          gl.uniform1f(u.uDemo, state.mode === 'demo' ? 1 : 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          return true;
        } catch { useCanvasFallback(); }
      }
    }
    return render2d ? render2d(width, height, time, state, view) : false;
  }

  function tick(timestamp) {
    raf = 0;
    if (!eligible()) { synchronize(); return; }
    const animate = moving();
    if ((dirty || animate) && timestamp - lastRendered >= FRAME_INTERVAL) {
      if (animate && lastMotion !== null) time += Math.min(0.08, Math.max(0, (timestamp - lastMotion) / 1000));
      lastMotion = animate ? timestamp : null;
      if (render()) {
        frames += 1;
        container.dataset.frame = String(frames);
        lastRendered = timestamp;
        dirty = false;
      }
    }
    synchronize();
  }

  function measure() {
    if (destroyed) return;
    const rect = container.getBoundingClientRect();
    cssWidth = rect.width > 0 ? container.clientWidth || rect.width : 0;
    cssHeight = rect.height > 0 ? container.clientHeight || rect.height : 0;
    if (!intersectionObserver) {
      intersecting = rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    }
    if (cssWidth > 0 && cssHeight > 0) {
      const dpr = clamp(window.devicePixelRatio || 1, 0.5, 1.5);
      const scale = Math.min(dpr, 850 / cssWidth, 600 / cssHeight);
      const nextWidth = Math.max(1, Math.min(850, Math.round(cssWidth * scale)));
      const nextHeight = Math.max(1, Math.min(600, Math.round(cssHeight * scale)));
      if (nextWidth !== width || nextHeight !== height) {
        width = nextWidth; height = nextHeight;
        canvas.width = width; canvas.height = height;
        dirty = true;
      }
    }
    synchronize();
  }

  function onVisibility() { synchronize(); }
  function onPageHide() { pageActive = false; synchronize(); }
  function onPageShow() { pageActive = true; measure(); }
  function onMotionChange(event) { reducedMotion = event.matches; synchronize(); }

  let intersectionObserver = null;
  let resizeObserver = null;
  if (!initializeGL()) useCanvasFallback();
  if (typeof window.IntersectionObserver === 'function') {
    intersectionObserver = new window.IntersectionObserver((entries) => {
      if (destroyed) return;
      for (const entry of entries) {
        if (entry.target === container) intersecting = entry.isIntersecting && entry.intersectionRatio > 0;
      }
      synchronize();
    }, { threshold: 0 });
    intersectionObserver.observe(container);
  }
  if (typeof window.ResizeObserver === 'function') {
    resizeObserver = new window.ResizeObserver(measure);
    resizeObserver.observe(container);
  }
  window.addEventListener('resize', measure, { passive: true });
  if (!intersectionObserver) window.addEventListener('scroll', measure, { passive: true, capture: true });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  if (media?.addEventListener) media.addEventListener('change', onMotionChange);
  else media?.addListener?.(onMotionChange);

  const api = {
    update(patch = {}) {
      if (destroyed || !patch || typeof patch !== 'object') return;
      let changed = false;
      if (Object.prototype.hasOwnProperty.call(patch, 'health')) {
        const health = Object.prototype.hasOwnProperty.call(PALETTES, patch.health) ? patch.health : 'unknown';
        if (state.health !== health) { state.health = health; changed = true; }
      }
      if (typeof patch.online === 'boolean' && state.online !== patch.online) {
        state.online = patch.online; changed = true;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'mode')) {
        const mode = patch.mode === 'demo' || patch.mode === 'live' ? patch.mode : 'unknown';
        if (state.mode !== mode) { state.mode = mode; changed = true; }
      }
      if (changed) { dirty = true; synchronize(); }
    },
    setPaused(paused) {
      if (destroyed) return;
      explicitlyPaused = Boolean(paused);
      synchronize();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      intersectionObserver?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      if (media?.removeEventListener) media.removeEventListener('change', onMotionChange);
      else media?.removeListener?.(onMotionChange);
      canvas.removeEventListener('webglcontextlost', onContextLost, false);
      releaseGL();
      render2d = null;
      canvas.remove();
      canvas.width = canvas.height = 1;
      container.dataset.motion = 'paused';
      mountedScenes.delete(container);
    }
  };
  mountedScenes.set(container, api);
  measure();
  return api;
}
