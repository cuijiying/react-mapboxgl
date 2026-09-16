import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MAPBOX_ACCESS_TOKEN, MAP_STYLES } from '@/config/mapbox'
import styles from './TemperatureGridDemo.module.css'

const legendItems = [
  { value: -10, color: '#313695', label: '≤ -10' },
  { value: 0, color: '#4575b4', label: '-10 ~ 0' },
  { value: 10, color: '#74add1', label: '0 ~ 10' },
  { value: 15, color: '#abd9e9', label: '10 ~ 15' },
  { value: 20, color: '#e0f3f8', label: '15 ~ 20' },
  { value: 25, color: '#fee090', label: '20 ~ 25' },
  { value: 30, color: '#fdae61', label: '25 ~ 30' },
  { value: 35, color: '#f46d43', label: '30 ~ 35' },
  { value: 40, color: '#d73027', label: '35 ~ 40' },
  { value: 50, color: '#a50026', label: '> 40' },
]

const temperatureColorStops = [
  { temp: -20, color: [0.192, 0.212, 0.584, 1.0] },
  { temp: -10, color: [0.271, 0.459, 0.706, 1.0] },
  { temp: 0, color: [0.455, 0.678, 0.820, 1.0] },
  { temp: 10, color: [0.671, 0.851, 0.914, 1.0] },
  { temp: 15, color: [0.878, 0.953, 0.973, 1.0] },
  { temp: 20, color: [0.996, 0.878, 0.565, 1.0] },
  { temp: 25, color: [0.992, 0.682, 0.380, 1.0] },
  { temp: 30, color: [0.957, 0.427, 0.263, 1.0] },
  { temp: 35, color: [0.843, 0.188, 0.153, 1.0] },
  { temp: 40, color: [0.647, 0.0, 0.149, 1.0] },
]

function generateGridData() {
  const lonStart = 100
  const latStart = 20
  const lonStep = 0.1
  const latStep = 0.1
  const rows = 100
  const cols = 200

  const values: number[][] = []

  for (let row = 0; row < rows; row++) {
    const rowData: number[] = []
    for (let col = 0; col < cols; col++) {
      const lon = lonStart + col * lonStep
      const lat = latStart + row * latStep

      const baseTemp = 35 - (lat - 20) * 0.8
      const noise = Math.sin(lon * 0.5) * 3 + Math.cos(lat * 0.3) * 2
      const temp = baseTemp + noise

      rowData.push(Math.round(temp * 10) / 10)
    }
    values.push(rowData)
  }

  return {
    lonStart,
    latStart,
    lonStep,
    latStep,
    rows,
    cols,
    values,
  }
}

function getColorForTemperature(temp: number): [number, number, number, number] {
  if (temp <= temperatureColorStops[0].temp) {
    return temperatureColorStops[0].color as [number, number, number, number]
  }
  if (temp >= temperatureColorStops[temperatureColorStops.length - 1].temp) {
    return temperatureColorStops[temperatureColorStops.length - 1].color as [
      number,
      number,
      number,
      number,
    ]
  }

  for (let i = 0; i < temperatureColorStops.length - 1; i++) {
    const lower = temperatureColorStops[i]
    const upper = temperatureColorStops[i + 1]
    if (temp >= lower.temp && temp < upper.temp) {
      const t = (temp - lower.temp) / (upper.temp - lower.temp)
      return [
        lower.color[0] + t * (upper.color[0] - lower.color[0]),
        lower.color[1] + t * (upper.color[1] - lower.color[1]),
        lower.color[2] + t * (upper.color[2] - lower.color[2]),
        lower.color[3] + t * (upper.color[3] - lower.color[3]),
      ]
    }
  }

  return [1, 1, 1, 1]
}

