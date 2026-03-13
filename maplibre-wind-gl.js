/**
 * maplibre-wind-gl.js — GPU-accelerated wind particles for MapLibre GL JS 5.x
 *
 * Renders animated wind particles entirely on the GPU using MapLibre's
 * CustomLayerInterface. Particles are part of the map's WebGL scene —
 * they rotate, pan, and zoom with the globe in realtime.
 *
 * Technique:
 *   1. Wind U/V data encoded as a WebGL texture (R=u, G=v, normalized)
 *   2. Particle positions stored in a ring buffer of textures (RGBA 16-bit)
 *   3. Update shader: advects particles in equirectangular space
 *   4. Draw shader: for each age level, draws GL_LINES between consecutive
 *      historical positions with fading alpha (age-stratified trails)
 *   5. Speed-based color ramp sampled from a 256x1 texture
 *
 * Usage:
 *   var windGL = new MaplibreWindGL('wind-layer', {
 *     data: '/weather/wind-surface.json',
 *     particles: 100000,
 *     speed: 1,            // advection rate
 *     maxAge: 15,          // trail length in frames
 *     opacity: 0.4,
 *     colorRamp: [         // speed-based color stops [speed, r, g, b]
 *       [0,  0.3, 0.2, 0.7],
 *       [15, 0.1, 0.8, 0.6],
 *       [30, 0.9, 0.1, 0.1],
 *     ],
 *   });
 *   map.addLayer(windGL);
 *
 * @license MIT
 * @author The Beach Lab
 */
