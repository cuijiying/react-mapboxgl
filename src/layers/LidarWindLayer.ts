import type { MutableRefObject } from 'react'
import mapboxgl from 'mapbox-gl'
import type { LidarDataset, LidarSample } from '@/utils/lidarCsvParser'
import { polarToMercator } from '@/utils/lidarCsvParser'

export interface LidarWindLayerOptions {
  id?: string
  dataset: LidarDataset
  showPoints?: boolean
  showSurface?: boolean
  showVectors?: boolean
  showScanBeam?: boolean
  showRangeRings?: boolean
  pointSize?: number
  pointOpacity?: number
  surfaceOpacity?: number
  vectorScale?: number
  scanSpeed?: number
  heightExaggeration?: number
  colorMode?: 'speed' | 'direction'
}

interface LayerParams {
  showPoints: boolean
  showSurface: boolean
  showVectors: boolean
  showScanBeam: boolean
  showRangeRings: boolean
  pointSize: number
  pointOpacity: number
  surfaceOpacity: number
  vectorScale: number
  scanSpeed: number
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

  uniform mat4 u_matrix;
  uniform float u_speedMin;
  uniform float u_speedMax;
  uniform vec3 u_origin;
  uniform float u_heightExaggeration;

  varying vec3 v_color;
  varying float v_height;

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
    float speedNorm = (a_speed - u_speedMin) / max(u_speedMax - u_speedMin, 0.001);
    v_color = speedColor(speedNorm);
    gl_Position = u_matrix * vec4(pos, 1.0);
  }
`

const SURFACE_FS = `
  precision mediump float;
  varying vec3 v_color;
  varying float v_height;
  uniform float u_opacity;
  uniform float u_time;

  void main() {
    float shimmer = 0.85 + 0.15 * sin(u_time * 2.0 + v_height * 80.0);
    vec3 color = v_color * shimmer;
    float alpha = u_opacity * (0.35 + v_height * 120.0);
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.75));
  }
`

const BEAM_VS = `
  attribute vec4 a_pos;
  uniform mat4 u_matrix;
  uniform float u_scanAngle;
  uniform vec3 u_origin;
  uniform float u_radius;
  uniform float u_heightExaggeration;

  varying float v_heightNorm;
  varying float v_radial;

  void main() {
    float c = cos(u_scanAngle);
    float s = sin(u_scanAngle);
    float rx = a_pos.x * c - a_pos.y * s;
    float ry = a_pos.x * s + a_pos.y * c;

    vec3 worldPos = vec3(
      u_origin.x + rx * u_radius,
      u_origin.y - ry * u_radius,
      u_origin.z + a_pos.z * u_radius * u_heightExaggeration * 4.0
    );

    v_heightNorm = a_pos.z;
    v_radial = a_pos.w;
    gl_Position = u_matrix * vec4(worldPos, 1.0);
  }
`

const BEAM_FS = `
  precision mediump float;
  uniform float u_opacity;
  uniform float u_time;
  varying float v_heightNorm;
  varying float v_radial;

  void main() {
    float edge = 1.0 - abs(v_radial - 0.5) * 2.0;
    edge = pow(edge, 3.0);
    float heightFade = 1.0 - v_heightNorm * 0.5;
    float pulse = 0.7 + 0.3 * sin(u_time * 6.0);
    vec3 color = mix(vec3(0.0, 0.9, 1.0), vec3(0.2, 1.0, 0.6), v_heightNorm);
    float alpha = edge * heightFade * u_opacity * pulse;
    gl_FragColor = vec4(color, alpha);
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

function buildSurfaceMesh(dataset: LidarDataset): { vertices: Float32Array; indices: Uint32Array } {
  const { samples, azimuths } = dataset
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
  const indexMap = new Map<string, number>()

  function addVertex(s: LidarSample): number {
    const key = `${s.azimuth}_${s.distance}`
    const existing = indexMap.get(key)
    if (existing !== undefined) return existing
    const idx = vertices.length / 4
    vertices.push(s.x, s.y, s.z, s.hWindSpeed ?? 0)
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
      if (a.hWindSpeed === null && b.hWindSpeed === null && c.hWindSpeed === null && d.hWindSpeed === null) {
        continue
      }
      const i0 = addVertex(a)
      const i1 = addVertex(b)
      const i2 = addVertex(c)
      const i3 = addVertex(d)
      indices.push(i0, i2, i1, i1, i2, i3)
    }
  }

  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices),
  }
}

