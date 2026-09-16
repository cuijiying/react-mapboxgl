import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MAPBOX_ACCESS_TOKEN, MAP_STYLES } from '@/config/mapbox'
import styles from './RadarScanDemo.module.css'

const radarCenter: [number, number] = [121.5, 31.2]
const radiusDeg = 2.5

const targets: [number, number][] = [
  [0.3, 0.5],
  [-0.6, 0.3],
  [0.15, -0.55],
  [-0.35, -0.45],
  [0.7, -0.15],
  [-0.25, 0.7],
  [0.55, 0.4],
  [-0.65, -0.2],
  [0.25, -0.75],
  [-0.5, 0.55],
  [0.6, 0.15],
  [-0.15, -0.85],
]

const CONE_MESH_HALF_ANGLE = 30.0

function lngLatToMercator(lng: number, lat: number): [number, number] {
  const x = (lng + 180) / 360
  const latRad = (lat * Math.PI) / 180
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2
  return [x, y]
}

function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return [r, g, b]
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

function linkProgram(
  gl: WebGLRenderingContext,
  vs: WebGLShader,
  fs: WebGLShader,
): WebGLProgram | null {
  const prog = gl.createProgram()!
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(prog))
    return null
  }
  return prog
}

const [centerMercX, centerMercY] = lngLatToMercator(radarCenter[0], radarCenter[1])
const radiusMerc = radiusDeg / 360

const groundVS = `
  attribute vec2 a_position;
  attribute vec2 a_uv;
  uniform mat4 u_matrix;
  varying vec2 v_uv;

  void main() {
    v_uv = a_uv;
    gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);
  }
`

const groundFS = `
  precision highp float;

  uniform float u_time;
  uniform float u_scanSpeed;
  uniform float u_beamWidth;
  uniform float u_trailLength;
  uniform float u_opacity;
  uniform float u_ringCount;
  uniform vec3 u_beamColor;
  uniform vec3 u_ringColor;
  uniform float u_showGrid;
  uniform vec2 u_targets[12];
  uniform float u_targetCount;

  varying vec2 v_uv;

  #define PI 3.14159265359
  #define TWO_PI 6.28318530718

  float wrapAngle(float a) {
    return a - TWO_PI * floor((a + PI) / TWO_PI);
  }

  void main() {
    vec2 p = v_uv * 2.0 - 1.0;
    float dist = length(p);

    if (dist > 1.0) discard;

    float angle = atan(p.y, p.x);
    float scanAngle = u_time * u_scanSpeed * TWO_PI / 60.0;
    float angleDiff = wrapAngle(scanAngle - angle);

    vec3 color = vec3(0.0);
    float alpha = 0.0;

    float bg = (1.0 - dist * 0.8) * 0.06;
    color += u_beamColor * bg;
    alpha += bg;

    float ringVal = fract(dist * u_ringCount);
    float ringLine = 1.0 - smoothstep(0.0, 0.015, abs(ringVal - 0.5) - 0.485);
    color += u_ringColor * ringLine * 0.5;
    alpha += ringLine * 0.35;

    float edgeLine = 1.0 - smoothstep(0.0, 0.008, abs(dist - 1.0));
    color += u_ringColor * edgeLine * 0.8;
    alpha += edgeLine * 0.6;

    if (u_showGrid > 0.5) {
      float gx = 1.0 - smoothstep(0.0, 0.003, abs(p.x));
      float gy = 1.0 - smoothstep(0.0, 0.003, abs(p.y));
      float gd1 = 1.0 - smoothstep(0.0, 0.003, abs(p.x - p.y) / 1.414);
      float gd2 = 1.0 - smoothstep(0.0, 0.003, abs(p.x + p.y) / 1.414);
      float grid = max(max(gx, gy), max(gd1, gd2));
      color += u_ringColor * grid * 0.25;
      alpha += grid * 0.15;
    }

    float trailRad = u_trailLength * PI / 180.0;
    float trailFactor = 0.0;
    if (angleDiff > 0.0 && angleDiff < trailRad) {
      trailFactor = 1.0 - angleDiff / trailRad;
      trailFactor = pow(trailFactor, 2.0);
      trailFactor *= dist * 0.5 + 0.2;
    }
    color += u_beamColor * trailFactor * 0.65;
    alpha += trailFactor * 0.5;

    float beamRad = u_beamWidth * PI / 180.0;
    float beamLine = 1.0 - smoothstep(0.0, beamRad, abs(angleDiff));
    beamLine *= clamp(dist * 1.5, 0.0, 1.0);
    color += u_beamColor * beamLine * 1.2;
    alpha += beamLine * 0.9;

    float beamEdge = exp(-angleDiff * angleDiff * 500.0) * dist;
    color += vec3(1.0) * beamEdge * 0.4;
    alpha += beamEdge * 0.3;

    float centerDot = 1.0 - smoothstep(0.0, 0.025, dist);
    color += u_beamColor * centerDot * 1.5;
    alpha += centerDot * 0.8;

    for (int i = 0; i < 12; i++) {
      if (float(i) >= u_targetCount) break;
      vec2 tp = u_targets[i];
      float tDist = length(p - tp);
      if (tDist > 0.06) continue;

      float ta = atan(tp.y, tp.x);
      float tAngleDiff = wrapAngle(scanAngle - ta);

      float tFade = 0.0;
      if (tAngleDiff > 0.0 && tAngleDiff < trailRad * 1.5) {
        tFade = 1.0 - tAngleDiff / (trailRad * 1.5);
        tFade = tFade * tFade;
      }

      float pulse = 0.8 + 0.2 * sin(u_time * 8.0 + float(i) * 2.5);
      float glow = (1.0 - smoothstep(0.0, 0.03, tDist)) * tFade * pulse;
      color += vec3(1.0, 0.5, 0.2) * glow * 2.0;
      alpha += glow * 0.8;

      float ring = (1.0 - smoothstep(0.0, 0.008, abs(tDist - 0.04))) * tFade * 0.5;
      color += vec3(1.0, 0.6, 0.3) * ring;
      alpha += ring * 0.5;
    }

    alpha = clamp(alpha * u_opacity, 0.0, 1.0);
    gl_FragColor = vec4(color, alpha);
  }
`

