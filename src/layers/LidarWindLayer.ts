import type { MutableRefObject } from 'react'
import mapboxgl from 'mapbox-gl'
import type { LidarDataset, LidarSample } from '@/utils/lidarCsvParser'
import { polarToMercator, polarGateCellCorners } from '@/utils/lidarCsvParser'
import { BARB_QUAD_FLOATS, buildBarbQuadBuffer, createWindBarbAtlas } from '@/utils/windBarb'

export interface LidarWindLayerOptions {
  id?: string
  dataset: LidarDataset
  showPoints?: boolean
  showSurface?: boolean
  showWindBarbs?: boolean
  showScanBeam?: boolean
  showRangeRings?: boolean
  pointSize?: number
  pointOpacity?: number
  surfaceOpacity?: number
  interpolateSurface?: boolean
  barbScale?: number
  scanSpeed?: number
  beamOpacity?: number
  heightExaggeration?: number
  colorMode?: 'speed' | 'direction'
}

interface LayerParams {
  showPoints: boolean
  showSurface: boolean
  showWindBarbs: boolean
  showScanBeam: boolean
  showRangeRings: boolean
  pointSize: number
  pointOpacity: number
  surfaceOpacity: number
  interpolateSurface: boolean
  barbScale: number
  scanSpeed: number
  beamOpacity: number
  heightExaggeration: number
  colorMode: 'speed' | 'direction'
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader compile:', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

function linkProgram(gl: WebGLRenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram | null {
  const prog = gl.createProgram()!
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('Program link:', gl.getProgramInfoLog(prog))
    return null
  }
  return prog
}

const POINT_VS = `
  attribute vec3 a_pos;
  attribute float a_speed;
  attribute float a_direction;
  attribute float a_valid;

  uniform mat4 u_matrix;
  uniform float u_time;
  uniform float u_pointSize;
  uniform float u_speedMin;
  uniform float u_speedMax;
  uniform float u_heightExaggeration;
  uniform vec3 u_origin;
  uniform float u_colorMode;

  varying vec3 v_color;
  varying float v_alpha;
  varying float v_pulse;

  vec3 speedColor(float t) {
    t = clamp(t, 0.0, 1.0);
    if (t < 0.25) {
      float s = t / 0.25;
      return vec3(0.05, 0.1 + s * 0.6, 0.5 + s * 0.5);
    }
    if (t < 0.5) {
      float s = (t - 0.25) / 0.25;
      return vec3(0.0, 0.7 + s * 0.3, 1.0 - s * 0.3);
    }
    if (t < 0.75) {
      float s = (t - 0.5) / 0.25;
      return vec3(s, 1.0 - s * 0.2, 0.7 - s * 0.5);
    }
    float s = (t - 0.75) / 0.25;
    return vec3(1.0, 0.8 - s * 0.6, 0.2 - s * 0.2);
  }

  vec3 dirColor(float deg) {
    float hue = mod(deg, 360.0) / 360.0;
    float h = hue * 6.0;
    float c = 0.95;
    float x = c * (1.0 - abs(mod(h, 2.0) - 1.0));
    if (h < 1.0) return vec3(c, x, 0.0);
    if (h < 2.0) return vec3(x, c, 0.0);
    if (h < 3.0) return vec3(0.0, c, x);
    if (h < 4.0) return vec3(0.0, x, c);
    if (h < 5.0) return vec3(x, 0.0, c);
    return vec3(c, 0.0, x);
  }

  void main() {
    vec3 pos = a_pos;
    pos.z = u_origin.z + (a_pos.z - u_origin.z) * u_heightExaggeration;

    gl_Position = u_matrix * vec4(pos, 1.0);

    float speedNorm = (a_speed - u_speedMin) / max(u_speedMax - u_speedMin, 0.001);
    v_color = u_colorMode > 0.5 ? dirColor(a_direction) : speedColor(speedNorm);

    v_pulse = 0.75 + 0.25 * sin(u_time * 3.0 + a_pos.x * 5000.0 + a_pos.y * 5000.0);
    v_alpha = a_valid * (0.6 + speedNorm * 0.4);

    float sizeBoost = 1.0 + speedNorm * 2.0;
    gl_PointSize = u_pointSize * sizeBoost * v_pulse;
  }
`

const POINT_FS = `
  precision highp float;
  varying vec3 v_color;
  varying float v_alpha;
  varying float v_pulse;

  void main() {
    vec2 c = gl_PointCoord - vec2(0.5);
    float dist = length(c);
    if (dist > 0.5) discard;

    float core = 1.0 - smoothstep(0.0, 0.15, dist);
    float glow = 1.0 - smoothstep(0.0, 0.5, dist);
    glow = pow(glow, 2.0);

    vec3 color = v_color * (core * 1.5 + glow * 0.8);
    float alpha = (core * 0.95 + glow * 0.5) * v_alpha * v_pulse;

    gl_FragColor = vec4(color, alpha);
  }
`

const LINE_VS = `
  attribute vec3 a_start;
  attribute vec3 a_delta;
  uniform mat4 u_matrix;
  uniform vec3 u_origin;
  uniform float u_heightExaggeration;
  uniform float u_vectorScale;

  void main() {
    vec3 start = a_start;
    start.z = u_origin.z + (a_start.z - u_origin.z) * u_heightExaggeration;
    vec3 delta = a_delta * u_vectorScale;
    delta.z *= u_heightExaggeration;
    vec3 pos = start + delta;
    gl_Position = u_matrix * vec4(pos, 1.0);
  }
`

const LINE_FS = `
  precision mediump float;
  uniform vec4 u_color;
  void main() {
    gl_FragColor = u_color;
  }
`

const SURFACE_VS = `
  attribute vec3 a_pos;
  attribute float a_speed;
  attribute float a_azimuth;

  uniform mat4 u_matrix;
  uniform float u_speedMin;
  uniform float u_speedMax;
  uniform vec3 u_origin;
  uniform float u_heightExaggeration;

  varying vec3 v_color;
  varying float v_height;
  varying float v_azimuth;

  vec3 speedColor(float t) {
    t = clamp(t, 0.0, 1.0);
    if (t < 0.25) return mix(vec3(0.02,0.08,0.25), vec3(0.0,0.5,0.9), t/0.25);
    if (t < 0.5) return mix(vec3(0.0,0.5,0.9), vec3(0.0,0.95,0.7), (t-0.25)/0.25);
    if (t < 0.75) return mix(vec3(0.0,0.95,0.7), vec3(1.0,0.85,0.1), (t-0.5)/0.25);
    return mix(vec3(1.0,0.85,0.1), vec3(1.0,0.2,0.05), (t-0.75)/0.25);
  }

  void main() {
    vec3 pos = a_pos;
    pos.z = u_origin.z + (a_pos.z - u_origin.z) * u_heightExaggeration;
    v_height = (pos.z - u_origin.z);
    v_azimuth = a_azimuth;
    float speedNorm = (a_speed - u_speedMin) / max(u_speedMax - u_speedMin, 0.001);
    v_color = speedColor(speedNorm);
    gl_Position = u_matrix * vec4(pos, 1.0);
  }
`

const SURFACE_FS = `
  precision mediump float;
  varying vec3 v_color;
  varying float v_height;
  varying float v_azimuth;
  uniform float u_opacity;
  uniform float u_time;
  uniform float u_scanAzimuthDeg;
  uniform float u_scanTrailDeg;

  float wrapAngleDiff(float a, float b) {
    float d = a - b;
    return abs(mod(d + 180.0, 360.0) - 180.0);
  }

  void main() {
    float shimmer = 0.85 + 0.15 * sin(u_time * 2.0 + v_height * 80.0);
    vec3 color = v_color * shimmer;
    float alpha = u_opacity;

    float angleDiff = wrapAngleDiff(v_azimuth, u_scanAzimuthDeg);
    if (angleDiff < u_scanTrailDeg) {
      float trail = 1.0 - angleDiff / max(u_scanTrailDeg, 0.001);
      trail = pow(trail, 1.8);
      color += vec3(0.0, 0.85, 1.0) * trail * 0.55;
      alpha = min(1.0, alpha + trail * 0.25);
    }

    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  }
`

const BEAM_VS = `
  attribute vec3 a_attr;
  uniform mat4 u_matrix;
  uniform float u_scanAngleRad;
  uniform float u_pitchRad;
  uniform vec3 u_origin;
  uniform float u_meterScale;
  uniform float u_maxDistMeters;
  uniform float u_heightExaggeration;

  varying float v_radial;
  varying float v_angularOff;
  varying float v_layer;

  void main() {
    float dist = a_attr.x * u_maxDistMeters;
    float az = u_scanAngleRad + a_attr.y * 0.01745329252;
    float horiz = dist * cos(u_pitchRad);
    float up = dist * sin(u_pitchRad);
    float east = horiz * sin(az);
    float north = horiz * cos(az);

    vec3 worldPos = vec3(
      u_origin.x + east * u_meterScale,
      u_origin.y - north * u_meterScale,
      u_origin.z + up * u_meterScale * u_heightExaggeration
    );

    v_radial = a_attr.x;
    v_angularOff = a_attr.y;
    v_layer = a_attr.z;
    gl_Position = u_matrix * vec4(worldPos, 1.0);
  }
`

const BEAM_FS = `
  precision highp float;
  uniform float u_opacity;
  uniform float u_time;
  varying float v_radial;
  varying float v_angularOff;
  varying float v_layer;

  void main() {
    float trail = 1.0 - step(0.25, v_layer);
    float bloom = step(0.25, v_layer) * (1.0 - step(0.75, v_layer));
    float core = step(0.75, v_layer);

    float angSpan = mix(mix(32.0, 5.0, bloom), 0.72, core);
    float ang = 1.0 - abs(v_angularOff) / max(angSpan, 0.001);
    ang = clamp(ang, 0.0, 1.0);
    ang = pow(ang, mix(mix(1.15, 2.4, bloom), 5.5, core));

    float wake = 1.0 - smoothstep(-26.0, 1.2, v_angularOff);
    wake = pow(clamp(wake, 0.0, 1.0), 1.4);

    float originGlow = exp(-v_radial * 7.5);
    float radial = 1.0 - pow(v_radial, 1.35) * 0.28;
    float t = u_time;

    float chirp = sin(v_radial * 48.0 - t * 16.0) * 0.5 + 0.5;
    chirp = pow(chirp, 5.0);
    float packet = 1.0 - abs(fract(v_radial * 2.6 - t * 0.95) - 0.5) * 2.0;
    packet = pow(clamp(packet, 0.0, 1.0), 12.0);
    float gates = 1.0 - smoothstep(0.0, 0.035, abs(fract(v_radial * 14.0 - t * 0.2) - 0.5));
    float scanline = 0.72 + 0.28 * sin(v_radial * 110.0 + t * 3.0);
    float rail = 1.0 - smoothstep(0.0, 0.09, abs(abs(v_angularOff) - 0.38));
    float heartbeat = 0.86 + 0.14 * sin(t * 7.5);

    vec3 deep = vec3(0.0, 0.08, 0.38);
    vec3 cyan = vec3(0.0, 0.42, 1.0);
    vec3 ice = vec3(0.15, 0.55, 1.0);
    vec3 mint = vec3(0.0, 0.55, 0.85);
    vec3 hot = vec3(0.12, 0.62, 1.0);

    vec3 color = mix(deep, cyan, ang);
    color = mix(color, mint, v_radial * 0.25 * (bloom + core));
    color += ice * originGlow * 0.85;
    color += hot * (chirp * 0.4 + packet * 0.75) * mix(0.1, 0.85, core + bloom * 0.4);
    color += cyan * gates * mix(0.12, 0.4, core);
    color += ice * rail * core * 0.55;
    color += vec3(0.05, 0.28, 0.85) * wake * trail * 0.55;
    color *= scanline;

    float alpha = ang * radial * u_opacity;
    alpha *= mix(mix(0.72, 0.9, bloom), 1.0, core);
    alpha *= mix(wake, 1.0, core + bloom);
    alpha *= heartbeat;
    alpha += packet * mix(0.12, 0.4, core);
    alpha += originGlow * mix(0.2, 0.45, core);
    alpha += gates * core * 0.16;
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  }
`

const BEAM_LINE_VS = `
  attribute vec3 a_attr;
  uniform mat4 u_matrix;
  uniform float u_scanAngleRad;
  uniform float u_pitchRad;
  uniform vec3 u_origin;
  uniform float u_meterScale;
  uniform float u_maxDistMeters;
  uniform float u_heightExaggeration;
  varying float v_t;

  void main() {
    float dist = a_attr.x * u_maxDistMeters;
    float az = u_scanAngleRad + a_attr.y * 0.01745329252;
    float horiz = dist * cos(u_pitchRad);
    float up = dist * sin(u_pitchRad);
    float east = horiz * sin(az);
    float north = horiz * cos(az);
    vec3 worldPos = vec3(
      u_origin.x + east * u_meterScale,
      u_origin.y - north * u_meterScale,
      u_origin.z + up * u_meterScale * u_heightExaggeration
    );
    v_t = a_attr.x;
    gl_Position = u_matrix * vec4(worldPos, 1.0);
  }
`

const BEAM_LINE_FS = `
  precision mediump float;
  uniform float u_time;
  uniform float u_opacity;
  varying float v_t;

  void main() {
    float dash = step(0.38, fract(v_t * 28.0 - u_time * 10.0));
    float packet = 1.0 - abs(fract(v_t * 3.2 - u_time * 1.4) - 0.5) * 2.0;
    packet = pow(clamp(packet, 0.0, 1.0), 8.0);
    float tip = 1.0 - smoothstep(0.86, 1.0, v_t);
    float root = exp(-v_t * 8.0);
    float pulse = 0.55 + 0.45 * sin(u_time * 18.0 - v_t * 55.0);
    vec3 color = mix(vec3(0.0, 0.32, 0.95), vec3(0.25, 0.65, 1.0), tip);
    color += vec3(0.0, 0.45, 1.0) * packet;
    color += vec3(0.15, 0.4, 1.0) * root * 0.5;
    float alpha = (0.22 + dash * 0.55 + packet * 0.5 + tip * 0.55 + root * 0.3) * pulse * u_opacity;
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  }
`

const BARB_VS = `
  attribute vec3 a_center;
  attribute vec3 a_right;
  attribute vec3 a_staff;
  attribute vec3 a_normal;
  attribute vec2 a_corner;
  attribute float a_bin;

  uniform mat4 u_matrix;
  uniform vec3 u_origin;
  uniform float u_heightExaggeration;
  uniform float u_halfSize;
  uniform float u_lift;

  varying vec2 v_uv;
  varying float v_bin;

  void main() {
    vec3 pos = a_center + (a_right * a_corner.x + a_staff * a_corner.y) * u_halfSize;
    pos += a_normal * u_lift;
    pos.z = u_origin.z + (pos.z - u_origin.z) * u_heightExaggeration;
    gl_Position = u_matrix * vec4(pos, 1.0);
    v_uv = vec2(a_corner.x * 0.5 + 0.5, 0.5 - a_corner.y * 0.5);
    v_bin = a_bin;
  }
`

const BARB_FS = `
  precision highp float;

  uniform sampler2D u_atlas;
  uniform float u_cols;
  uniform float u_rows;

  varying vec2 v_uv;
  varying float v_bin;

  void main() {
    float col = mod(v_bin, u_cols);
    float row = floor(v_bin / u_cols);
    vec2 atlasUV = vec2((col + v_uv.x) / u_cols, (row + v_uv.y) / u_rows);
    vec4 color = texture2D(u_atlas, atlasUV);
    if (color.a < 0.1) discard;
    gl_FragColor = color;
  }
`

function buildPointBuffer(samples: LidarSample[]) {
  const data = new Float32Array(samples.length * 6)
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!
    data[i * 6] = s.x
    data[i * 6 + 1] = s.y
    data[i * 6 + 2] = s.z
    data[i * 6 + 3] = s.hWindSpeed ?? 0
    data[i * 6 + 4] = s.hWindDirection ?? 0
    data[i * 6 + 5] = s.hWindSpeed !== null ? 1 : 0.15
  }
  return data
}

