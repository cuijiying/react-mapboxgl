import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MAPBOX_ACCESS_TOKEN, MAP_STYLES } from '@/config/mapbox'
import { WindLayer, generateChinaWindData } from '@/layers/WindLayer'
import './demo-common.css'
import './WindFieldDemo.css'

export default function WindFieldDemo() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const windLayerRef = useRef<WindLayer | null>(null)

  const [particleCount, setParticleCount] = useState(8000)
  const [speedFactor, setSpeedFactor] = useState(0.25)
  const [fadeOpacity, setFadeOpacity] = useState(0.96)
  const [particleSize, setParticleSize] = useState(2)
  const [opacity, setOpacity] = useState(0.9)
  const [dropRate, setDropRate] = useState(0.003)
  const [dropRateBump, setDropRateBump] = useState(0.01)
  const [maxAge, setMaxAge] = useState(100)
  const [windDataInfo, setWindDataInfo] = useState({
    cols: 0,
    rows: 0,
    uRange: '',
    vRange: '',
    bounds: '',
  })

  useEffect(() => {
    if (!mapContainer.current) return

    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: MAP_STYLES.DARK,
      projection: 'mercator',
      center: [104, 35],
      zoom: 3.5,
    })

    map.on('load', () => {
      const windData = generateChinaWindData(120, 90)
      console.log(`[WindFieldDemo] 风场数据: ${windData.width}×${windData.height}`)

      setWindDataInfo({
        cols: windData.width,
        rows: windData.height,
        uRange: `${windData.uMin.toFixed(1)} ~ ${windData.uMax.toFixed(1)} m/s`,
        vRange: `${windData.vMin.toFixed(1)} ~ ${windData.vMax.toFixed(1)} m/s`,
        bounds: `${windData.bounds[0]}°E ~ ${windData.bounds[2]}°E, ${windData.bounds[1]}°N ~ ${windData.bounds[3]}°N`,
      })

      const windLayer = new WindLayer({
        id: 'wind-field',
        windData,
        particleCount,
        speedFactor,
        fadeOpacity,
        particleSize,
        opacity,
        dropRate,
        dropRateBump,
        maxAge,
      })

      windLayerRef.current = windLayer
      map.addLayer(windLayer)
    })

    return () => {
      map.remove()
      windLayerRef.current = null
    }
  }, [])

  return (
    <div className="wind-demo-container">
      <div ref={mapContainer} className="map-container" />

      <div className="wind-control-panel">
        <div className="wind-panel-card">
          <h4 className="wind-panel-title">风场参数调试</h4>

          <div className="wind-slider-group">
            <label>
              粒子数量: <strong>{particleCount}</strong>
            </label>
            <input
              type="range"
              min={500}
              max={30000}
              step={500}
              value={particleCount}
              onChange={(e) => {
                const value = Number(e.target.value)
                setParticleCount(value)
                windLayerRef.current?.setParticleCount(value)
              }}
            />
          </div>

          <div className="wind-slider-group">
            <label>
              速度系数: <strong>{speedFactor.toFixed(2)}</strong>
            </label>
            <input
              type="range"
              min={0.01}
              max={2}
              step={0.01}
              value={speedFactor}
              onChange={(e) => {
                const value = Number(e.target.value)
                setSpeedFactor(value)
                windLayerRef.current?.setSpeedFactor(value)
              }}
            />
          </div>

          <div className="wind-slider-group">
            <label>
              拖尾淡出: <strong>{fadeOpacity.toFixed(3)}</strong>
            </label>
            <input
              type="range"
              min={0.9}
              max={0.999}
              step={0.001}
              value={fadeOpacity}
              onChange={(e) => {
                const value = Number(e.target.value)
                setFadeOpacity(value)
                windLayerRef.current?.setFadeOpacity(value)
              }}
            />
          </div>

          <div className="wind-slider-group">
            <label>
              粒子大小: <strong>{particleSize.toFixed(1)}</strong>
            </label>
            <input
              type="range"
              min={0.5}
              max={8}
              step={0.5}
              value={particleSize}
              onChange={(e) => {
                const value = Number(e.target.value)
                setParticleSize(value)
                windLayerRef.current?.setParticleSize(value)
              }}
            />
          </div>

          <div className="wind-slider-group">
            <label>
              不透明度: <strong>{opacity.toFixed(2)}</strong>
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={opacity}
              onChange={(e) => {
                const value = Number(e.target.value)
                setOpacity(value)
                windLayerRef.current?.setOpacity(value)
              }}
            />
          </div>

          <div className="wind-slider-group">
            <label>
              消亡率: <strong>{dropRate.toFixed(4)}</strong>
            </label>
            <input
              type="range"
              min={0}
              max={0.05}
              step={0.001}
              value={dropRate}
              onChange={(e) => {
                const value = Number(e.target.value)
                setDropRate(value)
                windLayerRef.current?.setDropRate(value)
              }}
            />
          </div>

          <div className="wind-slider-group">
            <label>
              速度消亡率: <strong>{dropRateBump.toFixed(3)}</strong>
            </label>
            <input
              type="range"
              min={0}
              max={0.2}
              step={0.005}
              value={dropRateBump}
              onChange={(e) => {
                const value = Number(e.target.value)
                setDropRateBump(value)
                windLayerRef.current?.setDropRateBump(value)
              }}
            />
          </div>

          <div className="wind-slider-group">
            <label>
              最大存活帧: <strong>{maxAge}</strong>
            </label>
            <input
              type="range"
              min={10}
              max={300}
              step={5}
              value={maxAge}
              onChange={(e) => {
                const value = Number(e.target.value)
                setMaxAge(value)
                windLayerRef.current?.setMaxAge(value)
              }}
            />
          </div>
        </div>

        <div className="wind-panel-card">
          <h4 className="wind-panel-title">风速颜色</h4>
          <div className="wind-legend-bar" />
          <div className="wind-legend-labels">
            <span>低速</span>
            <span>高速</span>
          </div>
        </div>

        <div className="wind-panel-card wind-info-card">
          <h4 className="wind-panel-title">数据信息</h4>
          <div className="wind-info-row">
            <span className="wind-info-label">网格</span>
            <span>
              {windDataInfo.cols} × {windDataInfo.rows}
            </span>
          </div>
          <div className="wind-info-row">
            <span className="wind-info-label">U 范围</span>
            <span>{windDataInfo.uRange}</span>
          </div>
          <div className="wind-info-row">
            <span className="wind-info-label">V 范围</span>
            <span>{windDataInfo.vRange}</span>
          </div>
          <div className="wind-info-row">
            <span className="wind-info-label">覆盖范围</span>
            <span>{windDataInfo.bounds}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
