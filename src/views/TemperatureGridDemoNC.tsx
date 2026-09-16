import { useCallback, useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MAPBOX_ACCESS_TOKEN, MAP_STYLES } from '@/config/mapbox'
import styles from './TemperatureGridDemoNC.module.css'

const API_BASE = 'http://localhost:3000'

const channels = [
  { id: '23', name: '23 GHz', description: '23.8 GHz - 水汽通道' },
  { id: '31', name: '31 GHz', description: '31.4 GHz - 窗区通道 (地表/云液态水)' },
  { id: '50', name: '50 GHz', description: '50.3 GHz - 氧气通道 (对流层温度)' },
  { id: '89', name: '89 GHz', description: '89.0 GHz - 窗区通道 (地表/降水)' },
]

const legendItems = [
  { value: -80, color: '#313695', label: '≤ -80' },
  { value: -60, color: '#4575b4', label: '-80 ~ -60' },
  { value: -40, color: '#74add1', label: '-60 ~ -40' },
  { value: -30, color: '#abd9e9', label: '-40 ~ -30' },
  { value: -20, color: '#e0f3f8', label: '-30 ~ -20' },
  { value: -10, color: '#fee090', label: '-20 ~ -10' },
  { value: 0, color: '#fdae61', label: '-10 ~ 0' },
  { value: 10, color: '#f46d43', label: '0 ~ 10' },
  { value: 20, color: '#d73027', label: '10 ~ 20' },
  { value: 30, color: '#a50026', label: '> 20' },
]

const temperatureColorStops = [
  { temp: -90, color: [0.192, 0.212, 0.584, 1.0] },
  { temp: -80, color: [0.271, 0.459, 0.706, 1.0] },
  { temp: -60, color: [0.455, 0.678, 0.820, 1.0] },
  { temp: -40, color: [0.671, 0.851, 0.914, 1.0] },
  { temp: -30, color: [0.878, 0.953, 0.973, 1.0] },
  { temp: -20, color: [0.996, 0.878, 0.565, 1.0] },
  { temp: -10, color: [0.992, 0.682, 0.380, 1.0] },
  { temp: 0, color: [0.957, 0.427, 0.263, 1.0] },
  { temp: 10, color: [0.843, 0.188, 0.153, 1.0] },
  { temp: 25, color: [0.647, 0.0, 0.149, 1.0] },
]

interface GridData {
  rows: number
  cols: number
  latitudes: number[][]
  longitudes: number[][]
  values: (number | null)[][]
}

interface ApiResponse {
  success: boolean
  data: {
    metadata: {
      satellite: string
      validCount: number
      rows: number
      cols: number
      unit: string
      valueRange: { min?: number; max?: number }
    }
    bounds: {
      latMin: number
      latMax: number
      lonMin: number
      lonMax: number
    }
    grid: GridData
  }
}

function getColorForTemperature(temp: number): [number, number, number, number] {
  const first = temperatureColorStops[0]!
  const last = temperatureColorStops[temperatureColorStops.length - 1]!
  if (temp <= first.temp) {
    return first.color as [number, number, number, number]
  }
  if (temp >= last.temp) {
    return last.color as [number, number, number, number]
  }

  for (let i = 0; i < temperatureColorStops.length - 1; i++) {
    const lower = temperatureColorStops[i]!
    const upper = temperatureColorStops[i + 1]!
    if (temp >= lower.temp && temp < upper.temp) {
      const t = (temp - lower.temp) / (upper.temp - lower.temp)
      return [
        lower.color[0]! + t * (upper.color[0]! - lower.color[0]!),
        lower.color[1]! + t * (upper.color[1]! - lower.color[1]!),
        lower.color[2]! + t * (upper.color[2]! - lower.color[2]!),
        lower.color[3]! + t * (upper.color[3]! - lower.color[3]!),
      ]
    }
  }

  return [1, 1, 1, 1]
}

function lngLatToMercator(lng: number, lat: number): [number, number] {
  const x = (lng + 180) / 360
  const latRad = (lat * Math.PI) / 180
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2
  return [x, y]
}