function createTemperatureLayer(
  gridData: ReturnType<typeof generateGridData>,
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
  let currentTempMin = -20
  let currentTempMax = 50

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

      const { lonStart, latStart, lonStep, latStep, rows, cols, values } = gridData

      for (let row = 0; row <= rows; row++) {
        for (let col = 0; col <= cols; col++) {
          const lon = lonStart + col * lonStep
          const lat = latStart + row * latStep

          const x = (lon + 180) / 360
          const y =
            (1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) /
            2

          vertices.push(x, y)

          const r = Math.min(row, rows - 1)
          const c = Math.min(col, cols - 1)
          const temp = values[r][c]
          const color = getColorForTemperature(temp)
          colors.push(...color)
          temperatures.push(temp)
        }
      }

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const topLeft = row * (cols + 1) + col
          const topRight = topLeft + 1
          const bottomLeft = (row + 1) * (cols + 1) + col
          const bottomRight = bottomLeft + 1

          indices.push(topLeft, bottomLeft, topRight)
          indices.push(topRight, bottomLeft, bottomRight)
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

export default function TemperatureGridDemo() {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const updateTempRangeUniformRef = useRef<((min: number, max: number) => void) | null>(null)
  const gridDataRef = useRef<ReturnType<typeof generateGridData> | null>(null)

  const [tempRange, setTempRange] = useState({ min: -20, max: 50 })

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
      center: [110, 30],
      zoom: 4,
    })

    mapRef.current = map

    map.on('load', () => {
      const gridData = generateGridData()
      gridDataRef.current = gridData
      console.log('Grid data generated:', gridData.rows, 'rows,', gridData.cols, 'cols')

      const temperatureLayer = createTemperatureLayer(gridData, updateTempRangeUniformRef)
      map.addLayer(temperatureLayer)

      map.on('click', (e) => {
        const currentGridData = gridDataRef.current
        if (!currentGridData) return

        const { lng, lat } = e.lngLat
        const { lonStart, latStart, lonStep, latStep, rows, cols, values } = currentGridData

        const lonEnd = lonStart + cols * lonStep
        const latEnd = latStart + rows * latStep

        if (lng >= lonStart && lng <= lonEnd && lat >= latStart && lat <= latEnd) {
          const col = Math.floor((lng - lonStart) / lonStep)
          const row = Math.floor((lat - latStart) / latStep)

          if (row >= 0 && row < rows && col >= 0 && col < cols) {
            const temp = values[row][col]

            new mapboxgl.Popup()
              .setLngLat([lng, lat])
              .setHTML(`
                <div style="padding: 5px;">
                  <div style="font-weight: bold; margin-bottom: 5px;">温度信息</div>
                  <div>经度: ${lng.toFixed(4)}°</div>
                  <div>纬度: ${lat.toFixed(4)}°</div>
                  <div style="color: #d73027; font-size: 16px; margin-top: 5px;">
                    温度: <strong>${temp}°C</strong>
                  </div>
                </div>
              `)
              .addTo(map)
          }
        }
      })

      map.on('mousemove', (e) => {
        const currentGridData = gridDataRef.current
        if (!currentGridData) return

        const { lng, lat } = e.lngLat
        const { lonStart, latStart, lonStep, latStep, rows, cols } = currentGridData

        const lonEnd = lonStart + cols * lonStep
        const latEnd = latStart + rows * latStep

        if (lng >= lonStart && lng <= lonEnd && lat >= latStart && lat <= latEnd) {
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
      gridDataRef.current = null
    }
  }, [])

  return (
    <div className={styles.demoContainer}>
      <div ref={mapContainerRef} className={styles.mapContainer} />
      <div className={styles.controlPanel}>
        <div className={styles.legend}>
          <h4>温度 (°C)</h4>
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
              min={-20}
              max={50}
              step={1}
              onChange={(e) => handleMinChange(Number(e.target.value))}
            />
          </div>
          <div className={styles.sliderGroup}>
            <label>最高温度: {tempRange.max}°C</label>
            <input
              type="range"
              value={tempRange.max}
              min={-20}
              max={50}
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
