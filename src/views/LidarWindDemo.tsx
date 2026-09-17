import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MAPBOX_ACCESS_TOKEN, MAP_STYLES } from '@/config/mapbox'
import { createLidarWindLayer, type LidarLayerParams } from '@/layers/LidarWindLayer'
import { loadLidarDataset, type LidarDataset, type LidarSample } from '@/utils/lidarCsvParser'
import {
  buildLidarSampleIndex,
  queryLidarAtLngLat,
  type LidarHoverInfo,
} from '@/utils/lidarQuery'
import styles from './LidarWindDemo.module.css'

interface HoverState {
  x: number
  y: number
  info: LidarHoverInfo
}

export default function LidarWindDemo() {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const layerAddedRef = useRef(false)
  const sampleIndexRef = useRef<Map<string, LidarSample> | null>(null)

  const [dataset, setDataset] = useState<LidarDataset | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [showPoints, setShowPoints] = useState(true)
  const [showSurface, setShowSurface] = useState(true)
  const [showWindBarbs, setShowWindBarbs] = useState(true)
  const [showScanBeam, setShowScanBeam] = useState(true)
  const [showRangeRings, setShowRangeRings] = useState(true)
  const [interpolateSurface, setInterpolateSurface] = useState(false)
  const [pointSize, setPointSize] = useState(6)
  const [pointOpacity, setPointOpacity] = useState(0.9)
  const [surfaceOpacity, setSurfaceOpacity] = useState(0.45)
  const [barbScale, setBarbScale] = useState(1.2)
  const [scanSpeed, setScanSpeed] = useState(8)
  const [beamOpacity, setBeamOpacity] = useState(1.5)
  const [heightExaggeration, setHeightExaggeration] = useState(3.5)
  const [colorMode, setColorMode] = useState<'speed' | 'direction'>('speed')
  const [scanAngle, setScanAngle] = useState(0)
  const [hover, setHover] = useState<HoverState | null>(null)

  const paramsRef = useRef<LidarLayerParams>({
    showPoints,
    showSurface,
    showWindBarbs,
    showScanBeam,
    showRangeRings,
    interpolateSurface,
    pointSize,
    pointOpacity,
    surfaceOpacity,
    barbScale,
    scanSpeed,
    beamOpacity,
    heightExaggeration,
    colorMode,
  })

  paramsRef.current = {
    showPoints,
    showSurface,
    showWindBarbs,
    showScanBeam,
    showRangeRings,
    interpolateSurface,
    pointSize,
    pointOpacity,
    surfaceOpacity,
    barbScale,
    scanSpeed,
    beamOpacity,
    heightExaggeration,
    colorMode,
  }

  const triggerRepaint = () => mapRef.current?.triggerRepaint()

  useEffect(() => {
    let cancelled = false
    loadLidarDataset()
      .then((data) => {
        if (!cancelled) {
          setDataset(data)
          sampleIndexRef.current = buildLidarSampleIndex(data)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '数据加载失败')
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!mapContainerRef.current || !dataset) return

    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN
    const { metadata } = dataset

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLES.DARK,
      center: [metadata.longitude, metadata.latitude],
      zoom: 12.4,
      pitch: 62,
      bearing: -35,
      antialias: true,
    })

    mapRef.current = map
    map.addControl(new mapboxgl.NavigationControl(), 'top-right')

    const onMouseMove = (e: mapboxgl.MapMouseEvent) => {
      const index = sampleIndexRef.current
      if (!index) return

      const info = queryLidarAtLngLat(dataset, index, e.lngLat.lng, e.lngLat.lat)
      if (!info) {
        setHover(null)
        map.getCanvas().style.cursor = ''
        return
      }

      map.getCanvas().style.cursor = 'crosshair'
      setHover({
        x: e.point.x,
        y: e.point.y,
        info,
      })
    }

    const onMouseLeave = () => {
      setHover(null)
      map.getCanvas().style.cursor = ''
    }

    map.on('mousemove', onMouseMove)
    map.on('mouseleave', onMouseLeave)

    map.on('load', () => {
      map.addLayer(createLidarWindLayer(mapRef, dataset, paramsRef))
      layerAddedRef.current = true

      map.addSource('lidar-site', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [metadata.longitude, metadata.latitude] },
          properties: { name: metadata.model },
        },
      })

      map.addLayer({
        id: 'lidar-site-glow',
        type: 'circle',
        source: 'lidar-site',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 8, 14, 24],
          'circle-color': '#00f0ff',
          'circle-opacity': 0.15,
          'circle-blur': 1,
        },
      })

      map.addLayer({
        id: 'lidar-site-core',
        type: 'circle',
        source: 'lidar-site',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 8],
          'circle-color': '#00ffcc',
          'circle-opacity': 0.95,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      })
    })

    const minAz = Math.min(...dataset.azimuths)
    const maxAz = Math.max(...dataset.azimuths)
    const azSpan = maxAz - minAz

    let animId = 0
    const tick = () => {
      const t = performance.now() / 1000
      const speed = paramsRef.current.scanSpeed
      const progress = (t * speed) / 60
      setScanAngle(minAz + (progress % 1) * azSpan)
      animId = requestAnimationFrame(tick)
    }
    animId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(animId)
      map.off('mousemove', onMouseMove)
      map.off('mouseleave', onMouseLeave)
      map.remove()
      mapRef.current = null
      layerAddedRef.current = false
    }
  }, [dataset])

  useEffect(() => {
    triggerRepaint()
  }, [
    showPoints,
    showSurface,
    showWindBarbs,
    showScanBeam,
    showRangeRings,
    interpolateSurface,
    pointSize,
    surfaceOpacity,
    barbScale,
    scanSpeed,
    beamOpacity,
    heightExaggeration,
    colorMode,
  ])

  const meta = dataset?.metadata

  return (
    <div className={styles.demoContainer}>
      <div ref={mapContainerRef} className={styles.mapContainer} />

      <div className={styles.scanlineOverlay} aria-hidden />

      {hover && (
        <div
          className={styles.hoverTooltip}
          style={{ left: hover.x + 16, top: hover.y + 16 }}
        >
          <div className={styles.tooltipHeader}>距离门格心</div>
          <div className={styles.tooltipRow}>
            <span>方位角</span>
            <strong>{hover.info.queryAzimuth.toFixed(0)}°</strong>
          </div>
          <div className={styles.tooltipRow}>
            <span>斜距</span>
            <strong>{hover.info.sample.distance} m</strong>
          </div>
          <div className={styles.tooltipRow}>
            <span>水平风速</span>
            <strong>
              {hover.info.sample.hWindSpeed !== null
                ? `${hover.info.sample.hWindSpeed.toFixed(2)} m/s`
                : '—'}
            </strong>
          </div>
          <div className={styles.tooltipRow}>
            <span>水平风向</span>
            <strong>
              {hover.info.sample.hWindDirection !== null
                ? `${hover.info.sample.hWindDirection.toFixed(1)}°`
                : '—'}
            </strong>
          </div>
          <div className={styles.tooltipRow}>
            <span>垂直风速</span>
            <strong>
              {hover.info.sample.vWindSpeed !== null
                ? `${hover.info.sample.vWindSpeed.toFixed(2)} m/s`
                : '—'}
            </strong>
          </div>
          <div className={styles.tooltipCoords}>
            {hover.info.lat.toFixed(4)}°N, {hover.info.lng.toFixed(4)}°E
          </div>
        </div>
      )}

      <div className={styles.hudTop}>
        <div className={styles.hudBrand}>
          <span className={styles.hudDot} />
          CDWL LiDAR · PPI SCAN
        </div>
        <div className={styles.hudStats}>
          {meta && (
            <>
              <span>{meta.model}</span>
              <span className={styles.hudDivider}>|</span>
              <span>{meta.scanMode}</span>
              <span className={styles.hudDivider}>|</span>
              <span>
                {meta.azimuthFrom}°–{meta.azimuthTo}° Δ{meta.azimuthStep}°
              </span>
            </>
          )}
        </div>
      </div>

      <div className={styles.hudLeft}>
        <div className={styles.radarDial}>
          <svg viewBox="0 0 120 120" className={styles.radarSvg}>
            <circle cx="60" cy="60" r="54" fill="none" stroke="rgba(0,240,255,0.2)" strokeWidth="1" />
            <circle cx="60" cy="60" r="36" fill="none" stroke="rgba(0,240,255,0.12)" strokeWidth="1" />
            <circle cx="60" cy="60" r="18" fill="none" stroke="rgba(0,240,255,0.08)" strokeWidth="1" />
            <line x1="60" y1="60" x2="60" y2="8" stroke="rgba(0,240,255,0.3)" strokeWidth="1" />
            <line x1="60" y1="60" x2="112" y2="60" stroke="rgba(0,240,255,0.3)" strokeWidth="1" />
            <g transform={`rotate(${scanAngle} 60 60)`}>
              <line x1="60" y1="60" x2="60" y2="10" stroke="#00ffcc" strokeWidth="2" />
              <polygon points="60,10 56,18 64,18" fill="#00ffcc" opacity="0.8" />
            </g>
            <circle cx="60" cy="60" r="3" fill="#00ffcc" />
          </svg>
          <div className={styles.radarLabel}>AZ {scanAngle.toFixed(0)}°</div>
        </div>

        {dataset && (
          <div className={styles.dataPanel}>
            <div className={styles.dataRow}>
              <span>有效回波</span>
              <strong>{dataset.validSamples.length.toLocaleString()}</strong>
            </div>
            <div className={styles.dataRow}>
              <span>覆盖距离</span>
              <strong>{(dataset.maxValidDistance / 1000).toFixed(1)} km</strong>
            </div>
            <div className={styles.dataRow}>
              <span>风速范围</span>
              <strong>
                {dataset.windSpeedMin.toFixed(1)} – {dataset.windSpeedMax.toFixed(1)} m/s
              </strong>
            </div>
            <div className={styles.dataRow}>
              <span>仰角</span>
              <strong>{meta?.fixAngle}°</strong>
            </div>
          </div>
        )}
      </div>

      <div className={styles.legendStack}>
        <div className={styles.legend}>
          <div className={styles.legendTitle}>
            {colorMode === 'speed' ? '水平风速 (m/s)' : '风向 (°)'}
          </div>
          <div className={styles.legendBar}>
            {colorMode === 'speed' ? (
              <>
                <span>0</span>
                <div className={styles.gradientSpeed} />
                <span>{dataset?.windSpeedMax.toFixed(1) ?? '—'}</span>
              </>
            ) : (
              <>
                <span>N</span>
                <div className={styles.gradientDir} />
                <span>360°</span>
              </>
            )}
          </div>
        </div>

        {showWindBarbs && (
          <div className={styles.legend}>
            <div className={styles.legendTitle}>风杆图例（北半球）</div>
            <svg viewBox="0 0 168 86" className={styles.barbLegendSvg} aria-hidden>
              <g fill="none" stroke="#0066FF" strokeWidth="1.6" strokeLinecap="round">
                <circle cx="18" cy="28" r="7" />
                <text x="32" y="32" fill="#8899aa" fontSize="10" stroke="none">
                  静风
                </text>

                <line x1="78" y1="28" x2="78" y2="8" />
                <line x1="78" y1="14" x2="70" y2="17" />
                <text x="90" y="32" fill="#8899aa" fontSize="10" stroke="none">
                  2 m/s 短划
                </text>

                <line x1="18" y1="66" x2="18" y2="42" />
                <line x1="18" y1="42" x2="8" y2="47" />
                <text x="32" y="70" fill="#8899aa" fontSize="10" stroke="none">
                  4 m/s 长划
                </text>

                <line x1="98" y1="66" x2="98" y2="42" />
                <polygon points="98,42 88,47 98,51" fill="#0066FF" stroke="none" />
                <text x="112" y="70" fill="#8899aa" fontSize="10" stroke="none">
                  20 m/s 旗
                </text>
              </g>
            </svg>
            <div className={styles.legendHint}>杆指向风的来向 · 风羽在杆左侧</div>
          </div>
        )}
      </div>

      <div className={styles.controlPanel}>
        <h3>探测激光雷达</h3>

        {loading && <p className={styles.statusText}>正在加载 PPI 扫描数据…</p>}
        {error && <p className={styles.errorText}>{error}</p>}

        <div className={styles.panelSection}>
          <h4>图层</h4>
          {(
            [
              ['点云辉光', showPoints, setShowPoints],
              ['PPI 曲面', showSurface, setShowSurface],
              ['风杆图', showWindBarbs, setShowWindBarbs],
              ['扫描波束', showScanBeam, setShowScanBeam],
              ['距离环', showRangeRings, setShowRangeRings],
            ] as const
          ).map(([label, checked, setter]) => (
            <label key={label} className={styles.checkRow}>
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => {
                  setter(e.target.checked)
                  triggerRepaint()
                }}
              />
              {label}
            </label>
          ))}
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={interpolateSurface}
              disabled={!showSurface}
              onChange={(e) => {
                setInterpolateSurface(e.target.checked)
                triggerRepaint()
              }}
            />
            格心插值
          </label>
        </div>

        <div className={styles.panelSection}>
          <h4>着色</h4>
          <div className={styles.modeRow}>
            <button
              type="button"
              className={colorMode === 'speed' ? styles.modeActive : ''}
              onClick={() => setColorMode('speed')}
            >
              风速
            </button>
            <button
              type="button"
              className={colorMode === 'direction' ? styles.modeActive : ''}
              onClick={() => setColorMode('direction')}
            >
              风向
            </button>
          </div>
        </div>

        <div className={styles.panelSection}>
          <h4>参数</h4>
          <div className={styles.sliderGroup}>
            <label>点大小: {pointSize.toFixed(0)}</label>
            <input
              type="range"
              min={2}
              max={14}
              step={1}
              value={pointSize}
              onChange={(e) => {
                setPointSize(Number(e.target.value))
                triggerRepaint()
              }}
            />
          </div>
          <div className={styles.sliderGroup}>
            <label>高度放大: {heightExaggeration.toFixed(1)}×</label>
            <input
              type="range"
              min={1}
              max={8}
              step={0.5}
              value={heightExaggeration}
              onChange={(e) => {
                setHeightExaggeration(Number(e.target.value))
                triggerRepaint()
              }}
            />
          </div>
          <div className={styles.sliderGroup}>
            <label>曲面不透明度: {surfaceOpacity.toFixed(2)}</label>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={surfaceOpacity}
              onChange={(e) => {
                setSurfaceOpacity(Number(e.target.value))
                triggerRepaint()
              }}
            />
          </div>
          <div className={styles.sliderGroup}>
            <label>风杆大小: {barbScale.toFixed(1)}×</label>
            <input
              type="range"
              min={0.5}
              max={3}
              step={0.1}
              value={barbScale}
              disabled={!showWindBarbs}
              onChange={(e) => {
                setBarbScale(Number(e.target.value))
                triggerRepaint()
              }}
            />
          </div>
          <div className={styles.sliderGroup}>
            <label>波束不透明度: {beamOpacity.toFixed(2)}</label>
            <input
              type="range"
              min={0.2}
              max={2}
              step={0.05}
              value={beamOpacity}
              disabled={!showScanBeam}
              onChange={(e) => {
                setBeamOpacity(Number(e.target.value))
                triggerRepaint()
              }}
            />
          </div>
          <div className={styles.sliderGroup}>
            <label>扫描速度: {scanSpeed.toFixed(0)} rpm</label>
            <input
              type="range"
              min={2}
              max={20}
              step={1}
              value={scanSpeed}
              onChange={(e) => setScanSpeed(Number(e.target.value))}
            />
          </div>
        </div>

        {meta && (
          <div className={styles.infoBlock}>
            <p>
              站点 {meta.latitude.toFixed(4)}°N, {meta.longitude.toFixed(4)}°E
            </p>
            <p>海拔 {meta.seaHeight} m · 距离分辨率 {meta.rangeResolution} m</p>
          </div>
        )}
      </div>
    </div>
  )
}
