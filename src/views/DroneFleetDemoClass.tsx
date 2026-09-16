import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MAPBOX_ACCESS_TOKEN, MAP_STYLES } from '@/config/mapbox'
import { DroneFleetLayer, type DroneFleetConfig } from '@/layers/DroneFleetLayer'
import droneModelUrl from '@/images/evtol.glb?url'
import './DroneFleetHud.css'

const ORIGIN: [number, number] = [116.3912, 39.9055]
const REFERENCE_ZOOM = 14

export default function DroneFleetDemoClass() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const fleetRef = useRef<DroneFleetLayer | null>(null)

  const [onlineCount, setOnlineCount] = useState(0)
  const [offlineCount, setOfflineCount] = useState(0)
  const [currentZoom, setCurrentZoom] = useState(REFERENCE_ZOOM)
  const [cfg, setCfg] = useState<DroneFleetConfig>({
    onlineColor: '#29ffd0',
    offlineColor: '#5b6b7a',
    trailColorMode: 'status',
    trailColor: '#29ffd0',
    trailWidth: 3,
    speedFactor: 1,
    onlineRatio: 0.68,
    sizeFactor: 1,
    zoomAdaptive: true,
    showTrails: true,
    showDropLines: true,
    showHalo: true,
    flying: true,
    blink: true
  })

  const cfgRef = useRef(cfg)
  cfgRef.current = cfg

  const updateCfg = (patch: Partial<DroneFleetConfig>) => {
    setCfg((prev) => ({ ...prev, ...patch }))
  }

  useEffect(() => {
    if (!mapContainer.current) return

    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN
    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: MAP_STYLES.DARK,
      center: ORIGIN,
      zoom: REFERENCE_ZOOM,
      pitch: 58,
      bearing: -22,
      antialias: true
    })
    mapRef.current = map

    map.addControl(new mapboxgl.NavigationControl(), 'top-right')
    map.on('zoom', () => {
      setCurrentZoom(map.getZoom())
    })

    map.on('style.load', () => {
      const fleet = new DroneFleetLayer(map, {
        origin: ORIGIN,
        referenceZoom: REFERENCE_ZOOM,
        modelUrl: droneModelUrl,
        ...cfgRef.current,
        onStats: (online, offline) => {
          setOnlineCount(online)
          setOfflineCount(offline)
        }
      })
      fleetRef.current = fleet
      map.addLayer(fleet)
    })

    return () => {
      map.remove()
      mapRef.current = null
      fleetRef.current = null
    }
  }, [])

  useEffect(() => {
    const fleet = fleetRef.current
    if (!fleet) return
    Object.assign(fleet.config, {
      trailWidth: cfg.trailWidth,
      speedFactor: cfg.speedFactor,
      sizeFactor: cfg.sizeFactor,
      zoomAdaptive: cfg.zoomAdaptive,
      showTrails: cfg.showTrails,
      showDropLines: cfg.showDropLines,
      showHalo: cfg.showHalo,
      flying: cfg.flying,
      blink: cfg.blink
    })
    mapRef.current?.triggerRepaint()
  }, [
    cfg.trailWidth,
    cfg.speedFactor,
    cfg.sizeFactor,
    cfg.zoomAdaptive,
    cfg.showTrails,
    cfg.showDropLines,
    cfg.showHalo,
    cfg.flying,
    cfg.blink
  ])

  useEffect(() => {
    fleetRef.current?.setOnlineColor(cfg.onlineColor)
  }, [cfg.onlineColor])

  useEffect(() => {
    fleetRef.current?.setOfflineColor(cfg.offlineColor)
  }, [cfg.offlineColor])

  useEffect(() => {
    fleetRef.current?.setTrailColor(cfg.trailColor)
  }, [cfg.trailColor])

  useEffect(() => {
    fleetRef.current?.setTrailColorMode(cfg.trailColorMode)
  }, [cfg.trailColorMode])

  useEffect(() => {
    fleetRef.current?.setOnlineRatio(cfg.onlineRatio)
  }, [cfg.onlineRatio])

  return (
    <div className="demo-container">
      <div ref={mapContainer} className="map-container" />

      <div className="hud-panel">
        <div className="hud-card hud-header">
          <span className="hud-glow-dot" />
          <div>
            <h4 className="hud-title">低空无人机指挥台</h4>
            <p className="hud-sub">GLB · eVTOL · Three.js 实时态势</p>
          </div>
        </div>

        <div className="hud-card">
          <div className="hud-stat">
            <span
              className="tag online"
              style={{ color: cfg.onlineColor, borderColor: cfg.onlineColor }}
            >
              ONLINE
            </span>
            <b className="num">{onlineCount}</b>
          </div>
          <div className="hud-stat">
            <span className="tag offline">OFFLINE</span>
            <b className="num">{offlineCount}</b>
          </div>
          <div className="hud-stat">
            <span className="tag zoom">ZOOM</span>
            <b className="num">{currentZoom.toFixed(2)}</b>
          </div>
        </div>

        <div className="hud-card">
          <h5 className="hud-section">状态颜色</h5>
          <div className="hud-color">
            <span>在线</span>
            <input
              type="color"
              value={cfg.onlineColor}
              onChange={(e) => updateCfg({ onlineColor: e.target.value })}
            />
          </div>
          <div className="hud-color">
            <span>离线</span>
            <input
              type="color"
              value={cfg.offlineColor}
              onChange={(e) => updateCfg({ offlineColor: e.target.value })}
            />
          </div>
          <div className="hud-slider">
            <label>
              在线比例 <b>{(cfg.onlineRatio * 100).toFixed(0)}%</b>
            </label>
            <input
              type="range"
              value={cfg.onlineRatio}
              min={0}
              max={1}
              step={0.01}
              onChange={(e) => updateCfg({ onlineRatio: Number(e.target.value) })}
            />
          </div>
        </div>

        <div className="hud-card">
          <h5 className="hud-section">轨迹光带</h5>
          <div className="hud-color">
            <span>颜色模式</span>
            <select
              className="hud-select"
              value={cfg.trailColorMode}
              onChange={(e) =>
                updateCfg({ trailColorMode: e.target.value as DroneFleetConfig['trailColorMode'] })
              }
            >
              <option value="status">跟随状态</option>
              <option value="custom">自定义</option>
            </select>
          </div>
          {cfg.trailColorMode === 'custom' && (
            <div className="hud-color">
              <span>轨迹颜色</span>
              <input
                type="color"
                value={cfg.trailColor}
                onChange={(e) => updateCfg({ trailColor: e.target.value })}
              />
            </div>
          )}
          <div className="hud-slider">
            <label>
              粗细 <b>{cfg.trailWidth.toFixed(1)}px</b>
            </label>
            <input
              type="range"
              value={cfg.trailWidth}
              min={1}
              max={12}
              step={0.5}
              onChange={(e) => updateCfg({ trailWidth: Number(e.target.value) })}
            />
          </div>
        </div>

        <div className="hud-card">
          <h5 className="hud-section">运动</h5>
          <div className="hud-slider">
            <label>
              速度倍率 <b>{cfg.speedFactor.toFixed(1)}x</b>
            </label>
            <input
              type="range"
              value={cfg.speedFactor}
              min={0}
              max={4}
              step={0.1}
              onChange={(e) => updateCfg({ speedFactor: Number(e.target.value) })}
            />
          </div>
          <div className="hud-slider">
            <label>
              基础大小 <b>{cfg.sizeFactor.toFixed(1)}x</b>
            </label>
            <input
              type="range"
              value={cfg.sizeFactor}
              min={0.2}
              max={4}
              step={0.1}
              onChange={(e) => updateCfg({ sizeFactor: Number(e.target.value) })}
            />
          </div>
        </div>

        <div className="hud-card">
          <h5 className="hud-section">显示</h5>
          <label className="hud-switch">
            <input
              type="checkbox"
              checked={cfg.zoomAdaptive}
              onChange={(e) => updateCfg({ zoomAdaptive: e.target.checked })}
            />
            <span>大小随缩放自适应</span>
          </label>
          <label className="hud-switch">
            <input
              type="checkbox"
              checked={cfg.flying}
              onChange={(e) => updateCfg({ flying: e.target.checked })}
            />
            <span>实时飞行</span>
          </label>
          <label className="hud-switch">
            <input
              type="checkbox"
              checked={cfg.blink}
              onChange={(e) => updateCfg({ blink: e.target.checked })}
            />
            <span>整机闪烁</span>
          </label>
          <label className="hud-switch">
            <input
              type="checkbox"
              checked={cfg.showTrails}
              onChange={(e) => updateCfg({ showTrails: e.target.checked })}
            />
            <span>飞行轨迹光带</span>
          </label>
          <label className="hud-switch">
            <input
              type="checkbox"
              checked={cfg.showDropLines}
              onChange={(e) => updateCfg({ showDropLines: e.target.checked })}
            />
            <span>高度投影线</span>
          </label>
          <label className="hud-switch">
            <input
              type="checkbox"
              checked={cfg.showHalo}
              onChange={(e) => updateCfg({ showHalo: e.target.checked })}
            />
            <span>地面雷达光环</span>
          </label>
        </div>
      </div>
    </div>
  )
}
