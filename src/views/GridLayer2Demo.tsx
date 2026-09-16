/**
 * GridLayer2Demo.tsx
 *
 * 演示 GridLayer2 的全部能力：
 *  1. GPU 纹理采样渲染（只有 4 个顶点）
 *  2. 温度过滤与透明度调整
 *  3. GPU / 矢量等值面、等值线显示方式切换（含数值标注）
 *  4. texSubImage2D 增量更新数据 → 时间动画
 *  5. 格点点击查询
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MAPBOX_ACCESS_TOKEN, MAP_STYLES } from '@/config/mapbox'
import {
  GridLayer2,
  type GridData,
  type ColorStop,
  type GridClickInfo,
  type GridDisplayMode
} from '@/layers/GridLayer2'
import {
  GridVectorContourLayer,
  type VectorContourDisplayMode
} from '@/layers/GridVectorContourLayer'
import './GridLayer2Demo.css'

const TEMP_MIN = -20
const TEMP_MAX = 50
const ANIM_TOTAL_FRAMES = 48

const COLOR_STOPS: ColorStop[] = [
  { value: -20, color: [49, 54, 149, 255] },
  { value: -10, color: [69, 117, 180, 255] },
  { value: 0, color: [116, 173, 209, 255] },
  { value: 10, color: [171, 217, 233, 255] },
  { value: 15, color: [224, 243, 248, 255] },
  { value: 20, color: [254, 224, 144, 255] },
  { value: 25, color: [253, 174, 97, 255] },
  { value: 30, color: [244, 109, 67, 255] },
  { value: 35, color: [215, 48, 39, 255] },
  { value: 40, color: [165, 0, 38, 255] }
]

const legendItems = [
  { hex: '#313695', label: '-20 ~ -10' },
  { hex: '#4575b4', label: '-10 ~ 0' },
  { hex: '#74add1', label: '0 ~ 10' },
  { hex: '#abd9e9', label: '10 ~ 15' },
  { hex: '#e0f3f8', label: '15 ~ 20' },
  { hex: '#fee090', label: '20 ~ 25' },
  { hex: '#fdae61', label: '25 ~ 30' },
  { hex: '#f46d43', label: '30 ~ 35' },
  { hex: '#d73027', label: '35 ~ 40' },
  { hex: '#a50026', label: '≥ 40' }
]

const displayModes: { value: GridDisplayMode; label: string }[] = [
  { value: 'smooth', label: '连续色斑' },
  { value: 'filled', label: '等值面（分段填色）' },
  { value: 'lines', label: '等值线' },
  { value: 'filled+lines', label: '等值面 + 等值线' }
]

const vectorDisplayModes: { value: VectorContourDisplayMode; label: string }[] = [
  { value: 'none', label: '关闭' },
  { value: 'lines', label: '矢量等值线' },
  { value: 'filled', label: '矢量等值面' },
  { value: 'filled+lines', label: '矢量等值面 + 线' }
]

const GRID_LON_START = 100
const GRID_LAT_START = 20
const GRID_LON_STEP = 0.1
const GRID_LAT_STEP = 0.1
const GRID_ROWS = 100
const GRID_COLS = 200

function generateGridData(timeOffset: number = 0): GridData {
  const values: number[][] = []
  for (let row = 0; row < GRID_ROWS; row++) {
    const rowData: number[] = []
    for (let col = 0; col < GRID_COLS; col++) {
      const lon = GRID_LON_START + col * GRID_LON_STEP
      const lat = GRID_LAT_START + row * GRID_LAT_STEP

      const base = 35 - (lat - 20) * 0.8
      const spatialNoise =
        Math.sin(lon * 0.5) * 3 +
        Math.cos(lat * 0.3) * 2
      const timeNoise =
        Math.sin(timeOffset * 0.13 + lon * 0.02) * 5 +
        Math.cos(timeOffset * 0.17 + lat * 0.03) * 3

      const temp = base + spatialNoise + timeNoise
      rowData.push(Math.round(temp * 10) / 10)
    }
    values.push(rowData)
  }

  return {
    lonStart: GRID_LON_START,
    latStart: GRID_LAT_START,
    lonStep: GRID_LON_STEP,
    latStep: GRID_LAT_STEP,
    rows: GRID_ROWS,
    cols: GRID_COLS,
    values
  }
}

const GPU_OPACITY_WITH_VECTOR = 0.35

export default function GridLayer2Demo() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const gridLayerRef = useRef<GridLayer2 | null>(null)
  const vectorContourLayerRef = useRef<GridVectorContourLayer | null>(null)
  const animTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [filterMin, setFilterMin] = useState(TEMP_MIN)
  const [filterMax, setFilterMax] = useState(TEMP_MAX)
  const [opacity, setOpacity] = useState(0.85)
  const [displayMode, setDisplayMode] = useState<GridDisplayMode>('smooth')
  const [vectorDisplayMode, setVectorDisplayMode] = useState<VectorContourDisplayMode>('none')
  const [showVectorLabels, setShowVectorLabels] = useState(true)
  const [clickInfo, setClickInfo] = useState<GridClickInfo | null>(null)
  const [isAnimating, setIsAnimating] = useState(false)
  const [animFrame, setAnimFrame] = useState(0)
  const [animSpeed, setAnimSpeed] = useState(200)

  const filterMinRef = useRef(filterMin)
  const filterMaxRef = useRef(filterMax)
  const opacityRef = useRef(opacity)
  const vectorDisplayModeRef = useRef(vectorDisplayMode)
  const animFrameRef = useRef(animFrame)
  const isAnimatingRef = useRef(isAnimating)
  const animSpeedRef = useRef(animSpeed)

  filterMinRef.current = filterMin
  filterMaxRef.current = filterMax
  opacityRef.current = opacity
  vectorDisplayModeRef.current = vectorDisplayMode
  animFrameRef.current = animFrame
  isAnimatingRef.current = isAnimating
  animSpeedRef.current = animSpeed

  const syncGridOpacity = useCallback(() => {
    const gridLayer = gridLayerRef.current
    if (!gridLayer) return
    const vectorActive = vectorDisplayModeRef.current !== 'none'
    gridLayer.setOpacity(vectorActive ? GPU_OPACITY_WITH_VECTOR : opacityRef.current)
  }, [])

  const applyFilter = useCallback(() => {
    gridLayerRef.current?.setFilter(filterMinRef.current, filterMaxRef.current)
    vectorContourLayerRef.current?.setFilter(filterMinRef.current, filterMaxRef.current)
  }, [])

  const applyOpacity = useCallback(() => {
    syncGridOpacity()
  }, [syncGridOpacity])

  const applyDisplayMode = useCallback((mode: GridDisplayMode) => {
    gridLayerRef.current?.setDisplayMode(mode)
  }, [])

  const applyVectorDisplayMode = useCallback(
    (mode: VectorContourDisplayMode) => {
      vectorContourLayerRef.current?.setDisplayMode(mode)
      syncGridOpacity()
    },
    [syncGridOpacity]
  )

  const applyVectorLabels = useCallback((show: boolean) => {
    vectorContourLayerRef.current?.setShowLabels(show)
  }, [])

  const stepAnimation = useCallback(() => {
    const gridLayer = gridLayerRef.current
    if (!gridLayer) return
    const nextFrame = (animFrameRef.current + 1) % ANIM_TOTAL_FRAMES
    animFrameRef.current = nextFrame
    setAnimFrame(nextFrame)
    const newData = generateGridData(nextFrame)
    gridLayer.updateData(newData)
    vectorContourLayerRef.current?.updateData(newData)
  }, [])

  const toggleAnimation = useCallback(() => {
    if (isAnimatingRef.current) {
      if (animTimerRef.current) {
        clearInterval(animTimerRef.current)
        animTimerRef.current = null
      }
      isAnimatingRef.current = false
      setIsAnimating(false)
    } else {
      isAnimatingRef.current = true
      setIsAnimating(true)
      animTimerRef.current = setInterval(() => {
        stepAnimation()
      }, animSpeedRef.current)
    }
  }, [stepAnimation])

  const resetAnimation = useCallback(() => {
    if (animTimerRef.current) {
      clearInterval(animTimerRef.current)
      animTimerRef.current = null
    }
    isAnimatingRef.current = false
    setIsAnimating(false)
    animFrameRef.current = 0
    setAnimFrame(0)
    const gridLayer = gridLayerRef.current
    if (gridLayer) {
      const newData = generateGridData(0)
      gridLayer.updateData(newData)
      vectorContourLayerRef.current?.updateData(newData)
    }
  }, [])

  useEffect(() => {
    if (!mapContainer.current) return

    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: MAP_STYLES.LIGHT,
      projection: 'mercator',
      center: [110, 30],
      zoom: 4
    })
    mapRef.current = map

    map.on('load', () => {
      const gridData = generateGridData(0)
      console.log(`[GridLayer2Demo] 格点数据: ${gridData.rows}行 × ${gridData.cols}列`)
      console.log(`[GridLayer2Demo] V2 优化: 仅 4 个顶点 + 2 个纹理`)

      const gridLayer = new GridLayer2({
        layerId: 'temperature-grid-v2',
        gridData,
        colorStops: COLOR_STOPS,
        opacity: opacityRef.current,
        filterMin: filterMinRef.current,
        filterMax: filterMaxRef.current,
        displayMode: displayMode
      })
      gridLayerRef.current = gridLayer
      map.addLayer(gridLayer)

      const vectorContourLayer = new GridVectorContourLayer({
        layerId: 'temperature-vector-contour',
        gridData,
        colorStops: COLOR_STOPS,
        displayMode: vectorDisplayModeRef.current,
        filterMin: filterMinRef.current,
        filterMax: filterMaxRef.current,
        showLabels: showVectorLabels,
        smoothIterations: 3,
        formatLabel: (v) => `${v}°C`
      })
      vectorContourLayerRef.current = vectorContourLayer
      vectorContourLayer.addTo(map)

      gridLayer.on('click', (info) => {
        setClickInfo(info)
      })
    })

    return () => {
      if (animTimerRef.current) {
        clearInterval(animTimerRef.current)
        animTimerRef.current = null
      }
      vectorContourLayerRef.current?.remove()
      vectorContourLayerRef.current = null
      map.remove()
      mapRef.current = null
      gridLayerRef.current = null
    }
  }, [])

  return (
    <div className="demo-container">
      <div ref={mapContainer} className="map-container" />

      {clickInfo && (
        <div className="click-info-card">
          <div className="card-header">
            <span>格点信息</span>
            <button type="button" className="close-btn" onClick={() => setClickInfo(null)}>
              ✕
            </button>
          </div>
          <div className="card-body">
            <div className="info-row">
              <span className="info-label">经度</span>
              <span>{clickInfo.lng.toFixed(4)}°</span>
            </div>
            <div className="info-row">
              <span className="info-label">纬度</span>
              <span>{clickInfo.lat.toFixed(4)}°</span>
            </div>
            <div className="info-row">
              <span className="info-label">行 / 列</span>
              <span>
                {clickInfo.row} / {clickInfo.col}
              </span>
            </div>
            <div className="info-row highlight">
              <span className="info-label">温度</span>
              <span>{clickInfo.value.toFixed(1)} °C</span>
            </div>
          </div>
        </div>
      )}

      <div className="control-panel">
        <div className="panel-card">
          <h4 className="panel-title">GPU 显示方式</h4>
          <div className="mode-options">
            {displayModes.map((mode) => (
              <label key={mode.value} className="mode-option">
                <input
                  type="radio"
                  name="displayMode"
                  value={mode.value}
                  checked={displayMode === mode.value}
                  onChange={() => {
                    setDisplayMode(mode.value)
                    applyDisplayMode(mode.value)
                  }}
                />
                <span>{mode.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="panel-card">
          <h4 className="panel-title">矢量等值线/面</h4>
          <div className="mode-options">
            {vectorDisplayModes.map((mode) => (
              <label key={mode.value} className="mode-option">
                <input
                  type="radio"
                  name="vectorDisplayMode"
                  value={mode.value}
                  checked={vectorDisplayMode === mode.value}
                  onChange={() => {
                    setVectorDisplayMode(mode.value)
                    applyVectorDisplayMode(mode.value)
                  }}
                />
                <span>{mode.label}</span>
              </label>
            ))}
          </div>
          <label className="mode-option checkbox-option">
            <input
              type="checkbox"
              checked={showVectorLabels}
              onChange={(e) => {
                setShowVectorLabels(e.target.checked)
                applyVectorLabels(e.target.checked)
              }}
            />
            <span>显示数值标注</span>
          </label>
        </div>

        <div className="panel-card">
          <h4 className="panel-title">温度 (°C)</h4>
          <div className="legend-items">
            {legendItems.map((item) => (
              <div key={item.label} className="legend-item">
                <span className="color-box" style={{ backgroundColor: item.hex }} />
                <span className="label">{item.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel-card">
          <h4 className="panel-title">温度过滤</h4>
          <div className="slider-group">
            <label>最低: {filterMin}°C</label>
            <input
              type="range"
              value={filterMin}
              min={TEMP_MIN}
              max={TEMP_MAX}
              step={1}
              onChange={(e) => {
                const v = Number(e.target.value)
                filterMinRef.current = v
                setFilterMin(v)
                applyFilter()
              }}
            />
          </div>
          <div className="slider-group">
            <label>最高: {filterMax}°C</label>
            <input
              type="range"
              value={filterMax}
              min={TEMP_MIN}
              max={TEMP_MAX}
              step={1}
              onChange={(e) => {
                const v = Number(e.target.value)
                filterMaxRef.current = v
                setFilterMax(v)
                applyFilter()
              }}
            />
          </div>
          <div className="range-display">
            显示范围：{filterMin}°C ~ {filterMax}°C
          </div>
        </div>

        <div className="panel-card">
          <h4 className="panel-title">透明度</h4>
          <div className="slider-group">
            <label>{Math.round(opacity * 100)}%</label>
            <input
              type="range"
              value={opacity}
              min={0}
              max={1}
              step={0.05}
              onChange={(e) => {
                const v = Number(e.target.value)
                opacityRef.current = v
                setOpacity(v)
                applyOpacity()
              }}
            />
          </div>
        </div>

        <div className="panel-card">
          <h4 className="panel-title">⏱ 时间动画 (texSubImage2D)</h4>
          <div className="animation-info">
            帧: {animFrame} / {ANIM_TOTAL_FRAMES}
          </div>
          <div className="btn-row">
            <button
              type="button"
              className={`ctrl-btn${isAnimating ? ' active' : ''}`}
              onClick={toggleAnimation}
            >
              {isAnimating ? '⏸ 暂停' : '▶ 播放'}
            </button>
            <button type="button" className="ctrl-btn" onClick={resetAnimation}>
              ⏹ 重置
            </button>
          </div>
          <div className="slider-group">
            <label>速度: {animSpeed}ms/帧</label>
            <input
              type="range"
              value={animSpeed}
              min={50}
              max={1000}
              step={50}
              onChange={(e) => setAnimSpeed(Number(e.target.value))}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
