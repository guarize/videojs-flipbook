/**
 * Real paper, for the big moments: a small hand-written WebGL renderer that bends a page around a moving cylinder,
 * as a page curls when it's turned. The page is a subdivided sheet; where it wraps the cylinder it's lit by its
 * angle to the light (with a specular ridge along the curl), past the cylinder it lies flipped, showing its paper
 * back with a faint print-through. The page beneath takes a soft shadow from the curl.
 *
 * A Paper exists only while a turn or riffle runs: it creates its canvas and context on demand and releases both
 * when it's disposed.
 */

export interface Sheet {
  /** The page's own picture. */
  texture: WebGLTexture;
  /** How far the turn has gone, from 0 (the leading corner just lifting) to 1 (the page has left the frame). */
  progress: number;
  /** 1 turns the page right to left (forward), -1 left to right (back). */
  direction: 1 | -1;
  /** How far the axis leans (radians): positive, the bottom corner leads; negative, the top corner does. */
  tilt: number;
  /** The curl's radius, as a share of the page's height: small at the corner, larger as the page lifts. */
  radius: number;
}

/** How a turn is shaped. `tilt` is the lean at the start (its sign picks the corner); `lift` how high the page rolls. */
export interface TurnShape {
  tilt: number;
  lift: number;
}

/** A hand turning a page: the corner lifts, the page rolls over high in the middle, and lies flat again as it goes. */
export const PAGE: TurnShape = { tilt: 0.36, lift: 1 };
/** A thumb riffling the stack: lower and quicker, the corner leading more. */
export const RIFFLE: TurnShape = { tilt: 0.5, lift: 0.6 };

/** The sheet's shape at a point of a turn: progress `p` (0–1), shaped by `shape`. */
export function shapeAt(p: number, direction: 1 | -1, shape: TurnShape = PAGE): Omit<Sheet, 'texture'> {
  const progress = Math.min(1, Math.max(0, p));
  // The lean eases out as the page goes over, so the leading corner settles back in line.
  const tilt = shape.tilt * (1 - progress) ** 1.6;
  // The roll: tight at the corner, widest a little before halfway, tight again as the page lies down past the edge.
  const radius = 0.045 + 0.2 * shape.lift * Math.sin(Math.PI * Math.min(1, progress * 1.12)) ** 0.85;
  return { progress, direction, tilt, radius };
}

/** The sheet with its picture at a point of a turn. */
export function pose(texture: WebGLTexture, p: number, direction: 1 | -1, shape: TurnShape = PAGE): Sheet {
  return { texture, ...shapeAt(p, direction, shape) };
}

/** The top corner leads: the same turn, leaning the other way (the corner curl lifts the top corner). */
export const fromTop = (shape: TurnShape): TurnShape => ({ ...shape, tilt: -Math.abs(shape.tilt) });

/**
 * Time to progress for a turn: a cubic Bézier (0.22, 0.24, 0.6, 0.94). The corner moves from the first frame (no dead
 * start), the page sweeps through the middle, and it still has some speed as it falls past the spine, as paper does.
 */
export function turnCurve(t: number): number {
  return bezier(0.22, 0.24, 0.6, 0.94, Math.min(1, Math.max(0, t)));
}

function bezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const error = sampleX(t) - x;
    if (Math.abs(error) < 1e-5) break;
    const slope = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(slope) < 1e-6) break;
    t -= error / slope;
  }
  t = Math.min(1, Math.max(0, t));
  return ((ay * t + by) * t + cy) * t;
}

const SEGMENTS_X = 96;
const SEGMENTS_Y = 48;
const PI = Math.PI;

const VERTEX = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
attribute vec2 aPos;
uniform float uAspect;
uniform float uAxis;
uniform float uTilt;
uniform float uRadius;
uniform float uDir;
uniform float uFlat;
varying vec2 vUv;
varying vec2 vP;
varying vec3 vNormal;
varying float vRise;
varying float vD;