function buildSurfaceMesh(
  dataset: LidarDataset,
  interpolate: boolean,
): { vertices: Float32Array; indices: Uint32Array } {
  const { samples, azimuths, metadata } = dataset
  const byAzimuth = new Map<number, LidarSample[]>()
  for (const s of samples) {
    if (!byAzimuth.has(s.azimuth)) byAzimuth.set(s.azimuth, [])
    byAzimuth.get(s.azimuth)!.push(s)
  }
  for (const arr of byAzimuth.values()) {
    arr.sort((a, b) => a.distance - b.distance)
  }

  const vertices: number[] = []
  const indices: number[] = []

  function pushVertex(
    x: number,
    y: number,
    z: number,
    speed: number,
    azimuth: number,
  ): number {
    const idx = vertices.length / 5
    vertices.push(x, y, z, speed, azimuth)
    return idx
  }

  // 离散：每个探测点是距离门格心，四边形覆盖该格子，四顶点同值
  // 插值：只在相邻格心之间连网，GPU 做线性过渡
  if (!interpolate) {
    for (const s of samples) {
      if (s.hWindSpeed === null) continue
      const [a, b, c, d] = polarGateCellCorners(metadata, s.azimuth, s.pitch, s.distance)
      const i0 = pushVertex(a[0], a[1], a[2], s.hWindSpeed, s.azimuth)
      const i1 = pushVertex(b[0], b[1], b[2], s.hWindSpeed, s.azimuth)
      const i2 = pushVertex(c[0], c[1], c[2], s.hWindSpeed, s.azimuth)
      const i3 = pushVertex(d[0], d[1], d[2], s.hWindSpeed, s.azimuth)
      indices.push(i0, i2, i1, i1, i2, i3)
    }
    return {
      vertices: new Float32Array(vertices),
      indices: new Uint32Array(indices),
    }
  }

  const indexMap = new Map<string, number>()
  function addCenterVertex(s: LidarSample): number {
    const key = `${s.azimuth}_${s.distance}`
    const existing = indexMap.get(key)
    if (existing !== undefined) return existing
    const idx = pushVertex(s.x, s.y, s.z, s.hWindSpeed ?? 0, s.azimuth)
    indexMap.set(key, idx)
    return idx
  }

  for (let ai = 0; ai < azimuths.length - 1; ai++) {
    const az0 = azimuths[ai]!
    const az1 = azimuths[ai + 1]!
    const ray0 = byAzimuth.get(az0) ?? []
    const ray1 = byAzimuth.get(az1) ?? []
    const len = Math.min(ray0.length, ray1.length)

    for (let di = 0; di < len - 1; di++) {
      const a = ray0[di]!
      const b = ray0[di + 1]!
      const c = ray1[di]!
      const d = ray1[di + 1]!
      if (
        a.hWindSpeed === null ||
        b.hWindSpeed === null ||
        c.hWindSpeed === null ||
        d.hWindSpeed === null
      ) {
        continue
      }
      const i0 = addCenterVertex(a)
      const i1 = addCenterVertex(b)
      const i2 = addCenterVertex(c)
      const i3 = addCenterVertex(d)
      indices.push(i0, i2, i1, i1, i2, i3)
    }
  }

  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices),
  }
}

