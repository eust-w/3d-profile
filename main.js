import * as THREE from 'three';

/* ───────────── helpers ───────────── */
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const rnd = (a, b) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ───────────── renderer ───────────── */
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
renderer.setClearColor(0x04060c, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);

const U = {
  time: { value: 0 },
  px: { value: 1 },
  armMix: { value: 0 },
  armAlpha: { value: 1 },
  graphMix: { value: 0.25 },
  graphAlpha: { value: 0 },
  bgAlpha: { value: 0.6 },
};

/* Gaussian splat material: soft exp(-r²) falloff, additive, per-point size/jitter/colour */
function splatMaterial(mix, alpha) {
  return new THREE.ShaderMaterial({
    uniforms: { uMix: mix, uAlpha: alpha, uTime: U.time, uPx: U.px },
    vertexShader: /* glsl */`
      attribute vec3 aColor; attribute float aSize; attribute vec3 aJit;
      uniform float uMix, uTime, uPx;
      varying vec3 vC; varying float vS;
      void main(){
        float w = 0.55 + 0.45 * sin(uTime * 1.4 + position.x * 9.0 + position.y * 7.0 + position.z * 5.0);
        vec3 p = position + aJit * (1.0 - uMix) * w;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * mix(1.0, 0.42, uMix) * uPx / max(0.1, -mv.z);
        vec3 sim = vec3(0.30, 0.90, 1.00) * (0.55 + 0.35 * aSize * 14.0);
        vC = mix(aColor, sim, uMix);
        vS = aSize;
      }`,
    fragmentShader: /* glsl */`
      uniform float uAlpha; varying vec3 vC;
      void main(){
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot(d, d) * 4.0;
        if (r2 > 1.0) discard;
        float a = exp(-r2 * 3.4) * uAlpha * 0.6;
        gl_FragColor = vec4(vC, a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}
const armMat = splatMaterial(U.armMix, U.armAlpha);
const bgMat = splatMaterial({ value: 0.0 }, U.bgAlpha);
const graphMat = splatMaterial(U.graphMix, U.graphAlpha);
const lineMat = new THREE.LineBasicMaterial({ color: 0x5ef0ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });

/* ───────────── sampling ───────────── */
const C = (h) => new THREE.Color(h);
function samplers() {
  return {
    box(w, h, d) {
      const aw = h * d, ah = w * d, ad = w * h, t = aw + ah + ad, r = Math.random() * t;
      const s = Math.random() < 0.5 ? -0.5 : 0.5;
      const u = rnd(-0.5, 0.5), v = rnd(-0.5, 0.5);
      if (r < aw) return [s * w, u * h, v * d];
      if (r < aw + ah) return [u * w, s * h, v * d];
      return [u * w, v * h, s * d];
    },
    cyl(r, h) {
      const side = 2 * Math.PI * r * h, cap = 2 * Math.PI * r * r;
      if (Math.random() < side / (side + cap)) { const a = rnd(0, 6.283); return [Math.cos(a) * r, rnd(-0.5, 0.5) * h, Math.sin(a) * r]; }
      const a = rnd(0, 6.283), rr = r * Math.sqrt(Math.random()); return [Math.cos(a) * rr, (Math.random() < 0.5 ? -0.5 : 0.5) * h, Math.sin(a) * rr];
    },
    sph(r) {
      let x = gauss(), y = gauss(), z = gauss(); const l = Math.hypot(x, y, z) || 1; return [x / l * r, y / l * r, z / l * r];
    },
  };
}
const S = samplers();

/** Build one splat part (Points) + matching wireframe for the "sim" look */
function part({ shape, dims, n, palette, size = 0.05, jit = 0.03, colorFn, wire = true, wireSeg }) {
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), sz = new Float32Array(n), jt = new Float32Array(n * 3);
  const pal = palette.map(C);
  for (let i = 0; i < n; i++) {
    const p = S[shape](...dims);
    pos.set(p, i * 3);
    let c = colorFn ? colorFn(p) : pal[(Math.random() * pal.length) | 0].clone();
    const k = rnd(0.75, 1.15); c.multiplyScalar(k);
    col.set([c.r, c.g, c.b], i * 3);
    sz[i] = size * rnd(0.55, 1.5);
    jt.set([gauss() * jit, gauss() * jit, gauss() * jit], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
  g.setAttribute('aJit', new THREE.BufferAttribute(jt, 3));
  const pts = new THREE.Points(g, armMat);
  pts.frustumCulled = false;
  const grp = new THREE.Group();
  grp.add(pts);
  if (wire) {
    let geo;
    if (shape === 'box') geo = new THREE.BoxGeometry(dims[0], dims[1], dims[2], 2, 1, 1);
    else if (shape === 'cyl') geo = new THREE.CylinderGeometry(dims[0], dims[0], dims[1], wireSeg || 14, 3);
    else geo = new THREE.SphereGeometry(dims[0], 10, 7);
    const l = new THREE.LineSegments(new THREE.WireframeGeometry(geo), lineMat);
    grp.add(l);
  }
  return grp;
}

/* ───────────── arm scene ───────────── */
const world = new THREE.Group();
scene.add(world);

// table with glowing grid
{
  const gridCol = (p) => {
    const gx = Math.abs(((p[0] + 10) % 0.4) - 0.2), gz = Math.abs(((p[2] + 10) % 0.4) - 0.2);
    const on = gx > 0.185 || gz > 0.185;
    return on ? new THREE.Color(0x1d8fb0) : new THREE.Color(0x0b1b2e);
  };
  const t = part({ shape: 'box', dims: [4.6, 0.1, 3.2], n: 16000, palette: ['#0b1b2e'], size: 0.045, jit: 0.02, colorFn: (p) => gridCol(p), wire: false });
  t.position.y = -0.05; world.add(t);
}
// pads
const SRC = new THREE.Vector3(0.25, 0, 0.55), DST = new THREE.Vector3(0.45, 0, -0.6);
for (const [pp, c] of [[SRC, '#ffc857'], [DST, '#ff5fa8']]) {
  const pad = part({ shape: 'box', dims: [0.34, 0.02, 0.34], n: 700, palette: [c], size: 0.04, jit: 0.012, wire: false });
  pad.position.set(pp.x, 0.012, pp.z); world.add(pad);
}
// static props
{
  const cup = part({ shape: 'cyl', dims: [0.14, 0.32], n: 2600, palette: ['#ff5fa8', '#ff8fc5', '#ffd1e6'], size: 0.04, jit: 0.025 });
  cup.position.set(0.85, 0.16, -0.05); world.add(cup);
  const ball = part({ shape: 'sph', dims: [0.14], n: 1800, palette: ['#6dffb1', '#2de39a', '#bfffe0'], size: 0.04, jit: 0.025 });
  ball.position.set(1.15, 0.14, 0.95); world.add(ball);
  const box2 = part({ shape: 'box', dims: [0.3, 0.2, 0.3], n: 2200, palette: ['#7aa8ff', '#a6c2ff', '#4f7dff'], size: 0.04, jit: 0.025 });
  box2.position.set(0.55, 0.1, 0.95); box2.rotation.y = 0.5; world.add(box2);
  const bin = part({ shape: 'box', dims: [0.5, 0.26, 0.5], n: 2600, palette: ['#ff9d4d', '#ffc88a'], size: 0.04, jit: 0.025 });
  bin.position.set(1.5, 0.13, -0.9); bin.rotation.y = -0.3; world.add(bin);
}
// the manipulated cube
const cube = part({ shape: 'box', dims: [0.18, 0.18, 0.18], n: 1500, palette: ['#ffc857', '#ffe29a', '#ffb02e'], size: 0.04, jit: 0.02 });
cube.position.set(SRC.x, 0.09, SRC.z); world.add(cube);

// arm kinematic chain
const L1 = 0.95, L2 = 0.85, TOOL = 0.24, SH_Y = 0.48;
const armRoot = new THREE.Group(); armRoot.position.set(-0.95, 0, 0); world.add(armRoot);
const armPal = ['#f4f6fa', '#ffb26b', '#d9e2f3'];
const base = part({ shape: 'cyl', dims: [0.3, 0.16], n: 1500, palette: ['#cfd8e8', '#8e9ab0'], size: 0.04, jit: 0.02 }); base.position.y = 0.08; armRoot.add(base);
const yawP = new THREE.Group(); yawP.position.y = 0.16; armRoot.add(yawP);
const turret = part({ shape: 'cyl', dims: [0.2, 0.32], n: 1500, palette: armPal, size: 0.04, jit: 0.02 }); turret.position.y = 0.16; yawP.add(turret);
const shP = new THREE.Group(); shP.position.y = 0.32; yawP.add(shP);
shP.add(part({ shape: 'sph', dims: [0.14], n: 800, palette: ['#ffb26b', '#ff8a3a'], size: 0.04, jit: 0.015 }));
const up = part({ shape: 'box', dims: [L1, 0.16, 0.16], n: 4200, palette: armPal, size: 0.04, jit: 0.02 }); up.position.x = L1 / 2; shP.add(up);
const elP = new THREE.Group(); elP.position.x = L1; shP.add(elP);
elP.add(part({ shape: 'sph', dims: [0.12], n: 700, palette: ['#ffb26b', '#ff8a3a'], size: 0.04, jit: 0.015 }));
const fore = part({ shape: 'box', dims: [L2, 0.13, 0.13], n: 3600, palette: armPal, size: 0.04, jit: 0.02 }); fore.position.x = L2 / 2; elP.add(fore);
const wrP = new THREE.Group(); wrP.position.x = L2; elP.add(wrP);
wrP.add(part({ shape: 'sph', dims: [0.09], n: 500, palette: ['#ffb26b'], size: 0.035, jit: 0.012 }));
const hand = part({ shape: 'box', dims: [0.1, 0.1, 0.24], n: 700, palette: ['#cfd8e8', '#8e9ab0'], size: 0.035, jit: 0.012 }); hand.position.x = 0.06; wrP.add(hand);
const fingerA = part({ shape: 'box', dims: [0.16, 0.03, 0.05], n: 380, palette: ['#5ef0ff', '#b8f8ff'], size: 0.03, jit: 0.01, wire: false });
const fingerB = part({ shape: 'box', dims: [0.16, 0.03, 0.05], n: 380, palette: ['#5ef0ff', '#b8f8ff'], size: 0.03, jit: 0.01, wire: false });
wrP.add(fingerA, fingerB);

/* planar 2-link IK; target = tool tip in world coords */
function solveArm(tip, grip) {
  const T = tip.clone().sub(armRoot.position);
  const yaw = Math.atan2(-T.z, T.x);
  const r = Math.hypot(T.x, T.z);
  const hy = (T.y + TOOL) - SH_Y - 0.16;      // wrist pivot sits TOOL above the tip (tool points down)
  let d = Math.hypot(r, hy); d = Math.min(d, L1 + L2 - 0.01); d = Math.max(d, 0.25);
  const a1 = Math.atan2(hy, r);
  const a2 = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  const sh = a1 + a2;
  const el = -(Math.PI - Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1)));
  yawP.rotation.y = yaw; shP.rotation.z = sh; elP.rotation.z = el; wrP.rotation.z = -Math.PI / 2 - sh - el;
  const gap = lerp(0.105, 0.2, grip);
  fingerA.position.set(TOOL - 0.08 + 0.0, 0, gap); fingerB.position.set(TOOL - 0.08, 0, -gap);
}

/* pick-and-place cycle (waypoints: tip pos, gripper 0..1, attached flag on segment start) */
const HOVER = 0.85, GRIP_Y = 0.12;
function buildPlan(src, dst) {
  const P = (v, y) => new THREE.Vector3(v.x, y, v.z);
  return [
    { p: new THREE.Vector3(0.05, 1.0, 0.15), g: 1, a: 0, d: 1.3 },
    { p: P(src, HOVER), g: 1, a: 0, d: 1.0 },
    { p: P(src, GRIP_Y), g: 1, a: 0, d: 0.8 },
    { p: P(src, GRIP_Y), g: 0, a: 1, d: 0.5 },
    { p: P(src, HOVER), g: 0, a: 1, d: 0.9 },
    { p: P(dst, HOVER), g: 0, a: 1, d: 1.5 },
    { p: P(dst, GRIP_Y), g: 0, a: 0, d: 0.9 },
    { p: P(dst, GRIP_Y), g: 1, a: 0, d: 0.5 },
    { p: P(dst, HOVER), g: 1, a: 0, d: 0.9 },
    { p: new THREE.Vector3(0.05, 1.0, 0.15), g: 1, a: 0, d: 1.2 },
  ];
}
let plans = [buildPlan(SRC, DST), buildPlan(DST, SRC)], planIdx = 0, seg = 0, segT = 0, attached = false;
const tip = new THREE.Vector3(), tmpV = new THREE.Vector3();
function stepArm(dt) {
  const plan = plans[planIdx];
  const A = plan[seg], B = plan[seg + 1];
  segT += dt;
  const dur = A.d;
  const u = sstep(0, 1, clamp(segT / dur));
  tip.lerpVectors(A.p, B.p, u);
  const grip = lerp(A.g, B.g, u);
  // lift with an arc between hover points for a natural path
  if (A.p.y > 0.5 && B.p.y > 0.5) tip.y += Math.sin(u * Math.PI) * 0.12;
  solveArm(tip, grip);
  attached = !!A.a;
  if (attached) cube.position.set(tip.x, tip.y - (GRIP_Y - 0.09), tip.z);
  if (segT >= dur) {
    segT = 0; seg++;
    if (seg >= plan.length - 1) { seg = 0; planIdx = (planIdx + 1) % plans.length; }
  }
}

/* background dust / far splats */
{
  const n = 3500, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), sz = new Float32Array(n), jt = new Float32Array(n * 3);
  const pal = ['#2a4bff', '#7a3cff', '#1fb6ff', '#ff5fa8'].map(C);
  for (let i = 0; i < n; i++) {
    const r = rnd(5, 22), a = rnd(0, 6.283), y = rnd(-4, 9);
    pos.set([Math.cos(a) * r, y, Math.sin(a) * r], i * 3);
    const c = pal[(Math.random() * 4) | 0].clone().multiplyScalar(rnd(0.25, 0.7));
    col.set([c.r, c.g, c.b], i * 3); sz[i] = rnd(0.06, 0.2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
  g.setAttribute('aJit', new THREE.BufferAttribute(jt, 3));
  const dust = new THREE.Points(g, bgMat); dust.frustumCulled = false; scene.add(dust);
}
// floating dust near the table (gives the "captured volume" feel)
{
  const n = 2500, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), sz = new Float32Array(n), jt = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos.set([rnd(-3, 3), rnd(0.05, 2.6), rnd(-2.2, 2.2)], i * 3);
    const c = C('#6fa8ff').multiplyScalar(rnd(0.15, 0.55)); col.set([c.r, c.g, c.b], i * 3);
    sz[i] = rnd(0.02, 0.05); jt.set([gauss() * 0.2, gauss() * 0.2, gauss() * 0.2], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
  g.setAttribute('aJit', new THREE.BufferAttribute(jt, 3));
  const m = new THREE.Points(g, armMat); m.frustumCulled = false; world.add(m);
}

/* ───────────── AI4AI graph ───────────── */
const graph = new THREE.Group(); graph.position.set(1.95, 0, 0); graph.scale.setScalar(0.8); scene.add(graph);
const NODES = [
  { id: 'Claude Code', p: [-2.6, 1.7, 0.2], c: '#5ef0ff' },
  { id: 'Codex', p: [-2.8, 0.4, -0.5], c: '#5ef0ff' },
  { id: 'Agent Skills', p: [-1.4, 2.5, -0.6], c: '#ffc857' },
  { id: 'EEP · MCP', p: [-0.7, 1.0, 0.2], c: '#ff5fa8', big: 1.5 },
  { id: 'Safety Gate', p: [0.7, 2.1, 0.5], c: '#ffc857' },
  { id: 'MuJoCo · 3DGS Sim', p: [1.8, 0.9, -0.3], c: '#7aa8ff', big: 1.3 },
  { id: 'Robot', p: [3.0, 1.9, 0.2], c: '#6dffb1' },
  { id: 'Feedback', p: [1.0, -0.3, 0.4], c: '#7aa8ff' },
  { id: 'Memory · Reflect', p: [-1.2, -0.5, 0.2], c: '#ff5fa8' },
  { id: 'Eval · Bench', p: [3.0, -0.1, -0.4], c: '#6dffb1' },
];
const EDGES = [[2, 0], [2, 1], [0, 3], [1, 3], [3, 4], [4, 5], [5, 6], [5, 7], [5, 9], [7, 8], [9, 8], [8, 0], [8, 1], [8, 2]];
const nodeVec = NODES.map((n) => new THREE.Vector3(...n.p));
{
  const pos = [], col = [], sz = [], jt = [];
  const push = (p, c, s, j = 0) => { pos.push(p[0], p[1], p[2]); col.push(c.r, c.g, c.b); sz.push(s); jt.push(gauss() * j, gauss() * j, gauss() * j); };
  NODES.forEach((n, i) => {
    const col0 = C(n.c), R = 0.17 * (n.big || 1);
    for (let k = 0; k < 700 * (n.big || 1); k++) { const s = S.sph(R); push([n.p[0] + s[0], n.p[1] + s[1], n.p[2] + s[2]], col0.clone().multiplyScalar(rnd(0.7, 1.3)), rnd(0.04, 0.09), 0.02); }
    for (let k = 0; k < 500; k++) { const s = S.sph(R * rnd(1.6, 3.2)); push([n.p[0] + s[0], n.p[1] + s[1], n.p[2] + s[2]], col0.clone().multiplyScalar(rnd(0.12, 0.35)), rnd(0.03, 0.07), 0.04); }
  });
  EDGES.forEach(([a, b]) => {
    const A = nodeVec[a], B = nodeVec[b], len = A.distanceTo(B);
    for (let k = 0; k < len * 90; k++) {
      const t = Math.random(); const p = A.clone().lerp(B, t);
      push([p.x + gauss() * 0.012, p.y + gauss() * 0.012, p.z + gauss() * 0.012], C('#5ef0ff').multiplyScalar(rnd(0.12, 0.3)), rnd(0.02, 0.04), 0.01);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(col), 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(sz), 1));
  g.setAttribute('aJit', new THREE.BufferAttribute(new Float32Array(jt), 3));
  const p = new THREE.Points(g, graphMat); p.frustumCulled = false; graph.add(p);
}
// travelling pulses
const PULSES = []; EDGES.forEach((e, i) => { for (let k = 0; k < 2; k++) PULSES.push({ e, off: (i * 0.137 + k * 0.5) % 1, sp: 0.18 + (i % 4) * 0.03 }); });
const pulseGeo = new THREE.BufferGeometry();
pulseGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PULSES.length * 3), 3));
pulseGeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(PULSES.length * 3).fill(1), 3));
pulseGeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(PULSES.length).fill(0.16), 1));
pulseGeo.setAttribute('aJit', new THREE.BufferAttribute(new Float32Array(PULSES.length * 3), 3));
const pulses = new THREE.Points(pulseGeo, graphMat); pulses.frustumCulled = false; graph.add(pulses);

// HTML labels for nodes
const labelsEl = document.getElementById('labels');
const labels = NODES.map((n) => { const d = document.createElement('div'); d.className = 'nl'; d.textContent = n.id; d.style.opacity = 0; labelsEl.appendChild(d); return d; });

/* ───────────── camera keyframes driven by scroll ───────────── */
const KF = [
  { pos: [3.6, 2.1, 5.4], tgt: [0.1, 0.7, 0], shift: 0.2 },    // hero
  { pos: [-2.4, 1.5, 4.8], tgt: [0.1, 0.65, 0], shift: 0.2 },  // embodied
  { pos: [0.3, 4.1, 4.3], tgt: [0.1, 0.3, 0], shift: 0.2 },    // real2sim
  { pos: [0.2, 1.0, 8.0], tgt: [0.1, 0.9, 0], shift: 0.0 },    // ai4ai
  { pos: [0.4, 1.3, 10.5], tgt: [0.1, 1.0, 0], shift: 0.0 },   // projects
  { pos: [0.4, 1.3, 11.5], tgt: [0.1, 1.0, 0], shift: 0.0 },   // stack
];
const sections = [...document.querySelectorAll('main > section')];
let scrollP = 0;
const forcedP = new URLSearchParams(location.search).get('p'); // ?p=2.2 pins the scene stage (debug / screenshots)
function computeScrollP() {
  if (forcedP !== null) { scrollP = +forcedP; return; }
  // fractional section index based on section tops
  const y = scrollY + innerHeight * 0.5;
  let i = 0;
  for (let k = 0; k < sections.length; k++) if (sections[k].offsetTop <= y) i = k;
  const a = sections[i].offsetTop, b = sections[i + 1] ? sections[i + 1].offsetTop : a + sections[i].offsetHeight;
  scrollP = i + clamp((y - a) / Math.max(1, b - a));
  // center-biased: map so that integer = section centre
  scrollP = clamp(scrollP - 0.5, 0, sections.length - 1);
}
{ const sy = new URLSearchParams(location.search).get('sec'); if (sy !== null) addEventListener('load', () => scrollTo({ top: sections[+sy].offsetTop, behavior: 'instant' })); }
const bar = document.getElementById('bar');
const dots = document.getElementById('dots');
sections.forEach((s) => { const a = document.createElement('a'); a.href = '#' + s.id; dots.appendChild(a); });
function updateUI() {
  const max = document.documentElement.scrollHeight - innerHeight;
  bar.style.width = (scrollY / Math.max(1, max) * 100) + '%';
  const idx = Math.round(scrollP);
  [...dots.children].forEach((d, i) => d.classList.toggle('on', i === idx));
}
addEventListener('scroll', () => { computeScrollP(); updateUI(); }, { passive: true });

/* mouse parallax */
const mouse = { x: 0, y: 0, sx: 0, sy: 0 };
addEventListener('pointermove', (e) => { mouse.x = e.clientX / innerWidth * 2 - 1; mouse.y = e.clientY / innerHeight * 2 - 1; });

/* ───────────── resize ───────────── */
let W = 0, H = 0;
function resize() {
  W = innerWidth; H = innerHeight;
  const dpr = Math.min(devicePixelRatio || 1, 1.75);
  renderer.setPixelRatio(dpr); renderer.setSize(W, H, false);
  camera.aspect = W / H; camera.updateProjectionMatrix();
  U.px.value = H * dpr * 1.302;
  computeScrollP(); updateUI();
}
addEventListener('resize', resize); resize();

/* ───────────── loop ───────────── */
const clock = new THREE.Clock();
const camPos = new THREE.Vector3(), camTgt = new THREE.Vector3(), shiftS = { v: 0.2 };
const v3 = (a) => new THREE.Vector3(...a);
let t = 0;
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!reduceMotion) t += dt;
  U.time.value = t;
  mouse.sx += (mouse.x - mouse.sx) * 0.05; mouse.sy += (mouse.y - mouse.sy) * 0.05;

  // keyframe blend
  const p = scrollP, i = Math.min(KF.length - 2, Math.floor(p)), f = sstep(0, 1, p - i);
  const A = KF[i], B = KF[i + 1];
  camPos.lerpVectors(v3(A.pos), v3(B.pos), f); camTgt.lerpVectors(v3(A.tgt), v3(B.tgt), f);
  const shift = lerp(A.shift, B.shift, f);
  // gentle orbit + parallax
  const orbit = Math.sin(t * 0.18) * 0.12 + mouse.sx * 0.18;
  const off = camPos.clone().sub(camTgt);
  off.applyAxisAngle(new THREE.Vector3(0, 1, 0), orbit);
  off.y += -mouse.sy * 0.35;
  camera.position.copy(camTgt).add(off);
  camera.lookAt(camTgt);
  camera.setViewOffset(W, H, -shift * W, 0, W, H);

  // stage state
  U.armMix.value = sstep(1.55, 2.35, p) * (1 - 0.0);
  U.armAlpha.value = (1 - sstep(2.4, 2.95, p)) + 0.1 * sstep(3.7, 4.4, p);
  U.graphAlpha.value = sstep(2.7, 3.15, p) * (1 - 0.82 * sstep(3.7, 4.4, p));
  U.bgAlpha.value = 0.65;
  lineMat.opacity = U.armMix.value * 0.55 * clamp(U.armAlpha.value);
  world.visible = U.armAlpha.value > 0.01; graph.visible = U.graphAlpha.value > 0.01;

  if (world.visible) stepArm(reduceMotion ? 0 : dt);
  if (reduceMotion && world.visible && !frame.once) { frame.once = 1; segT = 0; seg = 2; stepArm(0.0001); }

  // graph animation
  if (graph.visible) {
    graph.rotation.y = Math.sin(t * 0.22) * 0.14 + mouse.sx * 0.12;
    const arr = pulseGeo.attributes.position.array;
    PULSES.forEach((pl, k) => {
      const s = (t * pl.sp + pl.off) % 1, a = nodeVec[pl.e[0]], b = nodeVec[pl.e[1]];
      arr[k * 3] = lerp(a.x, b.x, s); arr[k * 3 + 1] = lerp(a.y, b.y, s); arr[k * 3 + 2] = lerp(a.z, b.z, s);
    });
    pulseGeo.attributes.position.needsUpdate = true;
    graph.updateMatrixWorld();
    NODES.forEach((n, k) => {
      tmpV.copy(nodeVec[k]).applyMatrix4(graph.matrixWorld).project(camera);
      const x = (tmpV.x * 0.5 + 0.5) * W, y = (-tmpV.y * 0.5 + 0.5) * H;
      labels[k].style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-190%)`;
      labels[k].style.opacity = (clamp(U.graphAlpha.value * 1.4 - 0.2) * (tmpV.z < 1 ? 1 : 0)).toFixed(2);
    });
  } else labels.forEach((l) => (l.style.opacity = 0));

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ───────────── content: i18n, projects, live GitHub data ───────────── */
const PROJECTS = [
  { n: 'opengeniemaster', s: 494, c: ['embodied', 'ai4ai'], d: ['Open-source embodied agent harness: execution, feedback, and continual improvement. EEP over MCP.', '开源具身 Agent Harness：执行、反馈与持续改进，基于 MCP 的 EEP 协议。'], l: 'Python' },
  { n: 'CSNative', s: 137, c: ['ai4ai'], d: ['Provider routing and custom models for Claude Science. Local-first, macOS, Go + Wails.', 'Claude Science 的模型供应商路由与自定义模型，本地优先，Go + Wails。'], l: 'Go' },
  { n: 'agentic-embedded-lab', s: 35, c: ['ai4ai', 'embodied'], d: ['Agent-native embedded systems lab: pluggable simulation, evidence-driven validation, controlled evolution.', '面向 Agent 的嵌入式实验室：可插拔仿真、证据驱动验证、受控进化。'], l: 'Python' },
  { n: 'amd-bigym-3dgs-rocm', s: 29, c: ['real2sim', 'embodied'], d: ['AMD ROCm reproduction of the DL3DV kitchen 3DGS shell for BiGym / MuJoCo, with verified W7900D artifacts.', '在 AMD ROCm 上复现 3DGS 厨房场景用于 BiGym / MuJoCo，附 W7900D 实测产物。'], l: 'Python' },
  { n: 'amd-bigym-openpi-eval', s: 3, c: ['embodied'], d: ['Reproducible ROCm evaluation with full three-camera recording for BiGym, OpenPI (JAX), MuJoCo and 3DGS.', 'BiGym + OpenPI(JAX) + MuJoCo + 3DGS 的可复现 ROCm 评测，全程三相机录制。'], l: 'Python' },
  { n: 'real2simcapture', s: 3, c: ['real2sim'], d: ['iPhone capture to simulation assets: ARKit meshes, RGB-D, web inspection, MJCF / URDF / USD export.', 'iPhone 采集到仿真资产：ARKit 网格、RGB-D、网页检查、MJCF/URDF/USD 导出。'], l: 'Python' },
  { n: 'images23dgs', s: 4, c: ['real2sim'], d: ['Image / RGBD to 3D Gaussian Splatting — integrated web product.', '图片 / RGBD 到 3DGS 的一体化 Web 产品。'], l: 'Python' },
  { n: 'gsstudio-public', s: 3, c: ['real2sim'], d: ['GaussianSplatting studio: FastAPI + React, HY-World, 3D reconstruction.', '3DGS 工作台：FastAPI + React，HY-World，三维重建。'], l: 'Python' },
  { n: 'real2sim-platform', s: 1, c: ['real2sim'], d: ['Real2Sim Studio: local-first 3D assets, material presets and reproducible Genesis FEM exports.', 'Real2Sim Studio：本地优先 3D 资产、材质预设、可复现 Genesis FEM 导出。'], l: 'TypeScript' },
  { n: 'Real2Motrix', s: 2, c: ['real2sim'], d: ['Local capture and mesh processing into validated MJCF / URDF scene packages.', '本地采集与网格处理，输出经校验的 MJCF / URDF 场景包。'], l: 'Python' },
  { n: 'WorldSpec', s: 1, c: ['embodied'], d: ['Canonical world semantics, evidence, validation and multi-simulator compilation for embodied AI.', '具身 AI 的统一世界语义、证据与校验，并编译到多个仿真器。'], l: 'Python' },
  { n: 'robodata', s: 1, c: ['embodied'], d: ['Robot dataset conversion, inspection, quality analysis and episode segmentation.', '机器人数据集转换、检查、质量分析与 episode 切分。'], l: 'Python' },
  { n: 'open-embodied-simops', s: 1, c: ['embodied'], d: ['Self-hosted robotics workflow workbench: simulation integrations, dataset tools, training and artifact provenance.', '自托管机器人工作流工作台：仿真集成、数据工具、训练与产物溯源。'], l: 'Python' },
  { n: 'open-robotics-plugin', s: 0, c: ['ai4ai', 'embodied'], d: ['Robotics agent skills (MuJoCo, perception, planning, sim2real, bring-up) for Claude Code, Codex, Gemini CLI, Cursor.', '机器人 Agent 技能包（MuJoCo、感知、规划、sim2real、bring-up），适配 Claude Code / Codex / Gemini CLI / Cursor。'], l: 'Python' },
  { n: 'kakashi', s: 5, c: ['ai4ai'], d: ['Codex-powered GitHub multi-repository capability fusion system.', '基于 Codex 的 GitHub 多仓库能力融合系统。'], l: 'TypeScript' },
  { n: 'codex-dispatch', s: 1, c: ['ai4ai'], d: ['Local-first task queues for Codex CLI: SQLite persistence, per-session FIFO.', 'Codex CLI 本地优先任务队列：SQLite 持久化、按会话 FIFO。'], l: 'JavaScript' },
  { n: 'actor-map', s: 2, c: ['ai4ai'], d: ['Turn a product conversation into an assertable actor map with ✔/⚠ checklists.', '把产品对话聊成带 ✔/⚠ 断言清单的角色地图。'], l: 'TypeScript' },
  { n: 'superscience', s: 2, c: ['ai4ai'], d: ['Local research workbench for papers, code, notebooks and traceable evidence. Go + React + Wails.', '本地科研工作台：论文、代码、Notebook 与可追溯证据。'], l: 'Go' },
  { n: 'cityagent-public', s: 3, c: ['ai4ai'], d: ['Evidence-backed bridge report extraction with LoRA training, W8A8 quantization and resumable inference.', '证据可追溯的桥梁报告抽取：LoRA 训练、W8A8 量化、可续跑推理。'], l: 'Python' },
  { n: 'simulacra-bench', s: 3, c: ['embodied', 'ai4ai'], d: ['NeurIPS 2026 SimulacraBench entry.', 'NeurIPS 2026 SimulacraBench 参赛项目。'], l: 'Python' },
  { n: 'shanghai-city-digital-twin-plan', s: 2, c: ['real2sim'], d: ['Reproducible OpenStreetMap → 3D city assets with provenance and explicit validation limits.', '可复现的 OSM → 3D 城市资产，含溯源与明确的验证边界。'], l: 'Python' },
];
let lang = (localStorage.getItem('lang') || (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
if (localStorage.getItem('lang')) lang = localStorage.getItem('lang');

const grid = document.getElementById('grid');
function renderGrid(filter = 'all') {
  grid.innerHTML = '';
  PROJECTS.filter((p) => filter === 'all' || p.c.includes(filter)).forEach((p) => {
    const a = document.createElement('a');
    a.className = 'card'; a.href = 'https://github.com/eust-w/' + p.n; a.target = '_blank'; a.rel = 'noopener';
    a.innerHTML = `<div class="top"><span class="nm">${p.n}</span><span class="st" data-star="${p.n}">${p.s ? '★ ' + p.s : ''}</span></div>
      <p>${p.d[lang === 'zh' ? 1 : 0]}</p>
      <div class="meta"><span>${p.l}</span>${p.c.map((c) => `<span class="c-${c}">${c}</span>`).join('')}</div>`;
    grid.appendChild(a);
  });
}
const filters = document.getElementById('filters');
filters.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  [...filters.children].forEach((x) => x.classList.toggle('on', x === b));
  renderGrid(b.dataset.f);
});