const coneVS = `
  attribute vec4 a_pos;
  uniform mat4 u_matrix;
  uniform float u_scanAngle;
  uniform vec2 u_center;
  uniform float u_radius;
  uniform float u_height;

  varying float v_radial;
  varying float v_heightNorm;

  void main() {
    float c = cos(u_scanAngle);
    float s = sin(u_scanAngle);

    float rx = a_pos.x * c - a_pos.y * s;
    float ry = a_pos.x * s + a_pos.y * c;

    vec3 worldPos = vec3(
      u_center.x + rx * u_radius,
      u_center.y - ry * u_radius,
      a_pos.z * u_height * u_radius
    );

    v_radial = a_pos.w;
    v_heightNorm = a_pos.z;

    gl_Position = u_matrix * vec4(worldPos, 1.0);
  }
`

const coneFS = `
  precision mediump float;

  uniform vec3 u_beamColor;
  uniform float u_coneOpacity;
  uniform float u_beamWidth;

  varying float v_radial;
  varying float v_heightNorm;

  #define PI 3.14159265359
  #define MESH_HALF_ANGLE (${CONE_MESH_HALF_ANGLE.toFixed(1)} * PI / 180.0)

  void main() {
    float meshAngle = (v_radial - 0.5) * 2.0 * MESH_HALF_ANGLE;
    float halfBeam = u_beamWidth * 0.5;

    float edgeFade = 1.0 - smoothstep(halfBeam * 0.6, halfBeam * 1.2, abs(meshAngle));
    float heightFade = 1.0 - v_heightNorm * 0.6;
    float radialGrad = 0.3 + 0.7 * sqrt(clamp(v_heightNorm, 0.0, 1.0));

    float alpha = edgeFade * heightFade * radialGrad * u_coneOpacity;
    vec3 color = u_beamColor * (0.8 + v_heightNorm * 0.4);

    gl_FragColor = vec4(color, alpha);
  }
`

function buildGroundQuad() {
  const x0 = centerMercX - radiusMerc
  const x1 = centerMercX + radiusMerc
  const y0 = centerMercY + radiusMerc
  const y1 = centerMercY - radiusMerc

  const vertices = new Float32Array([
    x0, y0, 0.0, 0.0,
    x1, y0, 1.0, 0.0,
    x0, y1, 0.0, 1.0,
    x1, y1, 1.0, 1.0,
  ])
  const indices = new Uint16Array([0, 1, 2, 1, 3, 2])
  return { vertices, indices }
}

