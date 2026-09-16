import { useEffect, useMemo, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MAPBOX_ACCESS_TOKEN, MAP_STYLES } from '@/config/mapbox'
import cameraIcon from '@/images/icons/devs/摄像头.png?url'
import cameraAlertIcon from '@/images/icons/devs/摄像头-alert.png?url'
import radarIcon from '@/images/icons/devs/雷达.png?url'
import radarAlertIcon from '@/images/icons/devs/雷达-alert.png?url'
import './demo-common.css'
import './DeviceMarkersDemo.css'

type DeviceType = 'camera' | 'radar'
type DeviceStatus = 'online' | 'offline' | 'alert'

interface Device {
  id: string
  name: string
  type: DeviceType
  status: DeviceStatus
  coordinates: [number, number]
}

interface LayerControl {
  id: DeviceType
  label: string
  preview: string
  layerIds: string[]
  visible: boolean
  count: number
}

const STATUS_LABEL: Record<DeviceStatus, string> = {
  online: '在线',
  offline: '离线',
  alert: '异常报警',
}

const devices: Device[] = [
  { id: 'cam-1', name: '摄像头-浦东A1', type: 'camera', status: 'online', coordinates: [121.52, 31.24] },
  { id: 'cam-2', name: '摄像头-浦东A2', type: 'camera', status: 'alert', coordinates: [121.55, 31.22] },
  { id: 'cam-3', name: '摄像头-黄浦B1', type: 'camera', status: 'online', coordinates: [121.48, 31.23] },
  { id: 'cam-4', name: '摄像头-静安B2', type: 'camera', status: 'offline', coordinates: [121.46, 31.25] },
  { id: 'cam-5', name: '摄像头-徐汇C1', type: 'camera', status: 'alert', coordinates: [121.44, 31.19] },
  { id: 'cam-6', name: '摄像头-长宁C2', type: 'camera', status: 'online', coordinates: [121.42, 31.22] },
  { id: 'rad-1', name: '雷达-虹桥D1', type: 'radar', status: 'online', coordinates: [121.33, 31.2] },
  { id: 'rad-2', name: '雷达-嘉定D2', type: 'radar', status: 'alert', coordinates: [121.26, 31.38] },
  { id: 'rad-3', name: '雷达-宝山E1', type: 'radar', status: 'online', coordinates: [121.49, 31.4] },
  { id: 'rad-4', name: '雷达-松江E2', type: 'radar', status: 'offline', coordinates: [121.23, 31.03] },
  { id: 'rad-5', name: '雷达-奉贤F1', type: 'radar', status: 'alert', coordinates: [121.47, 31.1] },
]

function devicesToGeoJSON(type: DeviceType, alertOnly: boolean): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: devices
      .filter((d) => d.type === type && (alertOnly ? d.status === 'alert' : d.status !== 'alert'))
      .map((d) => ({
        type: 'Feature',
        properties: {
          id: d.id,
          name: d.name,
          type: d.type,
          status: d.status,
        },
        geometry: {
          type: 'Point',
          coordinates: d.coordinates,
        },
      })),
  }
}

