import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MAPBOX_ACCESS_TOKEN, MAP_STYLES } from '@/config/mapbox'
import styles from './WaterSurfaceDemo.module.css'

const waterBounds = {
  lonMin: 108,
  lonMax: 122,
  latMin: 15,
  latMax: 25,
}
const gridRows = 120
const gridCols = 120

const vertexShaderSource = `
  attribute vec2 a_position;
  attribute vec2 a_uv;

  uniform mat4 u_matrix;
  uniform float u_time;
  uniform float u_amplitude;
  uniform float u_frequency;
  uniform float u_speed;

  varying vec2 v_uv;
  varying vec3 v_normal;
  varying float v_wave;

  void main() {
    float t = u_time * u_speed;
    float freq = u_frequency;

    float wave1 = sin(a_uv.x * freq + t * 1.0) * cos(a_uv.y * freq * 0.7 + t * 0.8);
    float wave2 = sin(a_uv.x * freq * 1.3 - t * 1.2 + 1.0) * cos(a_uv.y * freq * 0.5 + t * 0.6) * 0.5;
    float wave3 = sin((a_uv.x + a_uv.y) * freq * 0.8 + t * 1.5) * 0.3;
    float wave4 = sin(a_uv.x * freq * 2.1 + a_uv.y * freq * 1.8 - t * 2.0) * 0.15;

    float wave = (wave1 + wave2 + wave3 + wave4) * u_amplitude;

    float eps = 0.01;
    float wx1 = sin((a_uv.x + eps) * freq + t) * cos(a_uv.y * freq * 0.7 + t * 0.8)
              + sin((a_uv.x + eps) * freq * 1.3 - t * 1.2 + 1.0) * cos(a_uv.y * freq * 0.5 + t * 0.6) * 0.5
              + sin(((a_uv.x + eps) + a_uv.y) * freq * 0.8 + t * 1.5) * 0.3
              + sin((a_uv.x + eps) * freq * 2.1 + a_uv.y * freq * 1.8 - t * 2.0) * 0.15;
    float wy1 = sin(a_uv.x * freq + t) * cos((a_uv.y + eps) * freq * 0.7 + t * 0.8)
              + sin(a_uv.x * freq * 1.3 - t * 1.2 + 1.0) * cos((a_uv.y + eps) * freq * 0.5 + t * 0.6) * 0.5
              + sin((a_uv.x + (a_uv.y + eps)) * freq * 0.8 + t * 1.5) * 0.3
              + sin(a_uv.x * freq * 2.1 + (a_uv.y + eps) * freq * 1.8 - t * 2.0) * 0.15;

    float dzdx = (wx1 - (wave1 + wave2 + wave3 + wave4)) * u_amplitude / eps;
    float dzdy = (wy1 - (wave1 + wave2 + wave3 + wave4)) * u_amplitude / eps;

    v_normal = normalize(vec3(-dzdx, -dzdy, 1.0));
    v_uv = a_uv;
    v_wave = wave / u_amplitude;

    vec2 pos = a_position;
    pos.y += wave;

    gl_Position = u_matrix * vec4(pos, 0.0, 1.0);
  }
`

const fragmentShaderSource = `
  precision mediump float;

  uniform float u_opacity;
  uniform float u_specular;
  uniform vec3 u_shallowColor;
  uniform vec3 u_deepColor;
  uniform vec3 u_lightDir;

  varying vec2 v_uv;
  varying vec3 v_normal;
  varying float v_wave;

  void main() {
    vec3 normal = normalize(v_normal);
    vec3 lightDir = normalize(u_lightDir);
    vec3 viewDir = vec3(0.0, 0.0, 1.0);

    float diffuse = max(dot(normal, lightDir), 0.0) * 0.3 + 0.7;

    vec3 halfDir = normalize(lightDir + viewDir);
    float spec = pow(max(dot(normal, halfDir), 0.0), 64.0) * u_specular;

    float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);

    float depth = clamp(v_wave * 0.5 + 0.5, 0.0, 1.0);
    vec3 waterColor = mix(u_deepColor, u_shallowColor, depth);

    vec3 color = waterColor * diffuse + vec3(1.0, 1.0, 1.0) * spec + vec3(0.7, 0.85, 1.0) * fresnel * 0.3;

    gl_FragColor = vec4(color, u_opacity);
  }
`

function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return [r, g, b]
}

function lngLatToMercator(lng: number, lat: number): [number, number] {
  const x = (lng + 180) / 360
  const latRad = (lat * Math.PI) / 180
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2
  return [x, y]
}