function buildConeMesh() {
  const R_SEGS = 20
  const A_SEGS = 8
  const halfAngle = (CONE_MESH_HALF_ANGLE * Math.PI) / 180
  const vertices: number[] = []
  const indices: number[] = []

  for (let ri = 0; ri <= R_SEGS; ri++) {
    const r = ri / R_SEGS
    for (let ai = 0; ai <= A_SEGS; ai++) {
      const t = ai / A_SEGS
      const a = (t - 0.5) * 2 * halfAngle
      const x = r * Math.cos(a)
      const y = r * Math.sin(a)
      const z = 4 * r * (1 - r)
      vertices.push(x, y, z, t)
    }
  }

  for (let ri = 0; ri < R_SEGS; ri++) {
    for (let ai = 0; ai < A_SEGS; ai++) {
      const i0 = ri * (A_SEGS + 1) + ai
      const i1 = i0 + 1
      const i2 = i0 + (A_SEGS + 1)
      const i3 = i2 + 1
      indices.push(i0, i2, i1)
      indices.push(i1, i2, i3)
    }
  }

  return {
    vertices: new Float32Array(vertices),
    indices: new Uint16Array(indices),
  }
}

interface RadarParams {
  scanSpeed: number
  beamWidth: number
  trailLength: number
  ringCount: number
  opacity: number
  showGrid: boolean
  showCone: boolean
  coneHeight: number
  coneOpacity: number
  beamColor: string
  ringColor: string
}

