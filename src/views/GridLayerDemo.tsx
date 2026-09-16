/**
 * GridLayerDemo.tsx
 *
 * 演示如何使用通用 GridLayer 图层：
 *  1. 生成模拟温度格点数据
 *  2. 构造 GridLayer 实例并添加到地图
 *  3. 通过面板实时调整过滤范围和透明度
 *  4. 使用 onClick 回调展示格点信息
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MAPBOX_ACCESS_TOKEN, MAP_STYLES } from '@/config/mapbox'
import { GridLayer, type GridData, type ColorStop, type GridClickInfo } from '@/layers/GridLayer'
import './GridLayerDemo.css'

const TEMP_MIN = -20
const TEMP_MAX = 50

const COLOR_STOPS: (ColorStop & { hex: string })[] = [
  { value: -20, color: [0.192, 0.212, 0.584, 1.0], hex: '#313695' },
  { value: -10, color: [0.271, 0.459, 0.706, 1.0], hex: '#4575b4' },
  { value: 0, color: [0.455, 0.678, 0.820, 1.0], hex: '#74add1' },
  { value: 10, color: [0.671, 0.851, 0.914, 1.0], hex: '#abd9e9' },
  { value: 15, color: [0.878, 0.953, 0.973, 1.0], hex: '#e0f3f8' },
  { value: 20, color: [0.996, 0.878, 0.565, 1.0], hex: '#fee090' },
  { value: 25, color: [0.992, 0.682, 0.380, 1.0], hex: '#fdae61' },
  { value: 30, color: [0.957, 0.427, 0.263, 1.0], hex: '#f46d43' },
  { value: 35, color: [0.843, 0.188, 0.153, 1.0], hex: '#d73027' },
  { value: 40, color: [0.647, 0.000, 0.149, 1.0], hex: '#a50026' }
]

const legendItems = [
  { hex: '#313695', label: '≤ -10' },
  { hex: '#4575b4', label: '-10 ~ 0' },
  { hex: '#74add1', label: '0 ~ 10' },
  { hex: '#abd9e9', label: '10 ~ 15' },
  { hex: '#e0f3f8', label: '15 ~ 20' },
  { hex: '#fee090', label: '20 ~ 25' },
  { hex: '#fdae61', label: '25 ~ 30' },
  { hex: '#f46d43', label: '30 ~ 35' },
  { hex: '#d73027', label: '35 ~ 40' },
  { hex: '#a50026', label: '> 40' }
]

function generateGridData(): GridData {
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
      const base = 35 - (lat - 20) * 0.8
      const noise =
        Math.sin(lon * 0.5) * 3 +
        Math.cos(lat * 0.3) * 2
      rowData.push(Math.round((base + noise) * 10) / 10)
    }
    values.push(rowData)
  }

  return { lonStart, latStart, lonStep, latStep, rows, cols, values }
}

export default function GridLayerDemo() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const gridLayerRef = useRef<GridLayer | null>(null)

  const [filterMin, setFilterMin] = useState(TEMP_MIN)
  const [filterMax, setFilterMax] = useState(TEMP_MAX)
  const [opacity, setOpacity] = useState(0.85)
  const [clickInfo, setClickInfo] = useState<GridClickInfo | null>(null)

  const filterMinRef = useRef(filterMin)
  const filterMaxRef = useRef(filterMax)
  const opacityRef = useRef(opacity)
  filterMinRef.current = filterMin
  filterMaxRef.current = filterMax
  opacityRef.current = opacity

  const applyFilter = useCallback(() => {
    const gridLayer = gridLayerRef.current
    if (!gridLayer) return
    gridLayer.setFilter(filterMinRef.current, filterMaxRef.current)
  }, [])

  const applyOpacity = useCallback(() => {
    const gridLayer = gridLayerRef.current
    if (!gridLayer) return
    gridLayer.setOpacity(opacityRef.current)
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
      const gridData = generateGridData()
      console.log(`[GridLayerDemo] 格点数据: ${gridData.rows}行 × ${gridData.cols}列`)

      const gridLayer = new GridLayer({
        layerId: 'temperature-grid',
        gridData,
        colorStops: COLOR_STOPS,
        opacity: opacityRef.current,
        filterMin: filterMinRef.current,
        filterMax: filterMaxRef.current,
        onClick: (info) => {
          setClickInfo(info)
        }
      })
      gridLayerRef.current = gridLayer
      map.addLayer(gridLayer)
    })

    return () => {
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
      </div>
    </div>
  )
}