function buildGrid() {
  const vertices: number[] = []
  const indices: number[] = []

  for (let row = 0; row <= gridRows; row++) {
    for (let col = 0; col <= gridCols; col++) {
      const u = col / gridCols
      const v = row / gridRows
      const lng = waterBounds.lonMin + u * (waterBounds.lonMax - waterBounds.lonMin)
      const lat = waterBounds.latMin + v * (waterBounds.latMax - waterBounds.latMin)
      const [mx, my] = lngLatToMercator(lng, lat)
      vertices.push(mx, my, u, v)
    }
  }

  for (let row = 0; row < gridRows; row++) {
    for (let col = 0; col < gridCols; col++) {
      const tl = row * (gridCols + 1) + col
      const tr = tl + 1
      const bl = (row + 1) * (gridCols + 1) + col
      const br = bl + 1

      indices.push(tl, bl, tr)
      indices.push(tr, bl, br)
    }
  }

  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices),
  }
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
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

interface WaterParams {
  waveAmplitude: number
  waveFrequency: number
  waveSpeed: number
  waterOpacity: number
  specularIntensity: number
  shallowColor: string
  deepColor: string
}

function createWaterLayer(
  mapRef: React.MutableRefObject<mapboxgl.Map | null>,
  paramsRef: React.MutableRefObject<WaterParams>,
): mapboxgl.CustomLayerInterface {
  let program: WebGLProgram | null = null
  let vertexBuffer: WebGLBuffer | null = null
  let indexBuffer: WebGLBuffer | null = null
  let numIndices = 0
  let startTime = 0

  let uMatrixLoc: WebGLUniformLocation | null = null
  let uTimeLoc: WebGLUniformLocation | null = null
  let uAmplitudeLoc: WebGLUniformLocation | null = null
  let uFrequencyLoc: WebGLUniformLocation | null = null
  let uSpeedLoc: WebGLUniformLocation | null = null
  let uOpacityLoc: WebGLUniformLocation | null = null
  let uSpecularLoc: WebGLUniformLocation | null = null
  let uShallowColorLoc: WebGLUniformLocation | null = null
  let uDeepColorLoc: WebGLUniformLocation | null = null
  let uLightDirLoc: WebGLUniformLocation | null = null

  return {
    id: 'water-surface-layer',
    type: 'custom',
    renderingMode: '2d',

    onAdd(_map: mapboxgl.Map, gl: WebGLRenderingContext) {
      const vs = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource)
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource)
      if (!vs || !fs) return

      program = gl.createProgram()!
      gl.attachShader(program, vs)
      gl.attachShader(program, fs)
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Program link error:', gl.getProgramInfoLog(program))
        return
      }

      uMatrixLoc = gl.getUniformLocation(program, 'u_matrix')
      uTimeLoc = gl.getUniformLocation(program, 'u_time')
      uAmplitudeLoc = gl.getUniformLocation(program, 'u_amplitude')
      uFrequencyLoc = gl.getUniformLocation(program, 'u_frequency')
      uSpeedLoc = gl.getUniformLocation(program, 'u_speed')
      uOpacityLoc = gl.getUniformLocation(program, 'u_opacity')
      uSpecularLoc = gl.getUniformLocation(program, 'u_specular')
      uShallowColorLoc = gl.getUniformLocation(program, 'u_shallowColor')
      uDeepColorLoc = gl.getUniformLocation(program, 'u_deepColor')
      uLightDirLoc = gl.getUniformLocation(program, 'u_lightDir')

      gl.getExtension('OES_element_index_uint')

      const grid = buildGrid()

      vertexBuffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, grid.vertices, gl.STATIC_DRAW)

      indexBuffer = gl.createBuffer()
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, grid.indices, gl.STATIC_DRAW)

      numIndices = grid.indices.length
      startTime = performance.now()
    },

    render(gl: WebGLRenderingContext, matrix: number[]) {
      if (!program) return

      const params = paramsRef.current

      gl.useProgram(program)

      gl.uniformMatrix4fv(uMatrixLoc, false, matrix)
      gl.uniform1f(uTimeLoc, (performance.now() - startTime) / 1000)
      gl.uniform1f(uAmplitudeLoc, params.waveAmplitude)
      gl.uniform1f(uFrequencyLoc, params.waveFrequency)
      gl.uniform1f(uSpeedLoc, params.waveSpeed)
      gl.uniform1f(uOpacityLoc, params.waterOpacity)
      gl.uniform1f(uSpecularLoc, params.specularIntensity)

      const sc = hexToRgb(params.shallowColor)
      gl.uniform3f(uShallowColorLoc, sc[0], sc[1], sc[2])
      const dc = hexToRgb(params.deepColor)
      gl.uniform3f(uDeepColorLoc, dc[0], dc[1], dc[2])

      gl.uniform3f(uLightDirLoc, 0.5, 0.7, 1.0)

      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
      const aPosition = gl.getAttribLocation(program, 'a_position')
      gl.enableVertexAttribArray(aPosition)
      gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 16, 0)

      const aUv = gl.getAttribLocation(program, 'a_uv')
      gl.enableVertexAttribArray(aUv)
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8)

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)

      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

      gl.drawElements(gl.TRIANGLES, numIndices, gl.UNSIGNED_INT, 0)

      mapRef.current?.triggerRepaint()
    },

    onRemove(_map: mapboxgl.Map, gl: WebGLRenderingContext) {
      if (vertexBuffer) gl.deleteBuffer(vertexBuffer)
      if (indexBuffer) gl.deleteBuffer(indexBuffer)
      if (program) gl.deleteProgram(program)
      vertexBuffer = null
      indexBuffer = null
      program = null
    },
  }
}