function buildVectorLines(samples: LidarSample[]): Float32Array {
  const lines: number[] = []
  const step = Math.max(1, Math.floor(samples.length / 800))
  const m = mapboxgl.MercatorCoordinate.fromLngLat([0, 0], 1).meterInMercatorCoordinateUnits()
  const baseScale = 800

  for (let i = 0; i < samples.length; i += step) {
    const s = samples[i]!
    if (s.hWindSpeed === null || s.hWindDirection === null) continue

    const dirRad = (s.hWindDirection * Math.PI) / 180
    const arrowLen = s.hWindSpeed * baseScale
    const dx = Math.sin(dirRad) * arrowLen * m
    const dy = -Math.cos(dirRad) * arrowLen * m
    const dz = 0.002

    lines.push(s.x, s.y, s.z, dx, dy, dz)

    const headLen = arrowLen * 0.25 * m
    const headAngle = 0.5
    const hx = Math.sin(dirRad)
    const hy = -Math.cos(dirRad)
    const tipX = s.x + dx
    const tipY = s.y + dy
    const tipZ = s.z + dz

    for (const sign of [-1, 1]) {
      const lx = hx * Math.cos(headAngle) - sign * hy * Math.sin(headAngle)
      const ly = hx * Math.sin(headAngle) + sign * hy * Math.cos(headAngle)
      lines.push(tipX, tipY, tipZ, -lx * headLen, -ly * headLen, 0)
    }
  }

  return new Float32Array(lines)
}

function buildRangeRings(
  lng: number,
  lat: number,
  alt: number,
  maxDist: number,
  ringCount: number,
): Float32Array {
  const segments: number[] = []
  const origin = mapboxgl.MercatorCoordinate.fromLngLat([lng, lat], alt)
  const m = origin.meterInMercatorCoordinateUnits()

  for (let r = 1; r <= ringCount; r++) {
    const radius = (maxDist / ringCount) * r
    const segs = 72
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2
      const a1 = ((i + 1) / segs) * Math.PI * 2
      const x0 = origin.x + Math.sin(a0) * radius * m
      const y0 = origin.y - Math.cos(a0) * radius * m
      const x1 = origin.x + Math.sin(a1) * radius * m
      const y1 = origin.y - Math.cos(a1) * radius * m
      segments.push(x0, y0, origin.z, x1 - x0, y1 - y0, 0)
    }
  }

  return new Float32Array(segments)
}

function buildScanBeamMesh(): { vertices: Float32Array; indices: Uint16Array } {
  const R_SEGS = 16
  const A_SEGS = 6
  const halfAngle = (2.5 * Math.PI) / 180
  const vertices: number[] = []
  const indices: number[] = []

  for (let ri = 0; ri <= R_SEGS; ri++) {
    const r = ri / R_SEGS
    for (let ai = 0; ai <= A_SEGS; ai++) {
      const t = ai / A_SEGS
      const a = (t - 0.5) * 2 * halfAngle
      vertices.push(r * Math.cos(a), r * Math.sin(a), 4 * r * (1 - r), t)
    }
  }

  for (let ri = 0; ri < R_SEGS; ri++) {
    for (let ai = 0; ai < A_SEGS; ai++) {
      const i0 = ri * (A_SEGS + 1) + ai
      indices.push(i0, i0 + A_SEGS + 1, i0 + 1, i0 + 1, i0 + A_SEGS + 1, i0 + 2)
    }
  }

  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) }
}