const tEls = [...document.querySelectorAll('.t')];
tEls.forEach((el) => { el.dataset.en = el.innerHTML; });
function applyLang() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  tEls.forEach((el) => { el.innerHTML = lang === 'zh' && el.dataset.zh ? el.dataset.zh : el.dataset.en; });
  renderGrid(filters.querySelector('.on').dataset.f);
  applyLiveStars();
}
document.getElementById('lang').addEventListener('click', () => { lang = lang === 'zh' ? 'en' : 'zh'; localStorage.setItem('lang', lang); applyLang(); });

/* live GitHub data (falls back to the static snapshot above if rate-limited / offline) */
let liveStars = {};
function applyLiveStars() {
  document.querySelectorAll('[data-star]').forEach((el) => { const s = liveStars[el.dataset.star]; if (s != null) el.textContent = s ? '★ ' + s : ''; });
}
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
function countUp(el, to, ms = 1400) {
  const t0 = performance.now(), isK = to >= 1000;
  const tick = (now) => {
    const k = sstep(0, 1, (now - t0) / ms), v = Math.round(to * k);
    el.textContent = isK ? fmt(v) : v; if (k < 1) requestAnimationFrame(tick); else el.textContent = isK ? fmt(to) : to;
  };
  requestAnimationFrame(tick);
}
document.querySelectorAll('[data-count]').forEach((el) => countUp(el, +el.dataset.count));
(async () => {
  try {
    const u = await (await fetch('https://api.github.com/users/eust-w')).json();
    if (!u.followers) return;
    const pages = await Promise.all([1, 2, 3].map((n) => fetch(`https://api.github.com/users/eust-w/repos?per_page=100&page=${n}`).then((r) => r.json())));
    const repos = pages.flat().filter(Array.isArray ? Boolean : Boolean);
    let total = 0, top = 0;
    repos.forEach((r) => { liveStars[r.name] = r.stargazers_count; if (!r.fork) { total += r.stargazers_count; top = Math.max(top, r.stargazers_count); } });
    countUp(document.getElementById('s-followers'), u.followers);
    countUp(document.getElementById('s-repos'), u.public_repos);
    if (total) countUp(document.getElementById('s-stars'), total);
    if (top) countUp(document.getElementById('s-top'), top);
    applyLiveStars();
  } catch (_) { /* keep static snapshot */ }
})();

applyLang();