void main() {
  vUv = vec2(aPos.x, 1.0 - aPos.y);
  float x = uDir > 0.0 ? aPos.x : 1.0 - aPos.x;
  vec2 p = vec2(x * uAspect, aPos.y);
  vec2 n = vec2(cos(uTilt), -sin(uTilt));
  float d = dot(p - vec2(uAxis, 0.0), n);
  vec3 pos = vec3(p, 0.0);
  vec3 nor = vec3(0.0, 0.0, 1.0);
  float r = uRadius;
  if (uFlat < 0.5 && d > 0.0) {
    if (d < ${PI.toFixed(6)} * r) {
      float a = d / r;
      pos.xy = p - n * d + n * (r * sin(a));
      pos.z = r * (1.0 - cos(a));
      nor = vec3(-n * sin(a), cos(a));
    } else {
      pos.xy = p - n * d - n * (d - ${PI.toFixed(6)} * r);
      pos.z = 2.0 * r;
      nor = vec3(0.0, 0.0, -1.0);
    }
  }
  vP = p;
  vD = d;
  if (uDir < 0.0) {
    pos.x = uAspect - pos.x;
    nor.x = -nor.x;
  }
  vNormal = nor;
  vRise = pos.z;
  // A gentle perspective: what lifts toward you grows a little, as a page does when it rises off the book.
  float w = 1.0 - pos.z / 3.2;
  vec2 clip = vec2(pos.x / uAspect * 2.0 - 1.0, pos.y * 2.0 - 1.0);
  gl_Position = vec4(clip, -pos.z * 0.8 * w, w);
}
`;

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uImage;
uniform float uDir;
uniform float uAspect;
uniform float uAxis;
uniform float uTilt;
uniform float uRadius;
uniform float uShadow;
uniform float uFlat;
uniform float uShadowOnly;
varying vec2 vUv;
varying vec2 vP;
varying vec3 vNormal;
varying float vRise;
varying float vD;

const float PI = ${PI.toFixed(6)};

// How far a point lies outside the page (0 inside).
float outside(vec2 g) {
  vec2 o = max(vec2(0.0), max(-g, g - vec2(uAspect, 1.0)));
  return length(o);
}

void main() {
  vec3 L = normalize(vec3(-0.35, 0.45, 1.0));
  // A back turn mirrors the sheet twice (its grid, then its place), so the winding, and the side you see, holds.
  bool front = gl_FrontFacing;
  vec3 N = normalize(vNormal);
  if (!front) N = -N;
  vec3 image = texture2D(uImage, vUv).rgb;
  vec2 n = vec2(cos(uTilt), -sin(uTilt));
  float r = uRadius;
  vec3 color;
  if (uFlat > 0.5) {
    // The page beneath: a soft shadow where the roll above it stands, wider the higher it rolls, and a faint dimming
    // of the whole page while the sheet above keeps the light off it.
    float spread = 0.03 + 0.55 * r;
    float shade = vD > 0.0 ? exp(-vD / spread) * 0.5 : smoothstep(-spread * 0.5, 0.0, vD) * 0.5;
    shade += 0.06 * smoothstep(0.04, 0.2, r);
    if (uShadowOnly > 0.5) {
      // Nothing drawn beneath (the live video shows through): only the shadow, laid over it.
      gl_FragColor = vec4(0.0, 0.0, 0.0, clamp(shade * uShadow, 0.0, 1.0));
      return;
    }
    color = image * (1.0 - shade * uShadow);
  } else if (vD <= 0.0) {
    // The part still lying flat. Where the turned-over back hovers just above it, its edge casts a soft shadow.
    float s = -vD;
    float beyond = outside(vP + n * (2.0 * s + PI * r)) * 0.5;
    float soft = 0.012 + 0.35 * r;
    float shadow = beyond > 0.0 ? exp(-beyond / soft) * 0.32 : 0.0;
    // And the paper darkens slightly where it starts to rise into the roll.
    shadow += (1.0 - smoothstep(0.0, r * 0.9 + 0.01, s)) * 0.1;
    color = image * (1.0 - shadow * smoothstep(0.0, 0.06, r));
  } else {
    // Lit so a flat page reads exactly as the picture; tilted toward the light it brightens, away it darkens.
    float lit = clamp(0.5 + 0.5 * max(dot(N, L), 0.0) / L.z, 0.0, 1.15);
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    float gloss = pow(max(dot(N, H), 0.0), 40.0) * smoothstep(0.0, 0.03, vRise);
    if (front) {
      color = image * lit + vec3(gloss * 0.22);
    } else {
      // The paper back: warm, thin paper with the picture showing through it, mirrored as it would be.
      vec3 paper = vec3(0.945, 0.925, 0.885);
      vec3 through = paper * (0.68 + 0.32 * image);
      // On the roll it's lit by its curve (dark where it turns from the light, a bright ridge on top); lying flat past
      // the roll it's shaded near the curl, which keeps light off it, and brightens toward the free edge.
      float onRoll = 1.0 - step(PI * r, vD);
      float roll = smoothstep(PI * r, PI * r + 0.45, vD);
      float light = mix((0.84 + 0.16 * lit) * (0.88 + 0.12 * roll), 0.6 + 0.4 * lit, onRoll);
      color = through * light + vec3(gloss * 0.32);
    }
  }
  gl_FragColor = vec4(color, 1.0);
}
`;