export default function DeviceMarkersDemo() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const blinkFrameIdRef = useRef(0)

  const [layerControls, setLayerControls] = useState<LayerControl[]>([
    {
      id: 'camera',
      label: '摄像头',
      preview: cameraIcon,
      layerIds: ['dev-camera', 'dev-camera-alert'],
      visible: true,
      count: devices.filter((d) => d.type === 'camera').length,
    },
    {
      id: 'radar',
      label: '雷达',
      preview: radarIcon,
      layerIds: ['dev-radar', 'dev-radar-alert'],
      visible: true,
      count: devices.filter((d) => d.type === 'radar').length,
    },
  ])

  const statusLegend = [
    { status: 'online' as DeviceStatus, label: '在线' },
    { status: 'offline' as DeviceStatus, label: '离线' },
    { status: 'alert' as DeviceStatus, label: '异常报警' },
  ]

  const statusCounts = useMemo(
    () => ({
      online: devices.filter((d) => d.status === 'online').length,
      offline: devices.filter((d) => d.status === 'offline').length,
      alert: devices.filter((d) => d.status === 'alert').length,
    }),
    [],
  )

  const toggleLayerGroup = (layerId: DeviceType, visible: boolean) => {
    const map = mapRef.current
    if (!map) return

    const layer = layerControls.find((l) => l.id === layerId)
    if (!layer) return

    const visibility = visible ? 'visible' : 'none'
    layer.layerIds.forEach((id) => {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', visibility)
      }
    })
  }

  useEffect(() => {
    if (!mapContainer.current) return

    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: MAP_STYLES.DARK,
      center: [121.47, 31.23],
      zoom: 10.5,
    })

    mapRef.current = map
    map.addControl(new mapboxgl.NavigationControl(), 'top-left')

    let blinkPhase = 0

    function loadMapImage(id: string, url: string): Promise<void> {
      return new Promise((resolve, reject) => {
        map.loadImage(url, (err, image) => {
          if (err || !image) {
            reject(err ?? new Error(`Failed to load image: ${id}`))
            return
          }
          if (!map.hasImage(id)) {
            map.addImage(id, image)
          }
          resolve()
        })
      })
    }

    function addSymbolLayer(
      id: string,
      source: string,
      icon: string,
      iconOpacity: number | mapboxgl.Expression,
    ) {
      map.addLayer({
        id,
        source,
        type: 'symbol',
        layout: {
          'icon-image': icon,
          'icon-size': 0.8,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-opacity': iconOpacity,
        },
      })
    }

    function bindDeviceInteractions() {
      const interactiveLayers = ['dev-camera', 'dev-camera-alert', 'dev-radar', 'dev-radar-alert']

      interactiveLayers.forEach((layerId) => {
        map.on('click', layerId, (e) => {
          if (!e.features?.[0]) return
          const props = e.features[0].properties!
          const coords = (e.features[0].geometry as GeoJSON.Point).coordinates.slice() as [
            number,
            number,
          ]
          const typeLabel = props.type === 'camera' ? '摄像头' : '雷达'

          new mapboxgl.Popup({ closeOnClick: true })
            .setLngLat(coords)
            .setHTML(
              `<div style="font-size:13px;line-height:1.7">` +
                `<b>${props.name}</b><br>` +
                `类型：${typeLabel}<br>` +
                `状态：<b style="color:${props.status === 'alert' ? '#ff4444' : props.status === 'offline' ? '#999' : '#44cc88'}">` +
                `${STATUS_LABEL[props.status as DeviceStatus]}</b>` +
                `</div>`,
            )
            .addTo(map)
        })

        map.on('mouseenter', layerId, () => {
          map.getCanvas().style.cursor = 'pointer'
        })
        map.on('mouseleave', layerId, () => {
          map.getCanvas().style.cursor = ''
        })
      })
    }

    function startBlinkAnimation() {
      const alertLayers = ['dev-camera-alert', 'dev-radar-alert']
      const baseSize = 0.8
      const sizeAmplitude = 0.18

      const tick = () => {
        if (!mapRef.current) return
        blinkPhase += 0.1
        const wave = 0.5 + 0.5 * Math.sin(blinkPhase)
        const opacity = 0.3 + 0.7 * wave
        const size = baseSize + sizeAmplitude * wave

        alertLayers.forEach((layerId) => {
          if (map.getLayer(layerId)) {
            map.setPaintProperty(layerId, 'icon-opacity', opacity)
            map.setLayoutProperty(layerId, 'icon-size', size)
          }
        })

        blinkFrameIdRef.current = requestAnimationFrame(tick)
      }

      blinkFrameIdRef.current = requestAnimationFrame(tick)
    }

    map.on('load', async () => {
      await Promise.all([
        loadMapImage('icon-camera', cameraIcon),
        loadMapImage('icon-camera-alert', cameraAlertIcon),
        loadMapImage('icon-radar', radarIcon),
        loadMapImage('icon-radar-alert', radarAlertIcon),
      ])

      map.addSource('dev-camera-src', { type: 'geojson', data: devicesToGeoJSON('camera', false) })
      map.addSource('dev-camera-alert-src', { type: 'geojson', data: devicesToGeoJSON('camera', true) })
      map.addSource('dev-radar-src', { type: 'geojson', data: devicesToGeoJSON('radar', false) })
      map.addSource('dev-radar-alert-src', { type: 'geojson', data: devicesToGeoJSON('radar', true) })

      addSymbolLayer('dev-camera', 'dev-camera-src', 'icon-camera', [
        'case',
        ['==', ['get', 'status'], 'offline'],
        0.45,
        1,
      ])
      addSymbolLayer('dev-camera-alert', 'dev-camera-alert-src', 'icon-camera-alert', 1)
      addSymbolLayer('dev-radar', 'dev-radar-src', 'icon-radar', [
        'case',
        ['==', ['get', 'status'], 'offline'],
        0.45,
        1,
      ])
      addSymbolLayer('dev-radar-alert', 'dev-radar-alert-src', 'icon-radar-alert', 1)

      bindDeviceInteractions()
      startBlinkAnimation()
    })

    return () => {
      cancelAnimationFrame(blinkFrameIdRef.current)
      map.remove()
      mapRef.current = null
    }
  }, [])

  return (
    <div className="device-demo-container">
      <div ref={mapContainer} className="map-container" />

      <div className="device-control-panel">
        <div className="device-panel-card">
          <h4 className="device-panel-title">图层控制</h4>
          {layerControls.map((layer) => (
            <label key={layer.id} className="device-checkbox-row">
              <input
                type="checkbox"
                checked={layer.visible}
                onChange={(e) => {
                  const visible = e.target.checked
                  setLayerControls((prev) =>
                    prev.map((item) =>
                      item.id === layer.id ? { ...item, visible } : item,
                    ),
                  )
                  toggleLayerGroup(layer.id, visible)
                }}
              />
              <img src={layer.preview} alt={layer.label} className="device-layer-icon" />
              <span>{layer.label}</span>
              <span className="device-count-badge">{layer.count}</span>
            </label>
          ))}
        </div>

        <div className="device-panel-card">
          <h4 className="device-panel-title">设备状态</h4>
          {statusLegend.map((item) => (
            <div key={item.status} className="device-legend-row">
              <span className={`device-legend-dot ${item.status}`} />
              <span>{item.label}</span>
              <span className="device-count-badge">{statusCounts[item.status]}</span>
            </div>
          ))}
        </div>

        <div className="device-panel-card device-info-card">
          <h4 className="device-panel-title">说明</h4>
          <p className="device-info-text">
            展示摄像头、雷达等设备图标点位，支持按类型切换图层显隐；异常报警状态图标持续闪烁。
          </p>
        </div>
      </div>
    </div>
  )
}