function createRadarLayer(
  mapRef: React.MutableRefObject<mapboxgl.Map | null>,
  paramsRef: React.MutableRefObject<RadarParams>,
): mapboxgl.CustomLayerInterface {
  let groundProgram: WebGLProgram | null = null
  let groundVB: WebGLBuffer | null = null
  let groundIB: WebGLBuffer | null = null
  let groundNumIndices = 0

  let coneProgram: WebGLProgram | null = null
  let coneVB: WebGLBuffer | null = null
  let coneIB: WebGLBuffer | null = null
  let coneNumIndices = 0

  let startTime = 0

  let g_uMatrix: WebGLUniformLocation | null = null
  let g_uTime: WebGLUniformLocation | null = null
  let g_uScanSpeed: WebGLUniformLocation | null = null
  let g_uBeamWidth: WebGLUniformLocation | null = null
  let g_uTrailLength: WebGLUniformLocation | null = null
  let g_uOpacity: WebGLUniformLocation | null = null
  let g_uRingCount: WebGLUniformLocation | null = null
  let g_uBeamColor: WebGLUniformLocation | null = null
  let g_uRingColor: WebGLUniformLocation | null = null
  let g_uShowGrid: WebGLUniformLocation | null = null
  let g_uTargets: WebGLUniformLocation | null = null
  let g_uTargetCount: WebGLUniformLocation | null = null

  let c_uMatrix: WebGLUniformLocation | null = null
  let c_uScanAngle: WebGLUniformLocation | null = null
  let c_uCenter: WebGLUniformLocation | null = null
  let c_uRadius: WebGLUniformLocation | null = null
  let c_uHeight: WebGLUniformLocation | null = null
  let c_uBeamColor: WebGLUniformLocation | null = null
  let c_uConeOpacity: WebGLUniformLocation | null = null
  let c_uConeBeamWidth: WebGLUniformLocation | null = null

  return {
    id: 'radar-scan-layer',
    type: 'custom',
    renderingMode: '3d',

    onAdd(_map: mapboxgl.Map, gl: WebGLRenderingContext) {
      const gvs = compileShader(gl, gl.VERTEX_SHADER, groundVS)
      const gfs = compileShader(gl, gl.FRAGMENT_SHADER, groundFS)
      if (gvs && gfs) {
        groundProgram = linkProgram(gl, gvs, gfs)
        if (groundProgram) {
          g_uMatrix = gl.getUniformLocation(groundProgram, 'u_matrix')
          g_uTime = gl.getUniformLocation(groundProgram, 'u_time')
          g_uScanSpeed = gl.getUniformLocation(groundProgram, 'u_scanSpeed')
          g_uBeamWidth = gl.getUniformLocation(groundProgram, 'u_beamWidth')
          g_uTrailLength = gl.getUniformLocation(groundProgram, 'u_trailLength')
          g_uOpacity = gl.getUniformLocation(groundProgram, 'u_opacity')
          g_uRingCount = gl.getUniformLocation(groundProgram, 'u_ringCount')
          g_uBeamColor = gl.getUniformLocation(groundProgram, 'u_beamColor')
          g_uRingColor = gl.getUniformLocation(groundProgram, 'u_ringColor')
          g_uShowGrid = gl.getUniformLocation(groundProgram, 'u_showGrid')
          g_uTargets = gl.getUniformLocation(groundProgram, 'u_targets')
          g_uTargetCount = gl.getUniformLocation(groundProgram, 'u_targetCount')

          const quad = buildGroundQuad()
          groundVB = gl.createBuffer()
          gl.bindBuffer(gl.ARRAY_BUFFER, groundVB)
          gl.bufferData(gl.ARRAY_BUFFER, quad.vertices, gl.STATIC_DRAW)
          groundIB = gl.createBuffer()
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, groundIB)
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quad.indices, gl.STATIC_DRAW)
          groundNumIndices = quad.indices.length
        }
      }

      const cvs = compileShader(gl, gl.VERTEX_SHADER, coneVS)
      const cfs = compileShader(gl, gl.FRAGMENT_SHADER, coneFS)
      if (cvs && cfs) {
        coneProgram = linkProgram(gl, cvs, cfs)
        if (coneProgram) {
          c_uMatrix = gl.getUniformLocation(coneProgram, 'u_matrix')
          c_uScanAngle = gl.getUniformLocation(coneProgram, 'u_scanAngle')
          c_uCenter = gl.getUniformLocation(coneProgram, 'u_center')
          c_uRadius = gl.getUniformLocation(coneProgram, 'u_radius')
          c_uHeight = gl.getUniformLocation(coneProgram, 'u_height')
          c_uBeamColor = gl.getUniformLocation(coneProgram, 'u_beamColor')
          c_uConeOpacity = gl.getUniformLocation(coneProgram, 'u_coneOpacity')
          c_uConeBeamWidth = gl.getUniformLocation(coneProgram, 'u_beamWidth')

          const cone = buildConeMesh()
          coneVB = gl.createBuffer()
          gl.bindBuffer(gl.ARRAY_BUFFER, coneVB)
          gl.bufferData(gl.ARRAY_BUFFER, cone.vertices, gl.STATIC_DRAW)
          coneIB = gl.createBuffer()
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, coneIB)
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, cone.indices, gl.STATIC_DRAW)
          coneNumIndices = cone.indices.length
        }
      }

      startTime = performance.now()
    },

    render(gl: WebGLRenderingContext, matrix: number[]) {
      const params = paramsRef.current
      const time = (performance.now() - startTime) / 1000
      const scanAngle = (time * params.scanSpeed * 2 * Math.PI) / 60

      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

      if (groundProgram) {
        gl.useProgram(groundProgram)

        gl.uniformMatrix4fv(g_uMatrix, false, matrix)
        gl.uniform1f(g_uTime, time)
        gl.uniform1f(g_uScanSpeed, params.scanSpeed)
        gl.uniform1f(g_uBeamWidth, params.beamWidth)
        gl.uniform1f(g_uTrailLength, params.trailLength)
        gl.uniform1f(g_uOpacity, params.opacity)
        gl.uniform1f(g_uRingCount, params.ringCount)

        const bc = hexToRgb(params.beamColor)
        gl.uniform3f(g_uBeamColor, bc[0], bc[1], bc[2])
        const rc = hexToRgb(params.ringColor)
        gl.uniform3f(g_uRingColor, rc[0], rc[1], rc[2])

        gl.uniform1f(g_uShowGrid, params.showGrid ? 1.0 : 0.0)

        const flatTargets: number[] = []
        for (const t of targets) {
          flatTargets.push(t[0], t[1])
        }
        gl.uniform2fv(g_uTargets, new Float32Array(flatTargets))
        gl.uniform1f(g_uTargetCount, targets.length)

        gl.bindBuffer(gl.ARRAY_BUFFER, groundVB)
        const aPos = gl.getAttribLocation(groundProgram, 'a_position')
        gl.enableVertexAttribArray(aPos)
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0)
        const aUv = gl.getAttribLocation(groundProgram, 'a_uv')
        gl.enableVertexAttribArray(aUv)
        gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8)

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, groundIB)
        gl.drawElements(gl.TRIANGLES, groundNumIndices, gl.UNSIGNED_SHORT, 0)
      }

      if (coneProgram && params.showCone) {
        gl.useProgram(coneProgram)
        gl.disable(gl.CULL_FACE)
        gl.depthMask(false)

        gl.blendFunc(gl.SRC_ALPHA, gl.ONE)

        gl.uniformMatrix4fv(c_uMatrix, false, matrix)
        gl.uniform1f(c_uScanAngle, scanAngle)
        gl.uniform2f(c_uCenter, centerMercX, centerMercY)
        gl.uniform1f(c_uRadius, radiusMerc)
        gl.uniform1f(c_uHeight, params.coneHeight)

        const bc = hexToRgb(params.beamColor)
        gl.uniform3f(c_uBeamColor, bc[0], bc[1], bc[2])
        gl.uniform1f(c_uConeOpacity, params.coneOpacity)
        gl.uniform1f(c_uConeBeamWidth, (params.beamWidth * Math.PI) / 180)

        gl.bindBuffer(gl.ARRAY_BUFFER, coneVB)
        const aPos = gl.getAttribLocation(coneProgram, 'a_pos')
        gl.enableVertexAttribArray(aPos)
        gl.vertexAttribPointer(aPos, 4, gl.FLOAT, false, 16, 0)

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, coneIB)
        gl.drawElements(gl.TRIANGLES, coneNumIndices, gl.UNSIGNED_SHORT, 0)

        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
        gl.depthMask(true)
      }

      mapRef.current?.triggerRepaint()
    },

    onRemove(_map: mapboxgl.Map, gl: WebGLRenderingContext) {
      if (groundVB) gl.deleteBuffer(groundVB)
      if (groundIB) gl.deleteBuffer(groundIB)
      if (groundProgram) gl.deleteProgram(groundProgram)
      if (coneVB) gl.deleteBuffer(coneVB)
      if (coneIB) gl.deleteBuffer(coneIB)
      if (coneProgram) gl.deleteProgram(coneProgram)
      groundVB = groundIB = groundProgram = null
      coneVB = coneIB = coneProgram = null
    },
  }
}