export class Paper {
  readonly canvas: HTMLCanvasElement;
  #gl: WebGLRenderingContext;
  #program: WebGLProgram;
  #buffer: WebGLBuffer;
  #index: WebGLBuffer;
  #count: number;
  #uniforms: Record<string, WebGLUniformLocation | null> = {};
  #textures: WebGLTexture[] = [];
  #aspect = 16 / 9;
  /** Timings of the frames drawn, for anyone measuring the cost of a turn. */
  readonly stats = { frames: 0, draw: 0, worst: 0 };

  static create(host: HTMLElement): Paper | null {
    const canvas = document.createElement('canvas');
    canvas.className = 'fb-paper';
    canvas.setAttribute('aria-hidden', 'true');
    const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true, depth: true, powerPreference: 'high-performance' });
    if (!gl) return null;
    try {
      const paper = new Paper(canvas, gl);
      host.append(canvas);
      paper.resize(host);
      return paper;
    } catch {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return null;
    }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGLRenderingContext) {
    this.canvas = canvas;
    this.#gl = gl;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('shader');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader');
      return shader;
    };
    const program = gl.createProgram();
    if (!program) throw new Error('program');
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link');
    this.#program = program;
    gl.useProgram(program);
    for (const name of ['uAspect', 'uAxis', 'uTilt', 'uRadius', 'uDir', 'uFlat', 'uShadow', 'uShadowOnly', 'uImage']) {
      this.#uniforms[name] = gl.getUniformLocation(program, name);
    }

    // The sheet: a grid of vertices, fine enough that the curl reads as a smooth bend.
    const vertices = new Float32Array((SEGMENTS_X + 1) * (SEGMENTS_Y + 1) * 2);
    let v = 0;
    for (let j = 0; j <= SEGMENTS_Y; j++) {
      for (let i = 0; i <= SEGMENTS_X; i++) {
        vertices[v++] = i / SEGMENTS_X;
        vertices[v++] = j / SEGMENTS_Y;
      }
    }
    const indices = new Uint16Array(SEGMENTS_X * SEGMENTS_Y * 6);
    let k = 0;
    for (let j = 0; j < SEGMENTS_Y; j++) {
      for (let i = 0; i < SEGMENTS_X; i++) {
        const a = j * (SEGMENTS_X + 1) + i;
        const b = a + 1;
        const c = a + SEGMENTS_X + 1;
        const d = c + 1;
        indices.set([a, b, c, b, d, c], k);
        k += 6;
      }
    }
    this.#count = indices.length;
    const buffer = gl.createBuffer();
    const index = gl.createBuffer();
    if (!buffer || !index) throw new Error('buffer');
    this.#buffer = buffer;
    this.#index = index;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    // Premultiplied blending: the sheets are opaque; a shadow-only page beneath is translucent over the video.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  /** Matches the canvas to the picture's box, at up to twice the CSS resolution. */
  resize(host: HTMLElement) {
    const box = host.getBoundingClientRect();
    const scale = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(2, Math.round(box.width * scale));
    this.canvas.height = Math.max(2, Math.round(box.height * scale));
    this.#aspect = box.width / Math.max(1, box.height);
    this.#gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Uploads a picture: the live video frame, a decoded image, or a bitmap. */
  texture(source: TexImageSource): WebGLTexture | null {
    const gl = this.#gl;
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch {
      gl.deleteTexture(texture);
      return null;
    }
    this.#textures.push(texture);
    return texture;
  }

  /**
   * Draws one frame: the flat page underneath (taking the shadow of the sheet just above it), then each turning
   * sheet from the bottom of the stack to the top. With `'shadow'` beneath, nothing is drawn there but the shadow,
   * so whatever is behind the canvas (the playing video) shows through it.
   */
  draw(under: WebGLTexture | 'shadow' | null, sheets: Sheet[]) {
    const start = performance.now();
    const gl = this.#gl;
    const u = this.#uniforms;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniform1f(u.uAspect, this.#aspect);
    gl.uniform1i(u.uImage, 0);
    gl.activeTexture(gl.TEXTURE0);

    const axisOf = (sheet: Omit<Sheet, 'texture'>) => this.#axis(sheet);
    const set = (sheet: Omit<Sheet, 'texture'>, flat: boolean) => {
      gl.uniform1f(u.uAxis, axisOf(sheet));
      gl.uniform1f(u.uTilt, sheet.tilt);
      gl.uniform1f(u.uRadius, sheet.radius);
      gl.uniform1f(u.uDir, sheet.direction);
      gl.uniform1f(u.uFlat, flat ? 1 : 0);
    };

    gl.uniform1f(u.uShadowOnly, under === 'shadow' ? 1 : 0);
    if (under) {
      const above = sheets[sheets.length - 1];
      set(above ?? { progress: 0, direction: 1, tilt: 0, radius: 0.05 }, true);
      // The shadow comes in as the corner lifts and goes as the page leaves.
      gl.uniform1f(u.uShadow, above ? Math.min(1, above.progress * 8) * (1 - Math.max(0, above.progress - 0.8) / 0.2) : 0);
      if (under !== 'shadow') gl.bindTexture(gl.TEXTURE_2D, under);
      gl.drawElements(gl.TRIANGLES, this.#count, gl.UNSIGNED_SHORT, 0);
      gl.uniform1f(u.uShadowOnly, 0);
    }
    for (let i = sheets.length - 1; i >= 0; i--) {
      const sheet = sheets[i];
      gl.clear(gl.DEPTH_BUFFER_BIT);
      set(sheet, false);
      gl.bindTexture(gl.TEXTURE_2D, sheet.texture);
      gl.drawElements(gl.TRIANGLES, this.#count, gl.UNSIGNED_SHORT, 0);
    }
    const spent = performance.now() - start;
    this.stats.frames++;
    this.stats.draw += spent;
    this.stats.worst = Math.max(this.stats.worst, spent);
  }

  /**
   * The axis starts just inside the leading corner, so the first frame already shows it lifting, and travels until the
   * roll itself has left the frame: slowly while the free edge sweeps across the picture (it moves twice as fast as
   * the axis), quicker once it has passed the spine and only the roll is left to clear.
   */
  #axis(sheet: Omit<Sheet, 'texture'>): number {
    const start = this.#aspect - (sheet.tilt < 0 ? Math.tan(sheet.tilt) : 0) - 0.08;
    const end = -(sheet.radius + 0.03) - Math.abs(Math.tan(sheet.tilt));
    const q = sheet.progress;
    return start + (end - start) * ((q + q * q * q) / 2);
  }

  /**
   * Where a turn stands when its fold already reaches `reach` (a share of the page's height) in from the leading
   * corner along its edge: so a turn can take over from a corner pulled by hand without a jump.
   */
  progressForReach(reach: number, shape: TurnShape): number {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      const sheet = shapeAt(mid, 1, shape);
      // Where the fold crosses the leading edge (the top or the bottom one).
      const crossing = this.#axis(sheet) + (sheet.tilt < 0 ? Math.tan(sheet.tilt) : 0);
      if (this.#aspect - crossing < reach) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /** Frees the textures and buffers, gives the context back, and removes the canvas. */
  dispose() {
    const gl = this.#gl;
    for (const texture of this.#textures) gl.deleteTexture(texture);
    gl.deleteBuffer(this.#buffer);
    gl.deleteBuffer(this.#index);
    gl.deleteProgram(this.#program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
  }
}

/** Whether this browser can draw paper (and the viewer hasn't asked for less motion). */
export function canCurl(): boolean {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  return typeof WebGLRenderingContext !== 'undefined';
}
