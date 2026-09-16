import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MAPBOX_ACCESS_TOKEN, MAP_STYLES } from '@/config/mapbox'
import './Grid3dDemo.css'

interface ColorStopHex {
  value: number
  color: string
}

const COLOR_STOPS: ColorStopHex[] = [
  { value: -20, color: '#313695' },
  { value: -10, color: '#4575b4' },
  { value: 0, color: '#74add1' },
  { value: 10, color: '#abd9e9' },
  { value: 15, color: '#e0f3f8' },
  { value: 20, color: '#fee090' },
  { value: 25, color: '#fdae61' },
  { value: 30, color: '#f46d43' },
  { value: 35, color: '#d73027' },
  { value: 40, color: '#a50026' }
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

function generateGridData() {
  const lonStart = 100
  const latStart = 20
  const lonStep = 0.5
  const latStep = 0.5
  const rows = 20
  const cols = 40

  const values: number[][] = []
  for (let row = 0; row < rows; row++) {
    const rowData: number[] = []
    for (let col = 0; col < cols; col++) {
      const lon = lonStart + col * lonStep
      const lat = latStart + row * latStep
      const base = 35 - (lat - 20) * 0.8
      const noise = Math.sin(lon * 0.5) * 3 + Math.cos(lat * 0.3) * 2
      rowData.push(Math.round((base + noise) * 10) / 10)
    }
    values.push(rowData)
  }

  return { lonStart, latStart, lonStep, latStep, rows, cols, values }
}

function gridToGeoJSON(
  gridData: ReturnType<typeof generateGridData>,
  scale: number
): GeoJSON.FeatureCollection {
  const { lonStart, latStart, lonStep, latStep, rows, cols, values } = gridData
  const features: GeoJSON.Feature[] = []

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const value = values[row]![col]!
      const lon = lonStart + col * lonStep
      const lat = latStart + row * latStep

      features.push({
        type: 'Feature',
        properties: {
          value,
          height: Math.max(0, (value + 20) * scale)
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [lon, lat],
              [lon + lonStep, lat],
              [lon + lonStep, lat + latStep],
              [lon, lat + latStep],
              [lon, lat]
            ]
          ]
        }
      })
    }
  }

  return { type: 'FeatureCollection', features }
}

function buildColorExpression(): mapboxgl.Expression {
  const expr: unknown[] = ['interpolate', ['linear'], ['get', 'value']]
  for (const stop of COLOR_STOPS) {
    expr.push(stop.value, stop.color)
  }
  return expr as mapboxgl.Expression
}

export default function Grid3dDemo() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const gridDataRef = useRef<ReturnType<typeof generateGridData> | null>(null)

  const [heightScale, setHeightScale] = useState(5000)
  const [opacity, setOpacity] = useState(0.85)
  const [filterMin, setFilterMin] = useState(-20)
  const [filterMax, setFilterMax] = useState(50)
  const [clickInfo, setClickInfo] = useState<{ lng: number; lat: number; value: number } | null>(
    null
  )

  const heightScaleRef = useRef(heightScale)
  const opacityRef = useRef(opacity)
  const filterMinRef = useRef(filterMin)
  const filterMaxRef = useRef(filterMax)
  heightScaleRef.current = heightScale
  opacityRef.current = opacity
  filterMinRef.current = filterMin
  filterMaxRef.current = filterMax

  const updateHeightScale = () => {
    const map = mapRef.current
    const gridData = gridDataRef.current
    if (!map || !gridData) return
    const geojson = gridToGeoJSON(gridData, heightScaleRef.current)
    const source = map.getSource('grid-3d') as mapboxgl.GeoJSONSource | undefined
    if (source) {
      source.setData(geojson)
    }
  }

  const updateOpacity = () => {
    const map = mapRef.current
    if (!map) return
    map.setPaintProperty('grid-3d-extrusion', 'fill-extrusion-opacity', opacityRef.current)
  }

  const updateFilter = () => {
    const map = mapRef.current
    if (!map) return
    map.setFilter('grid-3d-extrusion', [
      'all',
      ['>=', ['get', 'value'], filterMinRef.current],
      ['<=', ['get', 'value'], filterMaxRef.current]
    ])
  }

  useEffect(() => {
    if (!mapContainer.current) return

    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: MAP_STYLES.LIGHT,
      center: [110, 30],
      zoom: 4,
      pitch: 55,
      bearing: -15,
      antialias: true
    })
    mapRef.current = map

    map.addControl(new mapboxgl.NavigationControl(), 'top-right')

    map.on('load', () => {
      const gridData = generateGridData()
      gridDataRef.current = gridData
      const geojson = gridToGeoJSON(gridData, heightScaleRef.current)

      map.addSource('grid-3d', {
        type: 'geojson',
        data: geojson
      })

      map.addLayer({
        id: 'grid-3d-extrusion',
        type: 'fill-extrusion',
        source: 'grid-3d',
        paint: {
          'fill-extrusion-color': buildColorExpression(),
          'fill-extrusion-height': ['get', 'height'],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': opacityRef.current
        }
      })

      map.on('click', 'grid-3d-extrusion', (e) => {
        if (e.features && e.features.length > 0) {
          const props = e.features[0]!.properties!
          setClickInfo({
            lng: e.lngLat.lng,
            lat: e.lngLat.lat,
            value: props.value
          })
        }
      })

      map.on('mouseenter', 'grid-3d-extrusion', () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', 'grid-3d-extrusion', () => {
        map.getCanvas().style.cursor = ''
      })
    })

    return () => {
      map.remove()
      mapRef.current = null
      gridDataRef.current = null
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
            <div className="info-row highlight">
              <span className="info-label">温度</span>
              <span>{clickInfo.value.toFixed(1)} °C</span>
            </div>
            <div className="info-row">
              <span className="info-label">高度</span>
              <span>{Math.round(clickInfo.value * heightScale)} m</span>
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
          <h4 className="panel-title">高度缩放</h4>
          <div className="slider-group">
            <label>倍率: {heightScale}x</label>
            <input
              type="range"
              value={heightScale}
              min={500}
              max={20000}
              step={500}
              onChange={(e) => {
                const v = Number(e.target.value)
                heightScaleRef.current = v
                setHeightScale(v)
                updateHeightScale()
              }}
            />
          </div>
        </div>

        <div className="panel-card">
          <h4 className="panel-title">透明度</h4>
          <div className="slider-group">
            <label>{Math.round(opacity * 100)}%</label>
            <input
              type="range"
              value={opacity}
              min={0.1}
              max={1}
              step={0.05}
              onChange={(e) => {
                const v = Number(e.target.value)
                opacityRef.current = v
                setOpacity(v)
                updateOpacity()
              }}
            />
          </div>
        </div>

        <div className="panel-card">
          <h4 className="panel-title">温度过滤</h4>
          <div className="slider-group">
            <label>最低: {filterMin}°C</label>
            <input
              type="range"
              value={filterMin}
              min={-20}
              max={50}
              step={1}
              onChange={(e) => {
                const v = Number(e.target.value)
                filterMinRef.current = v
                setFilterMin(v)
                updateFilter()
              }}
            />
          </div>
          <div className="slider-group">
            <label>最高: {filterMax}°C</label>
            <input
              type="range"
              value={filterMax}
              min={-20}
              max={50}
              step={1}
              onChange={(e) => {
                const v = Number(e.target.value)
                filterMaxRef.current = v
                setFilterMax(v)
                updateFilter()
              }}
            />
          </div>
          <div className="range-display">
            显示范围：{filterMin}°C ~ {filterMax}°C
          </div>
        </div>
      </div>
    </div>
  )
}
