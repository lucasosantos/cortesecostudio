// Motor WebGL2 compartilhado: compila os shaders das extensões e roda cadeias de efeitos e transições.
// O resultado fica no canvas WebGL e deve ser copiado (drawImage) antes da próxima chamada.
import { VERTEX } from './shader.js';

const MAX_SIZE = 4096;
let canvas = null;
let gl = null;
let failed = false;
let quad = null;
let vertexShader = null;
const programs = new Map(); // fonte do fragment → { program, uniforms } | { error }
const textures = []; // texturas de entrada reutilizadas
const targets = []; // framebuffers do ping-pong: { fbo, tex, w, h }

function init() {
  if (gl || failed) return gl;
  try {
    canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(2, 2) : document.createElement('canvas');
    gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false, depth: false, stencil: false });
  } catch {
    gl = null;
  }
  if (!gl) {
    failed = true;
    return null;
  }
  canvas.addEventListener?.('webglcontextlost', (e) => {
    // tudo que foi criado no contexto perdido deixa de valer; recria sob demanda
    e.preventDefault();
    gl = null;
    quad = null;
    vertexShader = null;
    programs.clear();
    textures.length = 0;
    targets.length = 0;
  });
  quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.disable(gl.BLEND);
  return gl;
}

export const glAvailable = () => !!init();

/** Nome do renderizador WebGL (placa de vídeo ou renderizador por software), ou '' se não há WebGL2. */
export function glRenderer() {
  if (!init()) return '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
  } catch {
    return '';
  }
}

/** O nome indica que o desenho está sendo feito pelo processador, sem placa de vídeo? */
export const isSoftwareRenderer = (name) => /swiftshader|llvmpipe|softpipe|software|basic render/i.test(String(name || ''));

function compileShader(type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || 'erro de compilação';
    gl.deleteShader(sh);
    throw Object.assign(new Error(log), { shaderLog: log });
  }
  return sh;
}

/** Programa compilado para o fragment shader (com cache). Lança erro com `.shaderLog`. */
function programFor(frag) {
  const hit = programs.get(frag);
  if (hit) {
    if (hit.error) throw hit.error;
    return hit;
  }
  try {
    vertexShader ||= compileShader(gl.VERTEX_SHADER, VERTEX);
    const fs = compileShader(gl.FRAGMENT_SHADER, frag);
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'aPos');
    gl.linkProgram(program);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) || 'erro ao ligar o programa';
      gl.deleteProgram(program);
      throw Object.assign(new Error(log), { shaderLog: log });
    }
    const uniforms = new Map();
    const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(program, i);
      uniforms.set(info.name.replace(/\[0\]$/, ''), { loc: gl.getUniformLocation(program, info.name), type: info.type });
    }
    const entry = { program, uniforms };
    programs.set(frag, entry);
    return entry;
  } catch (error) {
    // guarda o erro para não recompilar o mesmo código quebrado a cada frame
    programs.set(frag, { error });
    throw error;
  }
}

/** Testa a compilação de um fragment shader. @returns { ok, log } */
export function checkShader(frag) {
  if (!init()) return { ok: false, log: 'WebGL2 não está disponível neste ambiente.' };
  programs.delete(frag);
  try {
    programFor(frag);
    return { ok: true, log: '' };
  } catch (e) {
    return { ok: false, log: e.shaderLog || String(e.message || e) };
  }
}

function setUniform(entry, name, value) {
  const u = entry.uniforms.get(name);
  if (!u || value === undefined || value === null) return;
  const { loc, type } = u;
  const arr = Array.isArray(value) ? value : [value];
  switch (type) {
    case gl.FLOAT: gl.uniform1f(loc, Number(arr[0]) || 0); break;
    case gl.INT: case gl.BOOL: case gl.SAMPLER_2D: gl.uniform1i(loc, Math.round(Number(arr[0]) || 0)); break;
    case gl.FLOAT_VEC2: gl.uniform2f(loc, arr[0] || 0, arr[1] || 0); break;
    case gl.FLOAT_VEC3: gl.uniform3f(loc, arr[0] || 0, arr[1] || 0, arr[2] || 0); break;
    case gl.FLOAT_VEC4: gl.uniform4f(loc, arr[0] || 0, arr[1] || 0, arr[2] || 0, arr[3] ?? 1); break;
    case gl.INT_VEC2: gl.uniform2i(loc, Math.round(arr[0] || 0), Math.round(arr[1] || 0)); break;
    default: break;
  }
}

function sourceTexture(slot, source) {
  let tex = textures[slot];
  if (!tex) {
    tex = textures[slot] = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  return tex;
}

function target(i, w, h) {
  let t = targets[i];
  if (!t) {
    t = targets[i] = { fbo: gl.createFramebuffer(), tex: gl.createTexture(), w: 0, h: 0 };
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  if (t.w !== w || t.h !== h) {
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    t.w = w;
    t.h = h;
  }
  return t;
}

function prepare(w, h) {
  w = Math.max(1, Math.min(MAX_SIZE, Math.round(w)));
  h = Math.max(1, Math.min(MAX_SIZE, Math.round(h)));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  gl.viewport(0, 0, w, h);
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  return [w, h];
}

function draw(entry, uniforms, w, h, samplers) {
  gl.useProgram(entry.program);
  setUniform(entry, 'resolution', [w, h]);
  setUniform(entry, 'ratio', w / h);
  for (const name in uniforms) setUniform(entry, name, uniforms[name]);
  samplers.forEach(([name, tex], unit) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    setUniform(entry, name, unit);
  });
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

/**
 * Passa `source` por uma cadeia de efeitos.
 * @param passes [{ frag, uniforms }] — shaders que não compilam são pulados
 * @returns o canvas WebGL com o resultado, ou null se nada pôde ser aplicado
 */
export function runChain(source, width, height, passes) {
  if (!passes.length || !init()) return null;
  const ready = [];
  for (const pass of passes) {
    try {
      ready.push({ entry: programFor(pass.frag), uniforms: pass.uniforms || {} });
    } catch {
      /* efeito com erro de compilação: o inspector mostra o aviso */
    }
  }
  if (!ready.length) return null;
  const [w, h] = prepare(width, height);
  gl.activeTexture(gl.TEXTURE0);
  let input = sourceTexture(0, source);
  ready.forEach((pass, i) => {
    const last = i === ready.length - 1;
    const out = last ? null : target(i % 2, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fbo : null);
    draw(pass.entry, pass.uniforms, w, h, [['uSrc', input]]);
    if (out) input = out.tex;
  });
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return canvas;
}

/** Roda uma transição entre duas imagens do mesmo tamanho. @returns o canvas WebGL, ou null. */
export function runTransition(from, to, width, height, frag, uniforms) {
  if (!init()) return null;
  let entry;
  try {
    entry = programFor(frag);
  } catch {
    return null;
  }
  const [w, h] = prepare(width, height);
  gl.activeTexture(gl.TEXTURE0);
  const a = sourceTexture(0, from);
  gl.activeTexture(gl.TEXTURE1);
  const b = sourceTexture(1, to);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  draw(entry, uniforms, w, h, [['uFrom', a], ['uTo', b]]);
  return canvas;
}

/** Erro de compilação guardado para um shader já tentado (ou null). */
export function shaderError(frag) {
  const hit = programs.get(frag);
  return hit?.error ? hit.error.shaderLog || String(hit.error.message) : null;
}
