import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MAPBOX_ACCESS_TOKEN, MAP_STYLES } from '@/config/mapbox'
import './demo-common.css'
import './GeoServerVectorTileDemo.css'

const GEOSERVER_TMS_URL =
  'http://10.1.109.141:28080/geoserver/gwc/service/tms/1.0.0/lowAltitude%3Achengdu_buildings_dwgpolygon@EPSG%3A900913@pbf/{z}/{x}/{y}.pbf'

const SOURCE_LAYER = 'chengdu_buildings_dwgpolygon'

export default function GeoServerVectorTileDemo() {
  const mapContainer = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!mapContainer.current) return

    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: MAP_STYLES.STREETS,
      center: [104.0657, 30.6595],
      zoom: 14,
      pitch: 50,
      bearing: -20,
    })

    let popup: mapboxgl.Popup | null = null

    map.addControl(new mapboxgl.NavigationControl(), 'bottom-right')
    map.addControl(new mapboxgl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left')

    map.on('load', () => {
      map.addSource('geoserver-vector-tiles', {
        type: 'vector',
        tiles: [GEOSERVER_TMS_URL],
        scheme: 'tms',
        minzoom: 0,
        maxzoom: 22,
      })

      map.addLayer({
        id: 'buildings-extrusion',
        type: 'fill-extrusion',
        source: 'geoserver-vector-tiles',
        'source-layer': SOURCE_LAYER,
        paint: {
          'fill-extrusion-color': [
            'interpolate',
            ['linear'],
            ['coalesce', ['get', 'Elevation'], 0],
            0,
            '#74b9e8',
            20,
            '#4a90d9',
            50,
            '#2c6faf',
            100,
            '#1a3a6b',
          ],
          'fill-extrusion-height': ['coalesce', ['get', 'Height'], 3],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.85,
        },
      })

      map.addLayer({
        id: 'buildings-highlight',
        type: 'fill-extrusion',
        source: 'geoserver-vector-tiles',
        'source-layer': SOURCE_LAYER,
        paint: {
          'fill-extrusion-color': '#f39c12',
          'fill-extrusion-height': ['coalesce', ['get', 'Elevation'], 3],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.95,
        },
        filter: ['==', ['id'], ''],
      })

      let hoveredId: string | number | null = null

      map.on('mousemove', 'buildings-extrusion', (e) => {
        if (e.features && e.features.length > 0) {
          map.getCanvas().style.cursor = 'pointer'

          const featureId = e.features?.[0]?.id
          if (featureId !== hoveredId) {
            hoveredId = featureId ?? null
            map.setFilter('buildings-highlight', ['==', ['id'], hoveredId ?? ''])
          }
        }
      })

      map.on('mouseleave', 'buildings-extrusion', () => {
        map.getCanvas().style.cursor = ''
        hoveredId = null
        map.setFilter('buildings-highlight', ['==', ['id'], ''])
      })

      map.on('click', 'buildings-extrusion', (e) => {
        if (!e.features || e.features.length === 0) return

        const feature = e.features?.[0]
        const props = feature?.properties ?? {}

        const rows = Object.entries(props)
          .map(([k, v]) => `<tr><td class="prop-key">${k}</td><td class="prop-val">${v}</td></tr>`)
          .join('')

        const html =
          `<div class="feature-popup">` +
          `<h4>建筑物属性</h4>` +
          (rows
            ? `<table class="prop-table">${rows}</table>`
            : `<p style="color:#999">暂无属性信息</p>`) +
          `</div>`

        if (popup) popup.remove()
        popup = new mapboxgl.Popup({ maxWidth: '320px' })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map)
      })
    })

    map.on('error', (e) => {
      console.error('Mapbox GL error:', e)
    })

    return () => {
      popup?.remove()
      map.remove()
    }
  }, [])

  return (
    <div className="geoserver-demo-container">
      <div ref={mapContainer} className="map-container" />
      <div className="geoserver-info-panel">
        <h3>GeoServer 矢量切片</h3>
        <p>服务类型：TMS (PBF)</p>
        <p>图层：chengdu_buildings_dwgpolygon</p>
        <p>坐标系：EPSG:900913</p>
        <div className="geoserver-legend">
          <div className="geoserver-legend-item">
            <span
              className="geoserver-legend-color"
              style={{ background: 'linear-gradient(to top, #74b9e8, #1a3a6b)' }}
            />
            <span>低 → 高（Elevation）</span>
          </div>
          <div className="geoserver-legend-item">
            <span className="geoserver-legend-color" style={{ background: '#f39c12' }} />
            <span>选中高亮</span>
          </div>
        </div>
        <p className="geoserver-tip">拖拽右键旋转视角 · 点击查看属性</p>
      </div>
    </div>
  )
}
