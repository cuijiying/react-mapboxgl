import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MAPBOX_ACCESS_TOKEN, MAP_STYLES } from '@/config/mapbox'
import './demo-common.css'
import './SplitViewDemo.css'

const defaultCenter: [number, number] = [116.4074, 39.9042]
const defaultZoom = 6

const geojsonData: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: '北京' },
      geometry: { type: 'Point', coordinates: [116.4074, 39.9042] },
    },
    {
      type: 'Feature',
      properties: { name: '上海' },
      geometry: { type: 'Point', coordinates: [121.4737, 31.2304] },
    },
    {
      type: 'Feature',
      properties: { name: '广州' },
      geometry: { type: 'Point', coordinates: [113.2644, 23.1291] },
    },
    {
      type: 'Feature',
      properties: { name: '京沪线' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [116.4074, 39.9042],
          [117.2, 36.6],
          [118.8, 34.2],
          [121.4737, 31.2304],
        ],
      },
    },
  ],
}

function addLayers(map: mapboxgl.Map) {
  map.addSource('demo-geojson', {
    type: 'geojson',
    data: geojsonData,
  })

  map.addLayer({
    id: 'points',
    type: 'circle',
    source: 'demo-geojson',
    filter: ['==', '$type', 'Point'],
    paint: {
      'circle-radius': 7,
      'circle-color': '#e74c3c',
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fff',
    },
  })

  map.addLayer({
    id: 'point-labels',
    type: 'symbol',
    source: 'demo-geojson',
    filter: ['==', '$type', 'Point'],
    layout: {
      'text-field': ['get', 'name'],
      'text-offset': [0, 1.5],
      'text-size': 13,
      'text-anchor': 'top',
    },
    paint: {
      'text-color': '#333',
      'text-halo-color': '#fff',
      'text-halo-width': 1,
    },
  })

  map.addLayer({
    id: 'lines',
    type: 'line',
    source: 'demo-geojson',
    filter: ['==', '$type', 'LineString'],
    paint: {
      'line-color': '#3498db',
      'line-width': 3,
    },
  })
}

export default function SplitViewDemo() {
  const map2dContainer = useRef<HTMLDivElement>(null)
  const map3dContainer = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!map2dContainer.current || !map3dContainer.current) return

    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN

    const map2d = new mapboxgl.Map({
      container: map2dContainer.current,
      style: MAP_STYLES.STREETS,
      center: defaultCenter,
      zoom: defaultZoom,
      pitch: 0,
      bearing: 0,
    })
    map2d.addControl(new mapboxgl.NavigationControl(), 'top-right')

    const map3d = new mapboxgl.Map({
      container: map3dContainer.current,
      style: MAP_STYLES.SATELLITE,
      center: defaultCenter,
      zoom: defaultZoom,
      pitch: 60,
      bearing: -20,
    })
    map3d.addControl(new mapboxgl.NavigationControl(), 'top-right')

    let isSyncing = false

    function syncMove(source: mapboxgl.Map, target: mapboxgl.Map) {
      if (isSyncing) return
      isSyncing = true
      target.jumpTo({
        center: source.getCenter(),
        zoom: source.getZoom(),
        bearing: source.getBearing(),
      })
      isSyncing = false
    }

    function bindSync(mapA: mapboxgl.Map, mapB: mapboxgl.Map) {
      mapA.on('move', () => syncMove(mapA, mapB))
      mapB.on('move', () => syncMove(mapB, mapA))
    }

    map2d.on('load', () => {
      addLayers(map2d)
    })

    map3d.on('load', () => {
      addLayers(map3d)

      map3d.addSource('mapbox-dem', {
        type: 'raster-dem',
        url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
        tileSize: 512,
        maxzoom: 14,
      })
      map3d.setTerrain({ source: 'mapbox-dem', exaggeration: 1.5 })

      const layers = map3d.getStyle().layers
      if (layers) {
        const labelLayerId = layers.find(
          (layer) => layer.type === 'symbol' && layer.layout && 'text-field' in layer.layout,
        )?.id
        map3d.addLayer(
          {
            id: '3d-buildings',
            source: 'composite',
            'source-layer': 'building',
            filter: ['==', 'extrude', 'true'],
            type: 'fill-extrusion',
            minzoom: 12,
            paint: {
              'fill-extrusion-color': '#aaa',
              'fill-extrusion-height': ['get', 'height'],
              'fill-extrusion-base': ['get', 'min_height'],
              'fill-extrusion-opacity': 0.6,
            },
          },
          labelLayerId,
        )
      }
    })

    let loaded = 0
    const onBothLoaded = () => {
      loaded++
      if (loaded === 2) {
        bindSync(map2d, map3d)
      }
    }
    map2d.on('load', onBothLoaded)
    map3d.on('load', onBothLoaded)

    return () => {
      map2d.remove()
      map3d.remove()
    }
  }, [])

  return (
    <div className="split-demo-container">
      <div className="split-view">
        <div className="split-pane">
          <div className="split-pane-label">2D 视图</div>
          <div ref={map2dContainer} className="map-container" />
        </div>
        <div className="split-divider" />
        <div className="split-pane">
          <div className="split-pane-label">3D 视图</div>
          <div ref={map3dContainer} className="map-container" />
        </div>
      </div>
    </div>
  )
}