function buildRangeRings(dataset: LidarDataset): Float32Array {
  const { metadata, maxValidDistance } = dataset
  const { longitude, latitude, seaHeight, fixAngle, rangeResolution } = metadata
  const halfRange = rangeResolution / 2
  const segments: number[] = []

  if (maxValidDistance <= 0) return new Float32Array()

  const outer = maxValidDistance + halfRange
  const ringStep = outer > 1800 ? 500 : 250
  const liftAlt = seaHeight + 4
  const dashM = 80
  const gapM = 55

  const pointAt = (az: number, dist: number) =>
    polarToMercator(longitude, latitude, liftAlt, az, fixAngle, dist)

  const pushLine = (
    a: [number, number, number],
    b: [number, number, number],
  ) => {
    segments.push(a[0], a[1], a[2], 0, 0, 0)
    segments.push(a[0], a[1], a[2], b[0] - a[0], b[1] - a[1], b[2] - a[2])
  }

  const pushDashedRing = (dist: number) => {
    const cycle = dashM + gapM
    const circ = 2 * Math.PI * dist
    let s = 0
    while (s < circ - 1) {
      const dashEnd = Math.min(s + dashM, circ)
      const az0 = (s / dist) * (180 / Math.PI)
      const az1 = (dashEnd / dist) * (180 / Math.PI)
      const span = az1 - az0
      const parts = Math.max(1, Math.ceil(span / 6))
      for (let i = 0; i < parts; i++) {
        const a0 = az0 + (span * i) / parts
        const a1 = az0 + (span * (i + 1)) / parts
        pushLine(pointAt(a0, dist), pointAt(a1, dist))
      }
      s += cycle
    }
  }

  for (let dist = ringStep; dist < outer - 1; dist += ringStep) {
    pushDashedRing(dist)
  }
  pushDashedRing(outer)

  return new Float32Array(segments)
}