export default function WaterSurfaceDemo() {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)

  const [waveAmplitude, setWaveAmplitude] = useState(0.005)
  const [waveFrequency, setWaveFrequency] = useState(30.0)
  const [waveSpeed, setWaveSpeed] = useState(2.0)
  const [waterOpacity, setWaterOpacity] = useState(0.75)
  const [specularIntensity, setSpecularIntensity] = useState(1.0)
  const [shallowColor, setShallowColor] = useState('#4a90d9')
  const [deepColor, setDeepColor] = useState('#0a2463')

  const paramsRef = useRef<WaterParams>({
    waveAmplitude,
    waveFrequency,
    waveSpeed,
    waterOpacity,
    specularIntensity,
    shallowColor,
    deepColor,
  })

  paramsRef.current = {
    waveAmplitude,
    waveFrequency,
    waveSpeed,
    waterOpacity,
    specularIntensity,
    shallowColor,
    deepColor,
  }

  const updateParams = () => {
    mapRef.current?.triggerRepaint()
  }

  useEffect(() => {
    if (!mapContainerRef.current) return

    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLES.LIGHT,
      center: [115, 20],
      zoom: 5,
      projection: 'mercator' as any,
    })

    mapRef.current = map
    map.addControl(new mapboxgl.NavigationControl(), 'top-right')

    map.on('load', () => {
      map.addLayer(createWaterLayer(mapRef, paramsRef))
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
        <h3>水面模拟参数</h3>
        <div className={styles.sliderGroup}>
          <label>波浪振幅: {waveAmplitude.toFixed(3)}</label>
          <input
            type="range"
            value={waveAmplitude}
            min={0.001}
            max={0.02}
            step={0.001}
            onChange={(e) => {
              setWaveAmplitude(Number(e.target.value))
              updateParams()
            }}
          />
        </div>
        <div className={styles.sliderGroup}>
          <label>波浪频率: {waveFrequency.toFixed(1)}</label>
          <input
            type="range"
            value={waveFrequency}
            min={5}
            max={80}
            step={1}
            onChange={(e) => {
              setWaveFrequency(Number(e.target.value))
              updateParams()
            }}
          />
        </div>
        <div className={styles.sliderGroup}>
          <label>波浪速度: {waveSpeed.toFixed(1)}</label>
          <input
            type="range"
            value={waveSpeed}
            min={0.5}
            max={5.0}
            step={0.1}
            onChange={(e) => {
              setWaveSpeed(Number(e.target.value))
              updateParams()
            }}
          />
        </div>
        <div className={styles.sliderGroup}>
          <label>水面透明度: {waterOpacity.toFixed(2)}</label>
          <input
            type="range"
            value={waterOpacity}
            min={0.2}
            max={1.0}
            step={0.05}
            onChange={(e) => {
              setWaterOpacity(Number(e.target.value))
              updateParams()
            }}
          />
        </div>
        <div className={styles.sliderGroup}>
          <label>高光强度: {specularIntensity.toFixed(2)}</label>
          <input
            type="range"
            value={specularIntensity}
            min={0.0}
            max={2.0}
            step={0.05}
            onChange={(e) => {
              setSpecularIntensity(Number(e.target.value))
              updateParams()
            }}
          />
        </div>
        <div className={styles.colorInfo}>
          <h4>水面颜色</h4>
          <div className={styles.colorRow}>
            <label>浅水色:</label>
            <input
              type="color"
              value={shallowColor}
              onChange={(e) => {
                setShallowColor(e.target.value)
                updateParams()
              }}
            />
          </div>
          <div className={styles.colorRow}>
            <label>深水色:</label>
            <input
              type="color"
              value={deepColor}
              onChange={(e) => {
                setDeepColor(e.target.value)
                updateParams()
              }}
            />
          </div>
        </div>
        <div className={styles.infoText}>
          <p>该 Demo 使用 WebGL 自定义图层实现水面波浪模拟效果。</p>
          <p>顶点着色器通过正弦函数叠加多层波浪，片元着色器结合法线计算高光与菲涅尔效果。</p>
        </div>
      </div>
    </div>
  )
}