export default function RadarScanDemo() {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)

  const [scanSpeed, setScanSpeed] = useState(6.0)
  const [beamWidth, setBeamWidth] = useState(5.0)
  const [trailLength, setTrailLength] = useState(120.0)
  const [ringCount, setRingCount] = useState(5)
  const [opacity, setOpacity] = useState(0.85)
  const [showGrid, setShowGrid] = useState(true)
  const [showCone, setShowCone] = useState(true)
  const [coneHeight, setConeHeight] = useState(0.3)
  const [coneOpacity, setConeOpacity] = useState(0.5)
  const [beamColor, setBeamColor] = useState('#00ff88')
  const [ringColor, setRingColor] = useState('#00aa66')

  const paramsRef = useRef<RadarParams>({
    scanSpeed,
    beamWidth,
    trailLength,
    ringCount,
    opacity,
    showGrid,
    showCone,
    coneHeight,
    coneOpacity,
    beamColor,
    ringColor,
  })

  paramsRef.current = {
    scanSpeed,
    beamWidth,
    trailLength,
    ringCount,
    opacity,
    showGrid,
    showCone,
    coneHeight,
    coneOpacity,
    beamColor,
    ringColor,
  }

  const updateParams = () => {
    mapRef.current?.triggerRepaint()
  }

  useEffect(() => {
    if (!mapContainerRef.current) return

    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLES.DARK,
      center: radarCenter,
      zoom: 6,
      pitch: 45,
      bearing: -20,
      projection: 'mercator' as any,
    })

    mapRef.current = map
    map.addControl(new mapboxgl.NavigationControl(), 'top-right')

    map.on('load', () => {
      map.addLayer(createRadarLayer(mapRef, paramsRef))
    })

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  return (
    <div className={styles.demoContainer}>
      <div ref={mapContainerRef} className={styles.mapContainer} />
      <div className={styles.controlPanel}>
        <h3>雷达三维扫描</h3>

        <div className={styles.panelSection}>
          <h4>扫描参数</h4>
          <div className={styles.sliderGroup}>
            <label>扫描速度: {scanSpeed.toFixed(1)} rpm</label>
            <input
              type="range"
              value={scanSpeed}
              min={1}
              max={30}
              step={0.5}
              onChange={(e) => {
                setScanSpeed(Number(e.target.value))
                updateParams()
              }}
            />
          </div>
          <div className={styles.sliderGroup}>
            <label>波束宽度: {beamWidth.toFixed(0)}°</label>
            <input
              type="range"
              value={beamWidth}
              min={1}
              max={30}
              step={1}
              onChange={(e) => {
                setBeamWidth(Number(e.target.value))
                updateParams()
              }}
            />
          </div>
          <div className={styles.sliderGroup}>
            <label>拖尾长度: {trailLength.toFixed(0)}°</label>
            <input
              type="range"
              value={trailLength}
              min={10}
              max={270}
              step={5}
              onChange={(e) => {
                setTrailLength(Number(e.target.value))
                updateParams()
              }}
            />
          </div>
        </div>

        <div className={styles.panelSection}>
          <h4>显示设置</h4>
          <div className={styles.sliderGroup}>
            <label>距离环数: {ringCount}</label>
            <input
              type="range"
              value={ringCount}
              min={2}
              max={10}
              step={1}
              onChange={(e) => {
                setRingCount(Number(e.target.value))
                updateParams()
              }}
            />
          </div>
          <div className={styles.sliderGroup}>
            <label>透明度: {opacity.toFixed(2)}</label>
            <input
              type="range"
              value={opacity}
              min={0.1}
              max={1.0}
              step={0.05}
              onChange={(e) => {
                setOpacity(Number(e.target.value))
                updateParams()
              }}
            />
          </div>
          <div className={styles.checkboxGroup}>
            <label>
              <input
                type="checkbox"
                checked={showGrid}
                onChange={(e) => {
                  setShowGrid(e.target.checked)
                  updateParams()
                }}
              />
              显示十字线
            </label>
          </div>
        </div>

        <div className={styles.panelSection}>
          <h4>三维锥体</h4>
          <div className={styles.checkboxGroup}>
            <label>
              <input
                type="checkbox"
                checked={showCone}
                onChange={(e) => {
                  setShowCone(e.target.checked)
                  updateParams()
                }}
              />
              显示扫描锥体
            </label>
          </div>
          <div className={styles.sliderGroup}>
            <label>锥体高度: {coneHeight.toFixed(2)}</label>
            <input
              type="range"
              value={coneHeight}
              min={0.05}
              max={1.0}
              step={0.05}
              disabled={!showCone}
              onChange={(e) => {
                setConeHeight(Number(e.target.value))
                updateParams()
              }}
            />
          </div>
          <div className={styles.sliderGroup}>
            <label>锥体透明度: {coneOpacity.toFixed(2)}</label>
            <input
              type="range"
              value={coneOpacity}
              min={0.1}
              max={1.0}
              step={0.05}
              disabled={!showCone}
              onChange={(e) => {
                setConeOpacity(Number(e.target.value))
                updateParams()
              }}
            />
          </div>
        </div>

        <div className={styles.panelSection}>
          <h4>颜色</h4>
          <div className={styles.colorRow}>
            <label>波束颜色:</label>
            <input
              type="color"
              value={beamColor}
              onChange={(e) => {
                setBeamColor(e.target.value)
                updateParams()
              }}
            />
          </div>
          <div className={styles.colorRow}>
            <label>网格颜色:</label>
            <input
              type="color"
              value={ringColor}
              onChange={(e) => {
                setRingColor(e.target.value)
                updateParams()
              }}
            />
          </div>
        </div>

        <div className={styles.infoText}>
          <p>使用 WebGL 自定义图层实现雷达三维扫描效果。</p>
          <p>片元着色器绘制雷达显示面（圆环、十字线、扫描拖尾），</p>
          <p>顶点着色器实现 3D 扫描锥体旋转。</p>
        </div>
      </div>
    </div>
  )
}