function buildPpiScanMeshes(): {
  wedge: { vertices: Float32Array; indices: Uint16Array }
  beamLine: Float32Array
} {
  const R_SEGS = 48
  const vertices: number[] = []
  const indices: number[] = []

  function addWedge(
    radialStart: number,
    radialEnd: number,
    azStart: number,
    azEnd: number,
    layer: number,
    radialSegs: number,
    azSegs: number,
  ) {
    const baseIdx = vertices.length / 3
    for (let ri = 0; ri <= radialSegs; ri++) {
      const r = radialStart + (radialEnd - radialStart) * (ri / radialSegs)
      for (let ai = 0; ai <= azSegs; ai++) {
        const az = azStart + (azEnd - azStart) * (ai / azSegs)
        vertices.push(r, az, layer)
      }
    }
    for (let ri = 0; ri < radialSegs; ri++) {
      for (let ai = 0; ai < azSegs; ai++) {
        const i0 = baseIdx + ri * (azSegs + 1) + ai
        const i1 = i0 + 1
        const i2 = i0 + azSegs + 1
        const i3 = i2 + 1
        indices.push(i0, i2, i1, i1, i2, i3)
      }
    }
  }

  // 宽幅余辉
  addWedge(0, 1, -30, 2.4, 0, R_SEGS, 20)
  // 中层光晕
  addWedge(0, 1, -3.6, 1.4, 0.5, R_SEGS, 10)
  // 核心激光扇
  addWedge(0, 1, -0.5, 0.5, 1, R_SEGS, 6)

  const lineSegs = 72
  const lineVerts: number[] = [0, 0, 1]
  for (let i = 1; i <= lineSegs; i++) {
    lineVerts.push(i / lineSegs, 0, 1)
  }

  return {
    wedge: { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) },
    beamLine: new Float32Array(lineVerts),
  }
}