(function(global) {
  'use strict';

  var DEFAULT_PARTICLES = 100000;
  var DEFAULT_SPEED = 1.0;
  var DEFAULT_MAX_AGE = 15;
  var DEFAULT_DROP_RATE = 0.02;
  var DEFAULT_DROP_BUMP = 0;
  var DEFAULT_SPEED_RANGE = [0, 80];

  // Default color ramp: calm indigo → blue → teal → green → yellow → orange → red
  var DEFAULT_COLOR_RAMP = [
    [0,   0.30, 0.20, 0.70],
    [5,   0.10, 0.50, 0.90],
    [10,  0.10, 0.80, 0.60],
    [15,  0.40, 0.90, 0.20],
    [20,  0.90, 0.90, 0.10],
    [25,  0.90, 0.50, 0.10],
    [30,  0.90, 0.10, 0.10],
  ];

  // ── Shaders ────────────────────────────────────────────────────────

  var QUAD_VERT = [
    'precision highp float;',
    'attribute vec2 a_pos;',
    'varying vec2 v_tex_pos;',
    'void main() {',
    '  v_tex_pos = a_pos;',
    '  gl_Position = vec4(2.0 * a_pos - 1.0, 0, 1);',
    '}',
  ].join('\n');

  // Draw vertex shader — samples wind for speed-based coloring
  var DRAW_VERT = [
    'precision highp float;',
    'attribute float a_index;',
    'uniform sampler2D u_particles_prev;',
    'uniform sampler2D u_particles_curr;',
    'uniform sampler2D u_wind;',
    'uniform vec2 u_wind_min;',
    'uniform vec2 u_wind_max;',
    'uniform float u_particles_res;',
    'uniform vec2 u_speed_range;',
    'uniform mat4 u_matrix;',
    'uniform vec4 u_clipping_plane;',
    'varying float v_alpha;',
    'varying float v_speed;',
    '',
    'const float PI = 3.14159265359;',
    '',
    'vec2 decodePos(vec4 c) {',
    '  return vec2(c.r / 255.0 + c.b, c.g / 255.0 + c.a);',
    '}',
    '',
    'vec3 toSphere(vec2 p) {',
    '  float lon = p.x * 2.0 * PI;',
    '  float lat = (0.5 - p.y) * PI;',
    '  float cl = cos(lat);',
    '  return vec3(sin(lon) * cl, sin(lat), cos(lon) * cl);',
    '}',
    '',
    'void main() {',
    '  float pid = floor(a_index);',
    '  float isHead = step(0.25, fract(a_index));',
    '',
    '  vec2 uv = vec2(',
    '    mod(pid, u_particles_res) / u_particles_res,',
    '    floor(pid / u_particles_res) / u_particles_res',
    '  );',
    '',
    '  vec2 pos0 = decodePos(texture2D(u_particles_prev, uv));',
    '  vec2 pos1 = decodePos(texture2D(u_particles_curr, uv));',
    '  vec2 pos = mix(pos0, pos1, isHead);',
    '',
    '  vec3 s0 = toSphere(pos0);',
    '  vec3 s1 = toSphere(pos1);',
    '  vec3 sphere = toSphere(pos);',
    '',
    '  float validLine = step(0.9999, dot(s0, s1));',
    '',
    '  float clip0 = dot(vec4(s0, 1.0), u_clipping_plane);',
    '  float clip1 = dot(vec4(s1, 1.0), u_clipping_plane);',
    '  float bothVisible = step(0.05, clip0) * step(0.05, clip1);',
    '',
    '  // Sample wind at current position for speed-based coloring',
    '  vec2 windVal = texture2D(u_wind, pos1).rg;',
    '  vec2 velocity = mix(u_wind_min, u_wind_max, windVal);',
    '  float spd = length(velocity);',
    '  v_speed = clamp((spd - u_speed_range.x) / (u_speed_range.y - u_speed_range.x), 0.0, 1.0);',
    '',
    '  gl_Position = u_matrix * vec4(sphere, 1.0);',
    '  v_alpha = bothVisible * validLine;',
    '}',
  ].join('\n');

  // Draw fragment shader — samples color ramp by speed
  var DRAW_FRAG = [
    'precision highp float;',
    'uniform sampler2D u_color_ramp;',
    'uniform float u_opacity;',
    'varying float v_alpha;',
    'varying float v_speed;',
    'void main() {',
    '  if (v_alpha < 0.01) discard;',
    '  vec3 color = texture2D(u_color_ramp, vec2(v_speed, 0.5)).rgb;',
    '  gl_FragColor = vec4(color, u_opacity * v_alpha);',
    '}',
  ].join('\n');

  // Particle update fragment shader
  var UPDATE_FRAG = [
    'precision highp float;',
    'uniform sampler2D u_particles;',
    'uniform sampler2D u_wind;',
    'uniform vec2 u_wind_min;',
    'uniform vec2 u_wind_max;',
    'uniform vec2 u_wind_res;',
    'uniform float u_speed_factor;',
    'uniform float u_drop_rate;',
    'uniform float u_drop_rate_bump;',
    'uniform float u_rand_seed;',
    'varying vec2 v_tex_pos;',
    '',
    'const float PI = 3.141592653589793;',
    '',
    'float rand(vec2 co) {',
    '  return fract(sin(dot(co + u_rand_seed, vec2(12.9898, 78.233))) * 43758.5453);',
    '}',
    '',
    'vec2 lookup_wind(vec2 uv) {',
    '  vec2 px = 1.0 / u_wind_res;',
    '  vec2 vc = floor(uv * u_wind_res) * px;',
    '  vec2 f = fract(uv * u_wind_res);',
    '  vec2 tl = texture2D(u_wind, vc).rg;',
    '  vec2 tr = texture2D(u_wind, vc + vec2(px.x, 0)).rg;',
    '  vec2 bl = texture2D(u_wind, vc + vec2(0, px.y)).rg;',
    '  vec2 br = texture2D(u_wind, vc + px).rg;',
    '  return mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);',
    '}',
    '',
    'void main() {',
    '  vec4 color = texture2D(u_particles, v_tex_pos);',
    '  vec2 pos = vec2(color.r / 255.0 + color.b, color.g / 255.0 + color.a);',
    '',
    '  vec2 wind = lookup_wind(pos);',
    '  vec2 velocity = mix(u_wind_min, u_wind_max, wind);',
    '  float speed = length(velocity) / length(u_wind_max);',
    '',
    '  float lat = (1.0 - pos.y) * PI - PI * 0.5;',
    '  float distortion = cos(lat);',
    '  vec2 offset = vec2(velocity.x / max(distortion, 0.05), -velocity.y)',
    '                * 0.0001 * u_speed_factor;',
    '',
    '  // Clamp max displacement to prevent polar speed-of-light artifacts',
    '  float maxStep = 0.0005 * u_speed_factor;',
    '  float stepLen = length(offset);',
    '  offset *= min(1.0, maxStep / max(stepLen, 1e-8));',
    '',
    '  pos = fract(1.0 + pos + offset);',
    '',
    '  vec2 seed = (v_tex_pos + pos) * u_rand_seed;',
    '  float drop = u_drop_rate + speed * u_drop_rate_bump;',
    '  float doReset = step(1.0 - drop, rand(seed));',
    '  vec2 random_pos = vec2(rand(seed + 1.3), rand(seed + 2.1));',
    '  pos = mix(pos, random_pos, doReset);',
    '',
    '  gl_FragColor = vec4(fract(pos * 255.0), floor(pos * 255.0) / 255.0);',
    '}',
  ].join('\n');

  // ── GL helpers ─────────────────────────────────────────────────────

  function compileShader(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  function createProgram(gl, vertSrc, fragSrc, attribs) {
    var vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
    var fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) return null;
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(prog));
      return null;
    }
    var result = { program: prog };
    var n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var info = gl.getActiveUniform(prog, i);
      result[info.name] = gl.getUniformLocation(prog, info.name);
    }
    if (attribs) {
      for (var j = 0; j < attribs.length; j++) {
        result[attribs[j]] = gl.getAttribLocation(prog, attribs[j]);
      }
    }
    return result;
  }

  function createTexture(gl, filter, data, w, h) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    if (data instanceof Uint8Array) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  function bindTexture(gl, tex, unit) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  // ── Color ramp texture ─────────────────────────────────────────────

  function buildColorRampPixels(stops, speedRange) {
    var pixels = new Uint8Array(256 * 4);
    var sMin = speedRange[0], sMax = speedRange[1];

    for (var i = 0; i < 256; i++) {
      var speed = sMin + (i / 255) * (sMax - sMin);
      var r = 0, g = 0, b = 0;

      if (speed <= stops[0][0]) {
        r = stops[0][1]; g = stops[0][2]; b = stops[0][3];
      } else if (speed >= stops[stops.length - 1][0]) {
        var last = stops[stops.length - 1];
        r = last[1]; g = last[2]; b = last[3];
      } else {
        for (var j = 0; j < stops.length - 1; j++) {
          if (speed >= stops[j][0] && speed < stops[j + 1][0]) {
            var t = (speed - stops[j][0]) / (stops[j + 1][0] - stops[j][0]);
            r = stops[j][1] + t * (stops[j + 1][1] - stops[j][1]);
            g = stops[j][2] + t * (stops[j + 1][2] - stops[j][2]);
            b = stops[j][3] + t * (stops[j + 1][3] - stops[j][3]);
            break;
          }
        }
      }

      pixels[i * 4 + 0] = Math.round(r * 255);
      pixels[i * 4 + 1] = Math.round(g * 255);
      pixels[i * 4 + 2] = Math.round(b * 255);
      pixels[i * 4 + 3] = 255;
    }
    return pixels;
  }

  function solidColorPixels(rgb) {
    var pixels = new Uint8Array(256 * 4);
    var r = Math.round(rgb[0] * 255);
    var g = Math.round(rgb[1] * 255);
    var b = Math.round(rgb[2] * 255);
    for (var i = 0; i < 256; i++) {
      pixels[i * 4 + 0] = r;
      pixels[i * 4 + 1] = g;
      pixels[i * 4 + 2] = b;
      pixels[i * 4 + 3] = 255;
    }
    return pixels;
  }

  // ── Wind data → texture ────────────────────────────────────────────

  function windDataToTexture(gl, json) {
    var uObj = json[0], vObj = json[1];
    var nx = uObj.header.nx;
    var ny = uObj.header.ny;
    var uData = uObj.data;
    var vData = vObj.data;

    var uMin = Infinity, uMax = -Infinity;
    var vMin = Infinity, vMax = -Infinity;
    for (var i = 0; i < uData.length; i++) {
      if (uData[i] < uMin) uMin = uData[i];
      if (uData[i] > uMax) uMax = uData[i];
      if (vData[i] < vMin) vMin = vData[i];
      if (vData[i] > vMax) vMax = vData[i];
    }

    var pixels = new Uint8Array(nx * ny * 4);
    for (var j = 0; j < uData.length; j++) {
      var k = j * 4;
      pixels[k + 0] = Math.round(255 * (uData[j] - uMin) / (uMax - uMin || 1));
      pixels[k + 1] = Math.round(255 * (vData[j] - vMin) / (vMax - vMin || 1));
      pixels[k + 2] = 0;
      pixels[k + 3] = 255;
    }

    var tex = createTexture(gl, gl.LINEAR, pixels, nx, ny);
    return {
      texture: tex,
      width: nx, height: ny,
      uMin: uMin, uMax: uMax,
      vMin: vMin, vMax: vMax,
    };
  }

  // ── Random particle state ──────────────────────────────────────────

  function randomParticleState(count) {
    var data = new Uint8Array(count * 4);
    for (var i = 0; i < count * 4; i++) {
      data[i] = Math.floor(Math.random() * 256);
    }
    return data;
  }

  // ── GL state save/restore ──────────────────────────────────────────

  function saveGLState(gl) {
    return {
      framebuffer: gl.getParameter(gl.FRAMEBUFFER_BINDING),
      viewport: gl.getParameter(gl.VIEWPORT),
      blend: gl.isEnabled(gl.BLEND),
      blendSrcRGB: gl.getParameter(gl.BLEND_SRC_RGB),
      blendDstRGB: gl.getParameter(gl.BLEND_DST_RGB),
      blendSrcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA),
      blendDstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA),
      depthTest: gl.isEnabled(gl.DEPTH_TEST),
      depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
      activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE),
    };
  }

  function restoreGLState(gl, s) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.framebuffer);
    gl.viewport(s.viewport[0], s.viewport[1], s.viewport[2], s.viewport[3]);
    if (s.blend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
    gl.blendFuncSeparate(s.blendSrcRGB, s.blendDstRGB, s.blendSrcAlpha, s.blendDstAlpha);
    if (s.depthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
    gl.depthMask(s.depthMask);
    gl.activeTexture(s.activeTexture);
  }

  // ── Main class (MapLibre CustomLayerInterface) ─────────────────────

  function MaplibreWindGL(id, options) {
    var o = options || {};
    this.id = id;
    this.type = 'custom';
    this.renderingMode = '2d';

    this._dataUrl = o.data || null;
    this._numParticles = o.particles || DEFAULT_PARTICLES;
    this._speedFactor = o.speed !== undefined ? o.speed : DEFAULT_SPEED;
    this._maxAge = o.maxAge || DEFAULT_MAX_AGE;
    this._dropRate = o.dropRate || DEFAULT_DROP_RATE;
    this._dropRateBump = o.dropRateBump || DEFAULT_DROP_BUMP;
    this._opacity = o.opacity !== undefined ? o.opacity : 0.4;
    this._speedRange = o.speedRange || DEFAULT_SPEED_RANGE;

    // Color: either a ramp (speed-based) or a flat color
    this._colorRampStops = o.colorRamp !== undefined ? o.colorRamp : DEFAULT_COLOR_RAMP;
    this._color = o.color || null;  // flat color fallback (null = use ramp)

    this._gl = null;
    this._map = null;
    this._wind = null;
    this._ready = false;

    this._drawProg = null;
    this._updateProg = null;
    this._quadBuf = null;
    this._indexBuf = null;
    this._particleRes = Math.ceil(Math.sqrt(this._numParticles));
    this._stateTextures = [];
    this._writeIndex = 0;
    this._filledFrames = 0;
    this._particleFBO = null;
    this._colorRampTexture = null;
  }

  // ── Internal helpers ───────────────────────────────────────────────

  MaplibreWindGL.prototype._createStateTextures = function() {
    var gl = this._gl;
    var res = this._particleRes;
    var numSlots = this._maxAge + 1;
    var initState = randomParticleState(res * res);
    this._stateTextures = [];
    for (var i = 0; i < numSlots; i++) {
      this._stateTextures.push(createTexture(gl, gl.NEAREST, initState, res, res));
    }
    this._writeIndex = 0;
    this._filledFrames = 0;
  };

  MaplibreWindGL.prototype._destroyStateTextures = function() {
    var gl = this._gl;
    for (var i = 0; i < this._stateTextures.length; i++) {
      gl.deleteTexture(this._stateTextures[i]);
    }
    this._stateTextures = [];
  };

  MaplibreWindGL.prototype._rebuildColorRamp = function() {
    var gl = this._gl;
    if (!gl) return;
    if (this._colorRampTexture) gl.deleteTexture(this._colorRampTexture);

    var pixels;
    if (this._colorRampStops) {
      pixels = buildColorRampPixels(this._colorRampStops, this._speedRange);
    } else if (this._color) {
      pixels = solidColorPixels(this._color);
    } else {
      pixels = solidColorPixels([1, 1, 1]);
    }
    this._colorRampTexture = createTexture(gl, gl.LINEAR, pixels, 256, 1);
  };

  // ── CustomLayerInterface methods ───────────────────────────────────

  MaplibreWindGL.prototype.onAdd = function(map, gl) {
    this._map = map;
    this._gl = gl;

    this._drawProg = createProgram(gl, DRAW_VERT, DRAW_FRAG, ['a_index']);
    this._updateProg = createProgram(gl, QUAD_VERT, UPDATE_FRAG, ['a_pos']);

    if (!this._drawProg || !this._updateProg) {
      console.error('MaplibreWindGL: shader compilation failed');
      return;
    }

    // Fullscreen quad buffer
    this._quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 0,1, 0,1, 1,0, 1,1]), gl.STATIC_DRAW);

    // Particle index buffer
    var numParticles = this._particleRes * this._particleRes;
    var indices = new Float32Array(numParticles * 2);
    for (var i = 0; i < numParticles; i++) {
      indices[i * 2] = i;
      indices[i * 2 + 1] = i + 0.5;
    }
    this._indexBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._indexBuf);
    gl.bufferData(gl.ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    // State textures and color ramp
    this._particleFBO = gl.createFramebuffer();
    this._createStateTextures();
    this._rebuildColorRamp();

    if (this._dataUrl) this.setData(this._dataUrl);
  };

  MaplibreWindGL.prototype.onRemove = function() {
    var gl = this._gl;
    if (!gl) return;
    if (this._drawProg) gl.deleteProgram(this._drawProg.program);
    if (this._updateProg) gl.deleteProgram(this._updateProg.program);
    if (this._quadBuf) gl.deleteBuffer(this._quadBuf);
    if (this._indexBuf) gl.deleteBuffer(this._indexBuf);
    this._destroyStateTextures();
    if (this._particleFBO) gl.deleteFramebuffer(this._particleFBO);
    if (this._colorRampTexture) gl.deleteTexture(this._colorRampTexture);
    if (this._wind) gl.deleteTexture(this._wind.texture);
    this._gl = null;
    this._map = null;
  };

  // prerender: advect particle positions
  MaplibreWindGL.prototype.prerender = function(gl, args) {
    if (!this._ready || !this._wind) return;

    var saved = saveGLState(gl);
    var len = this._stateTextures.length;
    var readIdx = (this._writeIndex - 1 + len) % len;
    var writeIdx = this._writeIndex;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._particleFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D, this._stateTextures[writeIdx], 0);
    gl.viewport(0, 0, this._particleRes, this._particleRes);

    var up = this._updateProg;
    gl.useProgram(up.program);

    bindTexture(gl, this._stateTextures[readIdx], 0);
    gl.uniform1i(up.u_particles, 0);

    bindTexture(gl, this._wind.texture, 1);
    gl.uniform1i(up.u_wind, 1);
    gl.uniform2f(up.u_wind_min, this._wind.uMin, this._wind.vMin);
    gl.uniform2f(up.u_wind_max, this._wind.uMax, this._wind.vMax);
    gl.uniform2f(up.u_wind_res, this._wind.width, this._wind.height);

    gl.uniform1f(up.u_speed_factor, this._speedFactor);
    gl.uniform1f(up.u_drop_rate, this._dropRate);
    gl.uniform1f(up.u_drop_rate_bump, this._dropRateBump);
    gl.uniform1f(up.u_rand_seed, Math.random());

    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
    gl.enableVertexAttribArray(up.a_pos);
    gl.vertexAttribPointer(up.a_pos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(up.a_pos);

    this._writeIndex = (writeIdx + 1) % len;
    if (this._filledFrames < this._maxAge) this._filledFrames++;

    restoreGLState(gl, saved);
  };

  // render: draw trail segments oldest → newest with fading alpha
  MaplibreWindGL.prototype.render = function(gl, args) {
    if (!this._ready || !this._wind) return;
    if (this._filledFrames < 1) return;

    var saved = saveGLState(gl);
    var matrix = args.defaultProjectionData.mainMatrix;
    var clippingPlane = args.defaultProjectionData.clippingPlane;
    var len = this._stateTextures.length;
    var newestIdx = (this._writeIndex - 1 + len) % len;

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    var dp = this._drawProg;
    gl.useProgram(dp.program);

    gl.uniform1f(dp.u_particles_res, this._particleRes);
    gl.uniformMatrix4fv(dp.u_matrix, false, matrix);
    gl.uniform4fv(dp.u_clipping_plane, clippingPlane);
    gl.uniform2f(dp.u_speed_range, this._speedRange[0], this._speedRange[1]);

    // Bind wind texture (unit 2) and color ramp (unit 3) — shared across all age draws
    bindTexture(gl, this._wind.texture, 2);
    gl.uniform1i(dp.u_wind, 2);
    gl.uniform2f(dp.u_wind_min, this._wind.uMin, this._wind.vMin);
    gl.uniform2f(dp.u_wind_max, this._wind.uMax, this._wind.vMax);

    bindTexture(gl, this._colorRampTexture, 3);
    gl.uniform1i(dp.u_color_ramp, 3);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._indexBuf);
    gl.enableVertexAttribArray(dp.a_index);
    gl.vertexAttribPointer(dp.a_index, 1, gl.FLOAT, false, 0, 0);

    var numSegments = Math.min(this._filledFrames, this._maxAge);
    var vertexCount = this._particleRes * this._particleRes * 2;

    for (var age = numSegments - 1; age >= 0; age--) {
      var currIdx = (newestIdx - age + len) % len;
      var prevIdx = (newestIdx - age - 1 + len) % len;
      var ageFactor = 1.0 - age / this._maxAge;

      bindTexture(gl, this._stateTextures[prevIdx], 0);
      gl.uniform1i(dp.u_particles_prev, 0);
      bindTexture(gl, this._stateTextures[currIdx], 1);
      gl.uniform1i(dp.u_particles_curr, 1);
      gl.uniform1f(dp.u_opacity, ageFactor * this._opacity);

      gl.drawArrays(gl.LINES, 0, vertexCount);
    }

    gl.disableVertexAttribArray(dp.a_index);

    restoreGLState(gl, saved);
    this._map.triggerRepaint();
  };

  // ── Public API ─────────────────────────────────────────────────────

  MaplibreWindGL.prototype.setData = function(url) {
    var self = this;
    this._dataUrl = url;
    return fetch(url)
      .then(function(r) { return r.json(); })
      .then(function(json) {
        if (!self._gl) return;
        if (self._wind) self._gl.deleteTexture(self._wind.texture);
        self._wind = windDataToTexture(self._gl, json);
        self._ready = true;
        if (self._map) self._map.triggerRepaint();
      });
  };

  MaplibreWindGL.prototype.setSpeed = function(s) {
    this._speedFactor = s;
  };

  MaplibreWindGL.prototype.setMaxAge = function(n) {
    this._maxAge = Math.max(1, Math.round(n));
    if (this._gl) {
      this._destroyStateTextures();
      this._createStateTextures();
    }
  };

  MaplibreWindGL.prototype.setOpacity = function(o) {
    this._opacity = o;
  };

  MaplibreWindGL.prototype.setColorRamp = function(stops) {
    this._colorRampStops = stops;
    this._color = null;
    this._rebuildColorRamp();
  };

  MaplibreWindGL.prototype.setColor = function(rgb) {
    this._color = rgb;
    this._colorRampStops = null;
    this._rebuildColorRamp();
  };

  MaplibreWindGL.prototype.setSpeedRange = function(range) {
    this._speedRange = range;
    this._rebuildColorRamp();
  };

  // ── Export ─────────────────────────────────────────────────────────

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MaplibreWindGL;
  } else {
    global.MaplibreWindGL = MaplibreWindGL;
  }

})(typeof window !== 'undefined' ? window : this);