export function createLidarWindLayer(
  mapRef: MutableRefObject<mapboxgl.Map | null>,
  dataset: LidarDataset,
  paramsRef: React.MutableRefObject<LayerParams>,
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
  const radiusMerc = mapboxgl.MercatorCoordinate.fromLngLat(
    [metadata.longitude, metadata.latitude],
    metadata.seaHeight,
  ).meterInMercatorCoordinateUnits() * dataset.maxDistance

  let pointProg: WebGLProgram | null = null
  let lineProg: WebGLProgram | null = null
  let surfaceProg: WebGLProgram | null = null
  let beamProg: WebGLProgram | null = null

  let pointVB: WebGLBuffer | null = null
  let pointCount = 0
  let surfaceVB: WebGLBuffer | null = null
  let surfaceIB: WebGLBuffer | null = null
  let surfaceIndexCount = 0
  let vectorVB: WebGLBuffer | null = null
  let vectorCount = 0
  let ringVB: WebGLBuffer | null = null
  let ringCount = 0
  let beamVB: WebGLBuffer | null = null
  let beamIB: WebGLBuffer | null = null
  let beamIndexCount = 0

  let startTime = 0

  return {
    id: 'lidar-wind-layer',
    type: 'custom',
    renderingMode: '3d',

    onAdd(_map, gl) {
      startTime = performance.now()

      const pointData = buildPointBuffer(dataset.samples)
      pointCount = dataset.samples.length
      pointVB = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, pointVB)
      gl.bufferData(gl.ARRAY_BUFFER, pointData, gl.STATIC_DRAW)

      const mesh = buildSurfaceMesh(dataset)
      surfaceVB = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, surfaceVB)
      gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW)
      surfaceIB = gl.createBuffer()
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, surfaceIB)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW)
      surfaceIndexCount = mesh.indices.length

      const vectorData = buildVectorLines(dataset.validSamples)
      vectorCount = vectorData.length / 6
      vectorVB = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, vectorVB)
      gl.bufferData(gl.ARRAY_BUFFER, vectorData, gl.STATIC_DRAW)

      const ringData = buildRangeRings(
        metadata.longitude,
        metadata.latitude,
        metadata.seaHeight,
        dataset.maxDistance,
        6,
      )
      ringCount = ringData.length / 6
      ringVB = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, ringVB)
      gl.bufferData(gl.ARRAY_BUFFER, ringData, gl.STATIC_DRAW)

      const beam = buildScanBeamMesh()
      beamVB = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, beamVB)
      gl.bufferData(gl.ARRAY_BUFFER, beam.vertices, gl.STATIC_DRAW)
      beamIB = gl.createBuffer()
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, beamIB)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, beam.indices, gl.STATIC_DRAW)
      beamIndexCount = beam.indices.length

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
    },

    render(gl, matrix) {
      const params = paramsRef.current
      const time = (performance.now() - startTime) / 1000
      const scanAngle = (time * params.scanSpeed * 2 * Math.PI) / 60

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

      if (params.showRangeRings) {
        drawLines(ringVB, ringCount, [0.0, 0.85, 1.0, 0.35], 1, 24, true)
      }

      if (params.showSurface && surfaceProg && surfaceVB && surfaceIB) {
        gl.useProgram(surfaceProg)
        gl.uniformMatrix4fv(gl.getUniformLocation(surfaceProg, 'u_matrix')!, false, matrix)
        gl.uniform1f(gl.getUniformLocation(surfaceProg, 'u_speedMin')!, dataset.windSpeedMin)
        gl.uniform1f(gl.getUniformLocation(surfaceProg, 'u_speedMax')!, dataset.windSpeedMax)
        gl.uniform3f(gl.getUniformLocation(surfaceProg, 'u_origin')!, origin[0], origin[1], origin[2])
        gl.uniform1f(gl.getUniformLocation(surfaceProg, 'u_heightExaggeration')!, params.heightExaggeration)
        gl.uniform1f(gl.getUniformLocation(surfaceProg, 'u_opacity')!, params.surfaceOpacity)
        gl.uniform1f(gl.getUniformLocation(surfaceProg, 'u_time')!, time)

        gl.bindBuffer(gl.ARRAY_BUFFER, surfaceVB)
        const aPos = gl.getAttribLocation(surfaceProg, 'a_pos')
        gl.enableVertexAttribArray(aPos)
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 16, 0)
        const aSpeed = gl.getAttribLocation(surfaceProg, 'a_speed')
        gl.enableVertexAttribArray(aSpeed)
        gl.vertexAttribPointer(aSpeed, 1, gl.FLOAT, false, 16, 12)

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, surfaceIB)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
        gl.drawElements(gl.TRIANGLES, surfaceIndexCount, gl.UNSIGNED_INT, 0)
      }

      if (params.showScanBeam && beamProg && beamVB && beamIB) {
        gl.useProgram(beamProg)
        gl.disable(gl.CULL_FACE)
        gl.depthMask(false)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
        gl.uniformMatrix4fv(gl.getUniformLocation(beamProg, 'u_matrix')!, false, matrix)
        gl.uniform1f(gl.getUniformLocation(beamProg, 'u_scanAngle')!, scanAngle)
        gl.uniform3f(gl.getUniformLocation(beamProg, 'u_origin')!, origin[0], origin[1], origin[2])
        gl.uniform1f(gl.getUniformLocation(beamProg, 'u_radius')!, radiusMerc)
        gl.uniform1f(gl.getUniformLocation(beamProg, 'u_heightExaggeration')!, params.heightExaggeration)
        gl.uniform1f(gl.getUniformLocation(beamProg, 'u_opacity')!, 0.55)
        gl.uniform1f(gl.getUniformLocation(beamProg, 'u_time')!, time)

        gl.bindBuffer(gl.ARRAY_BUFFER, beamVB)
        const aPos = gl.getAttribLocation(beamProg, 'a_pos')
        gl.enableVertexAttribArray(aPos)
        gl.vertexAttribPointer(aPos, 4, gl.FLOAT, false, 16, 0)
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, beamIB)
        gl.drawElements(gl.TRIANGLES, beamIndexCount, gl.UNSIGNED_SHORT, 0)
        gl.depthMask(true)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
      }

      if (params.showVectors) {
        drawLines(vectorVB, vectorCount, [0.2, 1.0, 0.7, 0.75], params.vectorScale, 24, true)
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

      mapRef.current?.triggerRepaint()
    },

    onRemove(_map, gl) {
      for (const buf of [pointVB, surfaceVB, surfaceIB, vectorVB, ringVB, beamVB, beamIB]) {
        if (buf) gl.deleteBuffer(buf)
      }
      for (const prog of [pointProg, lineProg, surfaceProg, beamProg]) {
        if (prog) gl.deleteProgram(prog)
      }
    },
  }
}

export type { LayerParams as LidarLayerParams }