export function createLidarWindLayer(
  mapRef: MutableRefObject<mapboxgl.Map | null>,
  dataset: LidarDataset,
  paramsRef: MutableRefObject<LayerParams>,
): mapboxgl.CustomLayerInterface {
  const { metadata } = dataset
  const [originX, originY, originZ] = polarToMercator(
    metadata.longitude,
    metadata.latitude,
    metadata.seaHeight,
    0,
    0,
    0,
  )
  const origin = [originX, originY, originZ] as const
  const meterScale = mapboxgl.MercatorCoordinate.fromLngLat(
    [metadata.longitude, metadata.latitude],
    metadata.seaHeight,
  ).meterInMercatorCoordinateUnits()
  const pitchRad = (metadata.fixAngle * Math.PI) / 180
  const maxAzimuth = Math.max(...dataset.azimuths)
  const minAzimuth = Math.min(...dataset.azimuths)
  const azimuthSpan = maxAzimuth - minAzimuth

  let pointProg: WebGLProgram | null = null
  let lineProg: WebGLProgram | null = null
  let surfaceProg: WebGLProgram | null = null
  let beamProg: WebGLProgram | null = null
  let beamLineProg: WebGLProgram | null = null
  let barbProg: WebGLProgram | null = null

  let pointVB: WebGLBuffer | null = null
  let pointCount = 0
  let surfaceInterpVB: WebGLBuffer | null = null
  let surfaceInterpIB: WebGLBuffer | null = null
  let surfaceInterpIndexCount = 0
  let surfaceFlatVB: WebGLBuffer | null = null
  let surfaceFlatIB: WebGLBuffer | null = null
  let surfaceFlatIndexCount = 0
  let ringVB: WebGLBuffer | null = null
  let ringCount = 0
  let beamVB: WebGLBuffer | null = null
  let beamIB: WebGLBuffer | null = null
  let beamIndexCount = 0
  let beamLineVB: WebGLBuffer | null = null
  let beamLineCount = 0
  let barbVB: WebGLBuffer | null = null
  let barbCount = 0
  let barbTex: WebGLTexture | null = null
  let barbAtlasCols = 8
  let barbAtlasRows = 3

  let startTime = 0

  function setBeamUniforms(
    gl: WebGLRenderingContext,
    prog: WebGLProgram,
    scanAngleRad: number,
    heightExaggeration: number,
  ) {
    gl.uniform1f(gl.getUniformLocation(prog, 'u_scanAngleRad')!, scanAngleRad)
    gl.uniform1f(gl.getUniformLocation(prog, 'u_pitchRad')!, pitchRad)
    gl.uniform3f(gl.getUniformLocation(prog, 'u_origin')!, origin[0], origin[1], origin[2])
    gl.uniform1f(gl.getUniformLocation(prog, 'u_meterScale')!, meterScale)
    gl.uniform1f(gl.getUniformLocation(prog, 'u_maxDistMeters')!, dataset.maxValidDistance + metadata.rangeResolution / 2)
    gl.uniform1f(gl.getUniformLocation(prog, 'u_heightExaggeration')!, heightExaggeration)
  }

  return {
    id: 'lidar-wind-layer',
    type: 'custom',
    renderingMode: '3d',

    onAdd(_map, gl) {
      startTime = performance.now()

      const pointData = buildPointBuffer(dataset.validSamples)
      pointCount = dataset.validSamples.length
      pointVB = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, pointVB)
      gl.bufferData(gl.ARRAY_BUFFER, pointData, gl.STATIC_DRAW)

      const interpMesh = buildSurfaceMesh(dataset, true)
      surfaceInterpVB = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, surfaceInterpVB)
      gl.bufferData(gl.ARRAY_BUFFER, interpMesh.vertices, gl.STATIC_DRAW)
      surfaceInterpIB = gl.createBuffer()
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, surfaceInterpIB)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, interpMesh.indices, gl.STATIC_DRAW)
      surfaceInterpIndexCount = interpMesh.indices.length

      const flatMesh = buildSurfaceMesh(dataset, false)
      surfaceFlatVB = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, surfaceFlatVB)
      gl.bufferData(gl.ARRAY_BUFFER, flatMesh.vertices, gl.STATIC_DRAW)
      surfaceFlatIB = gl.createBuffer()
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, surfaceFlatIB)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, flatMesh.indices, gl.STATIC_DRAW)
      surfaceFlatIndexCount = flatMesh.indices.length

      const ringData = buildRangeRings(dataset)
      ringCount = ringData.length / 6
      ringVB = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, ringVB)
      gl.bufferData(gl.ARRAY_BUFFER, ringData, gl.STATIC_DRAW)

      const scanMeshes = buildPpiScanMeshes()
      beamVB = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, beamVB)
      gl.bufferData(gl.ARRAY_BUFFER, scanMeshes.wedge.vertices, gl.STATIC_DRAW)
      beamIB = gl.createBuffer()
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, beamIB)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, scanMeshes.wedge.indices, gl.STATIC_DRAW)
      beamIndexCount = scanMeshes.wedge.indices.length

      beamLineVB = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, beamLineVB)
      gl.bufferData(gl.ARRAY_BUFFER, scanMeshes.beamLine, gl.STATIC_DRAW)
      beamLineCount = scanMeshes.beamLine.length / 3

      const pvs = compileShader(gl, gl.VERTEX_SHADER, POINT_VS)
      const pfs = compileShader(gl, gl.FRAGMENT_SHADER, POINT_FS)
      if (pvs && pfs) pointProg = linkProgram(gl, pvs, pfs)

      const lvs = compileShader(gl, gl.VERTEX_SHADER, LINE_VS)
      const lfs = compileShader(gl, gl.FRAGMENT_SHADER, LINE_FS)
      if (lvs && lfs) lineProg = linkProgram(gl, lvs, lfs)

      const svs = compileShader(gl, gl.VERTEX_SHADER, SURFACE_VS)
      const sfs = compileShader(gl, gl.FRAGMENT_SHADER, SURFACE_FS)
      if (svs && sfs) surfaceProg = linkProgram(gl, svs, sfs)

      const bvs = compileShader(gl, gl.VERTEX_SHADER, BEAM_VS)
      const bfs = compileShader(gl, gl.FRAGMENT_SHADER, BEAM_FS)
      if (bvs && bfs) beamProg = linkProgram(gl, bvs, bfs)

      const blvs = compileShader(gl, gl.VERTEX_SHADER, BEAM_LINE_VS)
      const blfs = compileShader(gl, gl.FRAGMENT_SHADER, BEAM_LINE_FS)
      if (blvs && blfs) beamLineProg = linkProgram(gl, blvs, blfs)

      const barbData = buildBarbQuadBuffer(dataset, origin)
      barbCount = barbData.length / BARB_QUAD_FLOATS
      barbVB = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, barbVB)
      gl.bufferData(gl.ARRAY_BUFFER, barbData, gl.STATIC_DRAW)

      const atlas = createWindBarbAtlas()
      barbAtlasCols = atlas.cols
      barbAtlasRows = atlas.rows
      barbTex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, barbTex)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas)

      const barbVs = compileShader(gl, gl.VERTEX_SHADER, BARB_VS)
      const barbFs = compileShader(gl, gl.FRAGMENT_SHADER, BARB_FS)
      if (barbVs && barbFs) barbProg = linkProgram(gl, barbVs, barbFs)
    },

    render(gl, matrix) {
      const params = paramsRef.current
      const time = (performance.now() - startTime) / 1000
      const scanProgress = (time * params.scanSpeed) / 60
      const scanAzimuthDeg = minAzimuth + (scanProgress % 1) * azimuthSpan
      const scanAngleRad = (scanAzimuthDeg * Math.PI) / 180

      gl.enable(gl.BLEND)
      gl.enable(gl.DEPTH_TEST)
      gl.depthFunc(gl.LEQUAL)

      const drawLines = (
        buffer: WebGLBuffer | null,
        count: number,
        color: [number, number, number, number],
        vectorScale = 1,
        stride = 12,
        useDelta = false,
      ) => {
        if (!lineProg || !buffer) return
        gl.useProgram(lineProg)
        gl.uniformMatrix4fv(gl.getUniformLocation(lineProg, 'u_matrix')!, false, matrix)
        gl.uniform3f(gl.getUniformLocation(lineProg, 'u_origin')!, origin[0], origin[1], origin[2])
        gl.uniform1f(gl.getUniformLocation(lineProg, 'u_heightExaggeration')!, params.heightExaggeration)
        gl.uniform1f(gl.getUniformLocation(lineProg, 'u_vectorScale')!, vectorScale)
        gl.uniform4f(gl.getUniformLocation(lineProg, 'u_color')!, color[0], color[1], color[2], color[3])
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
        const aStart = gl.getAttribLocation(lineProg, 'a_start')
        gl.enableVertexAttribArray(aStart)
        gl.vertexAttribPointer(aStart, 3, gl.FLOAT, false, stride, 0)
        if (useDelta) {
          const aDelta = gl.getAttribLocation(lineProg, 'a_delta')
          gl.enableVertexAttribArray(aDelta)
          gl.vertexAttribPointer(aDelta, 3, gl.FLOAT, false, stride, 12)
        } else {
          const aDelta = gl.getAttribLocation(lineProg, 'a_delta')
          gl.disableVertexAttribArray(aDelta)
          gl.vertexAttrib3f(aDelta, 0, 0, 0)
        }
        gl.lineWidth(1)
        gl.drawArrays(gl.LINES, 0, count)
      }

      if (params.showSurface && surfaceProg) {
        const surfaceVB = params.interpolateSurface ? surfaceInterpVB : surfaceFlatVB
        const surfaceIB = params.interpolateSurface ? surfaceInterpIB : surfaceFlatIB
        const surfaceIndexCount = params.interpolateSurface
          ? surfaceInterpIndexCount
          : surfaceFlatIndexCount
        if (surfaceVB && surfaceIB) {
          gl.useProgram(surfaceProg)
          gl.uniformMatrix4fv(gl.getUniformLocation(surfaceProg, 'u_matrix')!, false, matrix)
          gl.uniform1f(gl.getUniformLocation(surfaceProg, 'u_speedMin')!, dataset.windSpeedMin)
          gl.uniform1f(gl.getUniformLocation(surfaceProg, 'u_speedMax')!, dataset.windSpeedMax)
          gl.uniform3f(gl.getUniformLocation(surfaceProg, 'u_origin')!, origin[0], origin[1], origin[2])
          gl.uniform1f(gl.getUniformLocation(surfaceProg, 'u_heightExaggeration')!, params.heightExaggeration)
          gl.uniform1f(gl.getUniformLocation(surfaceProg, 'u_opacity')!, params.surfaceOpacity)
          gl.uniform1f(gl.getUniformLocation(surfaceProg, 'u_time')!, time)
          gl.uniform1f(gl.getUniformLocation(surfaceProg, 'u_scanAzimuthDeg')!, scanAzimuthDeg)
          gl.uniform1f(gl.getUniformLocation(surfaceProg, 'u_scanTrailDeg')!, 25)

          gl.bindBuffer(gl.ARRAY_BUFFER, surfaceVB)
          const surfStride = 20
          const aPos = gl.getAttribLocation(surfaceProg, 'a_pos')
          gl.enableVertexAttribArray(aPos)
          gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, surfStride, 0)
          const aSpeed = gl.getAttribLocation(surfaceProg, 'a_speed')
          gl.enableVertexAttribArray(aSpeed)
          gl.vertexAttribPointer(aSpeed, 1, gl.FLOAT, false, surfStride, 12)
          const aAz = gl.getAttribLocation(surfaceProg, 'a_azimuth')
          gl.enableVertexAttribArray(aAz)
          gl.vertexAttribPointer(aAz, 1, gl.FLOAT, false, surfStride, 16)

          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, surfaceIB)
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
          gl.drawElements(gl.TRIANGLES, surfaceIndexCount, gl.UNSIGNED_INT, 0)
        }
      }

      if (params.showRangeRings) {
        gl.depthMask(false)
        drawLines(ringVB, ringCount, [0.0, 0.9, 1.0, 0.7], 1, 24, true)
        gl.depthMask(true)
      }

      if (params.showScanBeam && beamProg && beamVB && beamIB) {
        gl.disable(gl.CULL_FACE)
        gl.depthMask(false)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE)

        gl.useProgram(beamProg)
        gl.uniformMatrix4fv(gl.getUniformLocation(beamProg, 'u_matrix')!, false, matrix)
        setBeamUniforms(gl, beamProg, scanAngleRad, params.heightExaggeration)
        gl.uniform1f(gl.getUniformLocation(beamProg, 'u_opacity')!, params.beamOpacity)
        gl.uniform1f(gl.getUniformLocation(beamProg, 'u_time')!, time)

        gl.bindBuffer(gl.ARRAY_BUFFER, beamVB)
        const aAttr = gl.getAttribLocation(beamProg, 'a_attr')
        gl.enableVertexAttribArray(aAttr)
        gl.vertexAttribPointer(aAttr, 3, gl.FLOAT, false, 12, 0)
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, beamIB)
        gl.drawElements(gl.TRIANGLES, beamIndexCount, gl.UNSIGNED_SHORT, 0)

        if (beamLineProg && beamLineVB) {
          gl.useProgram(beamLineProg)
          gl.uniformMatrix4fv(gl.getUniformLocation(beamLineProg, 'u_matrix')!, false, matrix)
          setBeamUniforms(gl, beamLineProg, scanAngleRad, params.heightExaggeration)
          gl.uniform1f(gl.getUniformLocation(beamLineProg, 'u_opacity')!, params.beamOpacity)
          gl.uniform1f(gl.getUniformLocation(beamLineProg, 'u_time')!, time)
          gl.bindBuffer(gl.ARRAY_BUFFER, beamLineVB)
          const aLine = gl.getAttribLocation(beamLineProg, 'a_attr')
          gl.enableVertexAttribArray(aLine)
          gl.vertexAttribPointer(aLine, 3, gl.FLOAT, false, 12, 0)
          gl.drawArrays(gl.LINE_STRIP, 0, beamLineCount)
        }

        gl.depthMask(true)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
      }

      if (params.showPoints && pointProg && pointVB) {
        gl.useProgram(pointProg)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
        gl.uniformMatrix4fv(gl.getUniformLocation(pointProg, 'u_matrix')!, false, matrix)
        gl.uniform1f(gl.getUniformLocation(pointProg, 'u_time')!, time)
        gl.uniform1f(gl.getUniformLocation(pointProg, 'u_pointSize')!, params.pointSize)
        gl.uniform1f(gl.getUniformLocation(pointProg, 'u_speedMin')!, dataset.windSpeedMin)
        gl.uniform1f(gl.getUniformLocation(pointProg, 'u_speedMax')!, dataset.windSpeedMax)
        gl.uniform3f(gl.getUniformLocation(pointProg, 'u_origin')!, origin[0], origin[1], origin[2])
        gl.uniform1f(gl.getUniformLocation(pointProg, 'u_heightExaggeration')!, params.heightExaggeration)
        gl.uniform1f(gl.getUniformLocation(pointProg, 'u_colorMode')!, params.colorMode === 'direction' ? 1 : 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, pointVB)
        const stride = 24
        const aPos = gl.getAttribLocation(pointProg, 'a_pos')
        gl.enableVertexAttribArray(aPos)
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, stride, 0)
        const aSpeed = gl.getAttribLocation(pointProg, 'a_speed')
        gl.enableVertexAttribArray(aSpeed)
        gl.vertexAttribPointer(aSpeed, 1, gl.FLOAT, false, stride, 12)
        const aDir = gl.getAttribLocation(pointProg, 'a_direction')
        gl.enableVertexAttribArray(aDir)
        gl.vertexAttribPointer(aDir, 1, gl.FLOAT, false, stride, 16)
        const aValid = gl.getAttribLocation(pointProg, 'a_valid')
        gl.enableVertexAttribArray(aValid)
        gl.vertexAttribPointer(aValid, 1, gl.FLOAT, false, stride, 20)

        gl.drawArrays(gl.POINTS, 0, pointCount)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
      }

      if (params.showWindBarbs && barbProg && barbVB && barbTex) {
        const zoom = mapRef.current?.getZoom() ?? 11.5
        const worldSize = 512 * 2 ** zoom
        const metersPerPixel =
          (40075016.686 * Math.cos((metadata.latitude * Math.PI) / 180)) / worldSize
        const halfSizeMeters = 22 * params.barbScale * metersPerPixel

        gl.useProgram(barbProg)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
        gl.uniformMatrix4fv(gl.getUniformLocation(barbProg, 'u_matrix')!, false, matrix)
        gl.uniform3f(gl.getUniformLocation(barbProg, 'u_origin')!, origin[0], origin[1], origin[2])
        gl.uniform1f(gl.getUniformLocation(barbProg, 'u_heightExaggeration')!, params.heightExaggeration)
        gl.uniform1f(gl.getUniformLocation(barbProg, 'u_halfSize')!, halfSizeMeters * meterScale)
        gl.uniform1f(gl.getUniformLocation(barbProg, 'u_lift')!, 6 * meterScale)
        gl.uniform1f(gl.getUniformLocation(barbProg, 'u_cols')!, barbAtlasCols)
        gl.uniform1f(gl.getUniformLocation(barbProg, 'u_rows')!, barbAtlasRows)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, barbTex)
        gl.uniform1i(gl.getUniformLocation(barbProg, 'u_atlas')!, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, barbVB)
        const barbStride = BARB_QUAD_FLOATS * 4
        const aCenter = gl.getAttribLocation(barbProg, 'a_center')
        gl.enableVertexAttribArray(aCenter)
        gl.vertexAttribPointer(aCenter, 3, gl.FLOAT, false, barbStride, 0)
        const aRight = gl.getAttribLocation(barbProg, 'a_right')
        gl.enableVertexAttribArray(aRight)
        gl.vertexAttribPointer(aRight, 3, gl.FLOAT, false, barbStride, 12)
        const aStaff = gl.getAttribLocation(barbProg, 'a_staff')
        gl.enableVertexAttribArray(aStaff)
        gl.vertexAttribPointer(aStaff, 3, gl.FLOAT, false, barbStride, 24)
        const aNormal = gl.getAttribLocation(barbProg, 'a_normal')
        gl.enableVertexAttribArray(aNormal)
        gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, barbStride, 36)
        const aCorner = gl.getAttribLocation(barbProg, 'a_corner')
        gl.enableVertexAttribArray(aCorner)
        gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, barbStride, 48)
        const aBin = gl.getAttribLocation(barbProg, 'a_bin')
        gl.enableVertexAttribArray(aBin)
        gl.vertexAttribPointer(aBin, 1, gl.FLOAT, false, barbStride, 56)
        gl.drawArrays(gl.TRIANGLES, 0, barbCount)
      }

      mapRef.current?.triggerRepaint()
    },

    onRemove(_map, gl) {
      for (const buf of [pointVB, surfaceInterpVB, surfaceInterpIB, surfaceFlatVB, surfaceFlatIB, ringVB, beamVB, beamIB, beamLineVB, barbVB]) {
        if (buf) gl.deleteBuffer(buf)
      }
      if (barbTex) gl.deleteTexture(barbTex)
      for (const prog of [pointProg, lineProg, surfaceProg, beamProg, beamLineProg, barbProg]) {
        if (prog) gl.deleteProgram(prog)
      }
    },
  }
}

export type { LayerParams as LidarLayerParams }