async function fetchGridData(channel: string): Promise<ApiResponse['data']> {
  const url = `${API_BASE}/api/temperature-grid?channel=${channel}&unit=celsius`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`)
  }
  const json: ApiResponse = await response.json()
  if (!json.success) {
    throw new Error('API returned error')
  }
  return json.data
}

function createTemperatureLayer(
  gridData: GridData,
  updateTempRangeUniformRef: React.MutableRefObject<
    ((min: number, max: number) => void) | null
  >,
): mapboxgl.CustomLayerInterface {
  let program: WebGLProgram | null = null
  let vertexBuffer: WebGLBuffer | null = null
  let colorBuffer: WebGLBuffer | null = null
  let tempBuffer: WebGLBuffer | null = null
  let indexBuffer: WebGLBuffer | null = null
  let numIndices = 0
  let tempMinLocation: WebGLUniformLocation | null = null
  let tempMaxLocation: WebGLUniformLocation | null = null
  let currentTempMin = -90
  let currentTempMax = 30

  updateTempRangeUniformRef.current = (min: number, max: number) => {
    currentTempMin = min
    currentTempMax = max
  }

  return {
    id: 'temperature-layer',
    type: 'custom',
    renderingMode: '2d',

    onAdd(_map: mapboxgl.Map, gl: WebGLRenderingContext) {
      const vertexShaderSource = `
        attribute vec2 a_position;
        attribute vec4 a_color;
        attribute float a_temperature;
        uniform mat4 u_matrix;
        varying vec4 v_color;
        varying float v_temperature;

        void main() {
          gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);
          v_color = a_color;
          v_temperature = a_temperature;
        }
      `

      const fragmentShaderSource = `
        precision mediump float;
        varying vec4 v_color;
        varying float v_temperature;
        uniform float u_tempMin;
        uniform float u_tempMax;

        void main() {
          if (v_temperature < u_tempMin || v_temperature > u_tempMax) {
            discard;
          }
          gl_FragColor = v_color;
        }
      `

      const vertexShader = gl.createShader(gl.VERTEX_SHADER)!
      gl.shaderSource(vertexShader, vertexShaderSource)
      gl.compileShader(vertexShader)

      const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)!
      gl.shaderSource(fragmentShader, fragmentShaderSource)
      gl.compileShader(fragmentShader)

      program = gl.createProgram()!
      gl.attachShader(program, vertexShader)
      gl.attachShader(program, fragmentShader)
      gl.linkProgram(program)

      tempMinLocation = gl.getUniformLocation(program, 'u_tempMin')
      tempMaxLocation = gl.getUniformLocation(program, 'u_tempMax')

      const vertices: number[] = []
      const colors: number[] = []
      const temperatures: number[] = []
      const indices: number[] = []

      const { rows, cols, latitudes, longitudes, values } = gridData

      const validMask: boolean[][] = []
      for (let row = 0; row < rows; row++) {
        const maskRow: boolean[] = []
        const valRow = values[row]!
        for (let col = 0; col < cols; col++) {
          maskRow[col] = valRow[col] !== null
        }
        validMask[row] = maskRow
      }

      for (let row = 0; row < rows; row++) {
        const latRow = latitudes[row]!
        const lonRow = longitudes[row]!
        const valRow = values[row]!
        for (let col = 0; col < cols; col++) {
          const lat = latRow[col] as number
          const lon = lonRow[col] as number
          const [x, y] = lngLatToMercator(lon, lat)

          vertices.push(x, y)

          const val = valRow[col]
          const temp: number = val !== null && val !== undefined ? val : 0
          const color =
            val !== null && val !== undefined
              ? getColorForTemperature(temp)
              : ([0, 0, 0, 0] as [number, number, number, number])
          colors.push(...color)
          temperatures.push(temp)
        }
      }

      for (let row = 0; row < rows - 1; row++) {
        const maskRow = validMask[row]!
        const maskRowNext = validMask[row + 1]!
        for (let col = 0; col < cols - 1; col++) {
          const topLeft = row * cols + col
          const topRight = topLeft + 1
          const bottomLeft = (row + 1) * cols + col
          const bottomRight = bottomLeft + 1

          const tlValid = maskRow[col]
          const trValid = maskRow[col + 1]
          const blValid = maskRowNext[col]
          const brValid = maskRowNext[col + 1]

          if (tlValid && blValid && trValid) {
            indices.push(topLeft, bottomLeft, topRight)
          }
          if (trValid && blValid && brValid) {
            indices.push(topRight, bottomLeft, bottomRight)
          }
        }
      }

      numIndices = indices.length

      vertexBuffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW)

      colorBuffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.STATIC_DRAW)

      tempBuffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, tempBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(temperatures), gl.STATIC_DRAW)

      indexBuffer = gl.createBuffer()
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), gl.STATIC_DRAW)
    },

    render(gl: WebGLRenderingContext, matrix: number[]) {
      if (!program) return

      gl.useProgram(program)

      const matrixLocation = gl.getUniformLocation(program, 'u_matrix')
      gl.uniformMatrix4fv(matrixLocation, false, matrix)

      gl.uniform1f(tempMinLocation, currentTempMin)
      gl.uniform1f(tempMaxLocation, currentTempMax)

      const positionLocation = gl.getAttribLocation(program, 'a_position')
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
      gl.enableVertexAttribArray(positionLocation)
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0)

      const colorLocation = gl.getAttribLocation(program, 'a_color')
      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer)
      gl.enableVertexAttribArray(colorLocation)
      gl.vertexAttribPointer(colorLocation, 4, gl.FLOAT, false, 0, 0)

      const tempLocation = gl.getAttribLocation(program, 'a_temperature')
      gl.bindBuffer(gl.ARRAY_BUFFER, tempBuffer)
      gl.enableVertexAttribArray(tempLocation)
      gl.vertexAttribPointer(tempLocation, 1, gl.FLOAT, false, 0, 0)

      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
      gl.drawElements(gl.TRIANGLES, numIndices, gl.UNSIGNED_INT, 0)
    },
  }
}

function findNearestPixel(
  lng: number,
  lat: number,
  gridData: GridData,
): { row: number; col: number; distance: number } | null {
  const { rows, cols, latitudes, longitudes, values } = gridData
  let minDist = Infinity
  let bestRow = -1
  let bestCol = -1

  for (let row = 0; row < rows; row++) {
    const latRow = latitudes[row]!
    const lonRow = longitudes[row]!
    const valRow = values[row]!
    for (let col = 0; col < cols; col++) {
      if (valRow[col] === null) continue
      const dLat = (latRow[col] as number) - lat
      const dLon = (lonRow[col] as number) - lng
      const dist = dLat * dLat + dLon * dLon
      if (dist < minDist) {
        minDist = dist
        bestRow = row
        bestCol = col
      }
    }
  }

  if (bestRow < 0) return null
  return { row: bestRow, col: bestCol, distance: Math.sqrt(minDist) }
}

export default function TemperatureGridDemoNC() {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const updateTempRangeUniformRef = useRef<((min: number, max: number) => void) | null>(null)
  const currentGridDataRef = useRef<GridData | null>(null)
  const currentBoundsRef = useRef<ApiResponse['data']['bounds'] | null>(null)
  const selectedChannelRef = useRef('89')
  const loadingRef = useRef(false)

  const [loading, setLoading] = useState(false)
  const [loadingText, setLoadingText] = useState('加载中...')
  const [dataInfo, setDataInfo] = useState<ApiResponse['data']['metadata'] | null>(null)
  const [selectedChannel, setSelectedChannel] = useState('89')
  const [tempRange, setTempRange] = useState({ min: -90, max: 30 })

  const switchChannel = useCallback(async (channel: string) => {
    const map = mapRef.current
    if (!map || loadingRef.current) return

    setSelectedChannel(channel)
    selectedChannelRef.current = channel

    try {
      loadingRef.current = true
      setLoading(true)
      setLoadingText(`加载 ${channel} GHz 通道数据...`)

      if (map.getLayer('temperature-layer')) {
        map.removeLayer('temperature-layer')
      }

      const result = await fetchGridData(channel)
      currentGridDataRef.current = result.grid
      currentBoundsRef.current = result.bounds
      setDataInfo(result.metadata)

      const temperatureLayer = createTemperatureLayer(result.grid, updateTempRangeUniformRef)
      map.addLayer(temperatureLayer)

      console.log(`Channel ${channel} loaded:`, result.metadata.validCount, 'valid pixels')
    } catch (err) {
      console.error('Failed to load data:', err)
      setLoadingText('数据加载失败，请检查 API 服务是否运行在 localhost:3000')
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [])

  const handleMinChange = (value: number) => {
    setTempRange((prev) => {
      const next = { ...prev, min: value }
      if (updateTempRangeUniformRef.current) {
        updateTempRangeUniformRef.current(next.min, next.max)
      }
      mapRef.current?.triggerRepaint()
      return next
    })
  }

  const handleMaxChange = (value: number) => {
    setTempRange((prev) => {
      const next = { ...prev, max: value }
      if (updateTempRangeUniformRef.current) {
        updateTempRangeUniformRef.current(next.min, next.max)
      }
      mapRef.current?.triggerRepaint()
      return next
    })
  }

  useEffect(() => {
    if (!mapContainerRef.current) return

    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLES.LIGHT,
      projection: 'mercator',
      center: [-35, 20],
      zoom: 3,
    })

    mapRef.current = map

    map.on('load', async () => {
      await switchChannel(selectedChannelRef.current)

      map.on('click', (e) => {
        const currentGridData = currentGridDataRef.current
        if (!currentGridData) return
        const { lng, lat } = e.lngLat

        const nearest = findNearestPixel(lng, lat, currentGridData)
        if (!nearest || nearest.distance > 2) return

        const valRow = currentGridData.values[nearest.row]!
        const latRow = currentGridData.latitudes[nearest.row]!
        const lonRow = currentGridData.longitudes[nearest.row]!
        const temp = valRow[nearest.col] as number | null
        const pixelLat = Number(latRow[nearest.col])
        const pixelLon = Number(lonRow[nearest.col])

        new mapboxgl.Popup()
          .setLngLat([lng, lat])
          .setHTML(`
            <div style="padding: 5px;">
              <div style="font-weight: bold; margin-bottom: 5px;">卫星亮温数据</div>
              <div>通道: ${selectedChannelRef.current} GHz</div>
              <div>经度: ${pixelLon.toFixed(4)}°</div>
              <div>纬度: ${pixelLat.toFixed(4)}°</div>
              <div>扫描线/像素: ${nearest.row}/${nearest.col}</div>
              <div style="color: #d73027; font-size: 16px; margin-top: 5px;">
                亮温: <strong>${temp?.toFixed(2)}°C</strong>
              </div>
            </div>
          `)
          .addTo(map)
      })

      map.on('mousemove', (e) => {
        const currentBounds = currentBoundsRef.current
        if (!currentBounds) {
          map.getCanvas().style.cursor = ''
          return
        }
        const { lng, lat } = e.lngLat
        const b = currentBounds

        if (lng >= b.lonMin && lng <= b.lonMax && lat >= b.latMin && lat <= b.latMax) {
          map.getCanvas().style.cursor = 'pointer'
        } else {
          map.getCanvas().style.cursor = ''
        }
      })
    })

    return () => {
      map.remove()
      mapRef.current = null
      updateTempRangeUniformRef.current = null
      currentGridDataRef.current = null
      currentBoundsRef.current = null
    }
  }, [switchChannel])

  return (
    <div className={styles.demoContainer}>
      <div ref={mapContainerRef} className={styles.mapContainer} />
      {loading && (
        <div className={styles.loadingOverlay}>
          <div className={styles.loadingSpinner} />
          <div className={styles.loadingText}>{loadingText}</div>
        </div>
      )}
      <div className={styles.controlPanel}>
        <div className={styles.channelControl}>
          <h4>AMSU-A 通道</h4>
          <div className={styles.channelButtons}>
            {channels.map((ch) => (
              <button
                key={ch.id}
                type="button"
                className={`${styles.channelButton} ${selectedChannel === ch.id ? styles.channelButtonActive : ''}`}
                title={ch.description}
                onClick={() => switchChannel(ch.id)}
              >
                {ch.name}
              </button>
            ))}
          </div>
          {dataInfo && (
            <div className={styles.dataInfo}>
              <div>卫星: {dataInfo.satellite}</div>
              <div>
                有效像素: {dataInfo.validCount}/{dataInfo.rows * dataInfo.cols}
              </div>
              <div>
                值域: {dataInfo.valueRange.min?.toFixed(1)} ~ {dataInfo.valueRange.max?.toFixed(1)}{' '}
                {dataInfo.unit}
              </div>
            </div>
          )}
        </div>
        <div className={styles.legend}>
          <h4>亮温 (°C)</h4>
          <div className={styles.legendItems}>
            {legendItems.map((item) => (
              <div key={item.value} className={styles.legendItem}>
                <span className={styles.colorBox} style={{ backgroundColor: item.color }} />
                <span className={styles.label}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
        <div className={styles.filterControl}>
          <h4>温度过滤</h4>
          <div className={styles.sliderGroup}>
            <label>最低温度: {tempRange.min}°C</label>
            <input
              type="range"
              value={tempRange.min}
              min={-90}
              max={30}
              step={1}
              onChange={(e) => handleMinChange(Number(e.target.value))}
            />
          </div>
          <div className={styles.sliderGroup}>
            <label>最高温度: {tempRange.max}°C</label>
            <input
              type="range"
              value={tempRange.max}
              min={-90}
              max={30}
              step={1}
              onChange={(e) => handleMaxChange(Number(e.target.value))}
            />
          </div>
          <div className={styles.rangeDisplay}>
            显示范围: {tempRange.min}°C ~ {tempRange.max}°C
          </div>
        </div>
      </div>
    </div>
  )
}
