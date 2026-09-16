import { useCallback, useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MAPBOX_ACCESS_TOKEN, MAP_STYLES } from '@/config/mapbox'
import './GisAiDemo.css'

interface Station {
  id: number
  name: string
  lng: number
  lat: number
  pm25: number
  aqi: number
  temperature: number
  humidity: number
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

function det(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

const CITY_BASES = [
  { city: '北京', lng: 116.41, lat: 39.9, basePM: 82 },
  { city: '天津', lng: 117.2, lat: 39.13, basePM: 76 },
  { city: '石家庄', lng: 114.51, lat: 38.04, basePM: 98 },
  { city: '唐山', lng: 118.18, lat: 39.63, basePM: 125 },
  { city: '上海', lng: 121.47, lat: 31.23, basePM: 52 },
  { city: '南京', lng: 118.8, lat: 32.06, basePM: 58 },
  { city: '杭州', lng: 120.15, lat: 30.27, basePM: 48 },
  { city: '广州', lng: 113.26, lat: 23.13, basePM: 42 },
  { city: '深圳', lng: 114.06, lat: 22.55, basePM: 32 },
  { city: '成都', lng: 104.07, lat: 30.57, basePM: 68 },
  { city: '重庆', lng: 106.55, lat: 29.56, basePM: 62 },
  { city: '武汉', lng: 114.3, lat: 30.59, basePM: 60 },
  { city: '西安', lng: 108.94, lat: 34.26, basePM: 78 },
  { city: '沈阳', lng: 123.43, lat: 41.8, basePM: 70 },
  { city: '哈尔滨', lng: 126.53, lat: 45.8, basePM: 65 },
  { city: '长沙', lng: 112.94, lat: 28.23, basePM: 52 },
  { city: '郑州', lng: 113.65, lat: 34.76, basePM: 88 },
  { city: '昆明', lng: 102.83, lat: 25.02, basePM: 22 },
  { city: '拉萨', lng: 91.17, lat: 29.65, basePM: 12 },
  { city: '乌鲁木齐', lng: 87.62, lat: 43.83, basePM: 56 },
  { city: '兰州', lng: 103.83, lat: 36.06, basePM: 72 },
  { city: '邯郸', lng: 114.48, lat: 36.6, basePM: 140 },
]

function generateStations(): Station[] {
  const result: Station[] = []
  let id = 0

  CITY_BASES.forEach((base, ci) => {
    const count = 2 + Math.floor(det(ci * 7) * 2)
    for (let si = 0; si < count; si++) {
      const seed = ci * 100 + si
      const lngOff = (det(seed + 1) - 0.5) * 1.5
      const latOff = (det(seed + 2) - 0.5) * 1.5
      const pmOff = (det(seed + 3) - 0.5) * 30
      const pm25 = Math.max(5, Math.round(base.basePM + pmOff))

      result.push({
        id,
        name: `${base.city}${si + 1}号站`,
        lng: Math.round((base.lng + lngOff) * 100) / 100,
        lat: Math.round((base.lat + latOff) * 100) / 100,
        pm25,
        aqi: Math.round(pm25 * 1.2 + det(seed + 4) * 20),
        temperature: Math.round(22 - (base.lat - 30) * 0.4 + (det(seed + 5) - 0.5) * 8),
        humidity: Math.round(45 + det(seed + 6) * 50),
      })
      id++
    }
  })

  return result
}

function kMeans(points: [number, number][], k: number): number[] {
  const n = points.length
  if (n === 0) return []

  const sorted = [...points].map((p, i) => ({ p, i })).sort((a, b) => a.p[0] - b.p[0])
  const step = Math.max(1, Math.floor(n / k))
  const centroids: [number, number][] = []
  for (let i = 0; i < k; i++) {
    const idx = Math.min(i * step, n - 1)
    centroids.push([sorted[idx].p[0], sorted[idx].p[1]])
  }

  const assignments = new Array(n).fill(0)

  for (let iter = 0; iter < 50; iter++) {
    let changed = false

    for (let i = 0; i < n; i++) {
      let minDist = Infinity
      let best = 0
      for (let j = 0; j < k; j++) {
        const dx = points[i][0] - centroids[j][0]
        const dy = points[i][1] - centroids[j][1]
        const dist = dx * dx + dy * dy
        if (dist < minDist) {
          minDist = dist
          best = j
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best
        changed = true
      }
    }

    if (!changed) break

    for (let j = 0; j < k; j++) {
      let sx = 0
      let sy = 0
      let cnt = 0
      for (let i = 0; i < n; i++) {
        if (assignments[i] === j) {
          sx += points[i][0]
          sy += points[i][1]
          cnt++
        }
      }
      if (cnt > 0) {
        centroids[j] = [sx / cnt, sy / cnt]
      }
    }
  }

  return assignments
}

function idwPredict(lng: number, lat: number, stations: Station[], power = 2): number {
  let wSum = 0
  let vSum = 0
  for (const s of stations) {
    const d = Math.sqrt((s.lng - lng) ** 2 + (s.lat - lat) ** 2)
    if (d < 0.01) return s.pm25
    const w = 1 / d ** power
    wSum += w
    vSum += w * s.pm25
  }
  return Math.round(vSum / wSum)
}

function makeCircle(lng: number, lat: number, radiusKm: number): GeoJSON.Feature {
  const numPoints = 64
  const coords: [number, number][] = []
  for (let i = 0; i <= numPoints; i++) {
    const angle = (i / numPoints) * 2 * Math.PI
    const dLat = (radiusKm / 111) * Math.sin(angle)
    const dLng = (radiusKm / (111 * Math.cos((lat * Math.PI) / 180))) * Math.cos(angle)
    coords.push([lng + dLng, lat + dLat])
  }
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [coords] },
  }
}

const stations = generateStations()
const CLUSTER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12']

const quickActions = [
  { id: 'cluster', icon: '🔮', label: '聚类分析' },
  { id: 'anomaly', icon: '🚨', label: '异常检测' },
  { id: 'heatmap', icon: '🌡️', label: '热力图' },
  { id: 'impact', icon: '⭕', label: '影响范围' },
  { id: 'predict', icon: '📍', label: '空间预测' },
  { id: 'stats', icon: '📊', label: '统计概况' },
  { id: 'reset', icon: '🔄', label: '重置' },
]

function stationsToGeoJSON(
  extraProps?: Record<number, Record<string, unknown>>,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: stations.map((s) => ({
      type: 'Feature' as const,
      properties: {
        id: s.id,
        name: s.name,
        pm25: s.pm25,
        aqi: s.aqi,
        temperature: s.temperature,
        humidity: s.humidity,
        ...(extraProps?.[s.id] || {}),
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [s.lng, s.lat],
      },
    })),
  }
}

export default function GisAiDemo() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const chatArea = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const predictionPopupRef = useRef<mapboxgl.Popup | null>(null)
  const predictionModeRef = useRef(false)

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content:
        '👋 你好！我是 GIS 智能分析助手。<br>当前已加载 <b>' +
        stations.length +
        '</b> 个空气质量监测站数据。<br><br>你可以使用下方快捷按钮，或输入自然语言指令进行空间分析：<br>• 聚类分析 · 异常检测 · 热力图<br>• 影响范围 · 空间预测 · 统计概况',
    },
  ])
  const [userInput, setUserInput] = useState('')
  const [isThinking, setIsThinking] = useState(false)
  const [activeActions, setActiveActions] = useState<Set<string>>(new Set())

  const scrollToBottom = useCallback(() => {
    if (chatArea.current) {
      chatArea.current.scrollTop = chatArea.current.scrollHeight
    }
  }, [])

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  const addAssistant = useCallback(
    async (content: string) => {
      setIsThinking(true)
      await delay(0)
      scrollToBottom()
      await delay(500 + Math.random() * 500)
      setIsThinking(false)
      setMessages((prev) => [...prev, { role: 'assistant', content }])
      await delay(0)
      scrollToBottom()
    },
    [scrollToBottom],
  )

  const runClustering = useCallback((): string => {
    const map = mapRef.current
    if (!map) return ''

    const coords: [number, number][] = stations.map((s) => [s.lng, s.lat])
    const assignments = kMeans(coords, 4)

    const counts = [0, 0, 0, 0]
    assignments.forEach((a) => counts[a]++)

    const extra: Record<number, Record<string, unknown>> = {}
    stations.forEach((s, i) => {
      extra[s.id] = { cluster: assignments[i] }
    })

    const src = map.getSource('stations') as mapboxgl.GeoJSONSource | undefined
    if (src) src.setData(stationsToGeoJSON(extra))

    map.setPaintProperty('stations-circle', 'circle-color', [
      'match',
      ['get', 'cluster'],
      0,
      CLUSTER_COLORS[0],
      1,
      CLUSTER_COLORS[1],
      2,
      CLUSTER_COLORS[2],
      3,
      CLUSTER_COLORS[3],
      '#999',
    ])
    map.setPaintProperty('stations-circle', 'circle-radius', 8)

    setActiveActions((prev) => new Set(prev).add('cluster'))

    const detail = counts
      .map(
        (c, i) =>
          `<span style="color:${CLUSTER_COLORS[i]}">●</span> 聚类 ${String.fromCharCode(65 + i)}：${c} 个站点`,
      )
      .join('<br>')

    return `已完成 <b>K-Means 空间聚类</b>（K=4）：<br>${detail}<br><br>地图上各站点已按空间聚类着色。`
  }, [])

  const runAnomalyDetection = useCallback((): string => {
    const map = mapRef.current
    if (!map) return ''

    const values = stations.map((s) => s.pm25)
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length)
    const threshold = mean + 1.5 * std

    const anomalies = stations.filter((s) => s.pm25 > threshold)

    const anomalyGeoJSON: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: anomalies.map((s) => ({
        type: 'Feature' as const,
        properties: { name: s.name, pm25: s.pm25 },
        geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
      })),
    }

    if (map.getSource('anomalies')) {
      ;(map.getSource('anomalies') as mapboxgl.GeoJSONSource).setData(anomalyGeoJSON)
    } else {
      map.addSource('anomalies', { type: 'geojson', data: anomalyGeoJSON })
      map.addLayer({
        id: 'anomaly-pulse',
        type: 'circle',
        source: 'anomalies',
        paint: {
          'circle-radius': 22,
          'circle-color': '#ff0000',
          'circle-opacity': 0.25,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ff0000',
        },
      })
      map.addLayer({
        id: 'anomaly-core',
        type: 'circle',
        source: 'anomalies',
        paint: {
          'circle-radius': 8,
          'circle-color': '#ff0000',
          'circle-stroke-width': 3,
          'circle-stroke-color': '#fff',
        },
      })
    }

    setActiveActions((prev) => new Set(prev).add('anomaly'))

    const list = anomalies
      .map((s) => `• ${s.name}：PM2.5 = <b>${s.pm25}</b> μg/m³`)
      .join('<br>')

    return (
      `基于 <b>Z-Score 异常检测</b>（阈值 = μ+1.5σ = ${Math.round(threshold)} μg/m³），<br>` +
      `检测到 <b>${anomalies.length}</b> 个异常高污染站点：<br><br>${list}<br><br>` +
      `异常站点已用红色标记高亮显示。`
    )
  }, [])

  const toggleHeatmap = useCallback((): string => {
    const map = mapRef.current
    if (!map) return ''

    if (map.getLayer('stations-heatmap')) {
      map.removeLayer('stations-heatmap')
      setActiveActions((prev) => {
        const next = new Set(prev)
        next.delete('heatmap')
        return next
      })
      return '已关闭热力图。'
    }

    map.addLayer(
      {
        id: 'stations-heatmap',
        type: 'heatmap',
        source: 'stations',
        paint: {
          'heatmap-weight': ['interpolate', ['linear'], ['get', 'pm25'], 0, 0, 150, 1],
          'heatmap-intensity': 1.5,
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 3, 30, 8, 60],
          'heatmap-opacity': 0.7,
          'heatmap-color': [
            'interpolate',
            ['linear'],
            ['heatmap-density'],
            0,
            'rgba(33,102,172,0)',
            0.2,
            'rgb(103,169,207)',
            0.4,
            'rgb(209,229,240)',
            0.6,
            'rgb(253,219,199)',
            0.8,
            'rgb(239,138,98)',
            1,
            'rgb(178,24,43)',
          ],
        },
      },
      'stations-circle',
    )

    setActiveActions((prev) => new Set(prev).add('heatmap'))
    return '已生成 <b>PM2.5 空间分布热力图</b>。<br>颜色从蓝到红表示 PM2.5 浓度由低到高。'
  }, [])

  const runImpactAnalysis = useCallback((): string => {
    const map = mapRef.current
    if (!map) return ''

    const highStations = stations.filter((s) => s.aqi > 150)
    const circles: GeoJSON.Feature[] = highStations.map((s) => makeCircle(s.lng, s.lat, 80))

    const geoJSON: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: circles,
    }

    if (map.getSource('impact-buffers')) {
      ;(map.getSource('impact-buffers') as mapboxgl.GeoJSONSource).setData(geoJSON)
    } else {
      map.addSource('impact-buffers', { type: 'geojson', data: geoJSON })
      map.addLayer(
        {
          id: 'impact-fill',
          type: 'fill',
          source: 'impact-buffers',
          paint: {
            'fill-color': '#ff4444',
            'fill-opacity': 0.15,
          },
        },
        'stations-circle',
      )
      map.addLayer(
        {
          id: 'impact-line',
          type: 'line',
          source: 'impact-buffers',
          paint: {
            'line-color': '#ff4444',
            'line-width': 2,
            'line-dasharray': [3, 2],
          },
        },
        'stations-circle',
      )
    }

    setActiveActions((prev) => new Set(prev).add('impact'))
    return `已为 AQI > 150 的 <b>${highStations.length}</b> 个站点绘制 80km 影响范围。<br>红色虚线圆圈表示可能受污染影响的区域。`
  }, [])

  const enablePredictionMode = useCallback((): string => {
    const map = mapRef.current
    if (!map) return ''

    if (predictionModeRef.current) {
      predictionModeRef.current = false
      map.getCanvas().style.cursor = ''
      setActiveActions((prev) => {
        const next = new Set(prev)
        next.delete('predict')
        return next
      })
      if (predictionPopupRef.current) {
        predictionPopupRef.current.remove()
        predictionPopupRef.current = null
      }
      return '已关闭空间预测模式。'
    }

    predictionModeRef.current = true
    map.getCanvas().style.cursor = 'crosshair'
    setActiveActions((prev) => new Set(prev).add('predict'))
    return (
      '已开启 <b>空间预测模式</b>。<br>' +
      '点击地图任意位置，将通过 <b>IDW（反距离加权）插值算法</b>预测该位置的 PM2.5 浓度。<br><br>' +
      '再次点击按钮可关闭预测模式。'
    )
  }, [])

  const showStatistics = useCallback((): string => {
    const values = stations.map((s) => s.pm25)
    const sorted = [...values].sort((a, b) => a - b)
    const n = sorted.length
    const sum = sorted.reduce((a, b) => a + b, 0)
    const mean = sum / n
    const median =
      n % 2 === 0 ? (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2 : sorted[Math.floor(n / 2)]!
    const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n)
    const maxS = stations.reduce((a, b) => (a.pm25 > b.pm25 ? a : b))
    const minS = stations.reduce((a, b) => (a.pm25 < b.pm25 ? a : b))

    const grades = [
      { label: '优 (0-50)', count: stations.filter((s) => s.aqi <= 50).length, color: '#00e400' },
      {
        label: '良 (51-100)',
        count: stations.filter((s) => s.aqi > 50 && s.aqi <= 100).length,
        color: '#ffff00',
      },
      {
        label: '轻度污染 (101-150)',
        count: stations.filter((s) => s.aqi > 100 && s.aqi <= 150).length,
        color: '#ff7e00',
      },
      {
        label: '中度污染 (151-200)',
        count: stations.filter((s) => s.aqi > 150 && s.aqi <= 200).length,
        color: '#ff0000',
      },
      {
        label: '重度污染 (>200)',
        count: stations.filter((s) => s.aqi > 200).length,
        color: '#8f3f97',
      },
    ]

    const gradeHTML = grades
      .map((g) => `<span style="color:${g.color}">●</span> ${g.label}：${g.count} 站`)
      .join('<br>')

    return (
      `📊 <b>全网监测站统计</b><br><br>` +
      `站点总数：<b>${n}</b><br>` +
      `PM2.5 均值：<b>${mean.toFixed(1)}</b> μg/m³<br>` +
      `PM2.5 中位数：<b>${median.toFixed(1)}</b> μg/m³<br>` +
      `标准差：<b>${std.toFixed(1)}</b> μg/m³<br>` +
      `最高：<b>${maxS.pm25}</b> μg/m³（${maxS.name}）<br>` +
      `最低：<b>${minS.pm25}</b> μg/m³（${minS.name}）<br><br>` +
      `<b>空气质量分级：</b><br>${gradeHTML}`
    )
  }, [])

  const resetAnalysis = useCallback((): string => {
    const map = mapRef.current
    if (!map) return ''

    const layersToRemove = [
      'anomaly-pulse',
      'anomaly-core',
      'stations-heatmap',
      'impact-fill',
      'impact-line',
    ]
    layersToRemove.forEach((id) => {
      if (map.getLayer(id)) map.removeLayer(id)
    })

    const sourcesToRemove = ['anomalies', 'impact-buffers']
    sourcesToRemove.forEach((id) => {
      if (map.getSource(id)) map.removeSource(id)
    })

    const src = map.getSource('stations') as mapboxgl.GeoJSONSource | undefined
    if (src) src.setData(stationsToGeoJSON())

    map.setPaintProperty('stations-circle', 'circle-color', [
      'step',
      ['get', 'aqi'],
      '#00e400',
      50,
      '#ffff00',
      100,
      '#ff7e00',
      150,
      '#ff0000',
      200,
      '#8f3f97',
    ])
    map.setPaintProperty('stations-circle', 'circle-radius', 6)

    predictionModeRef.current = false
    map.getCanvas().style.cursor = ''
    if (predictionPopupRef.current) {
      predictionPopupRef.current.remove()
      predictionPopupRef.current = null
    }

    setActiveActions(new Set())
    return '已清除所有分析图层，恢复初始状态。'
  }, [])

  const executeAction = useCallback(
    async (id: string) => {
      let result = ''
      switch (id) {
        case 'cluster':
          result = runClustering()
          break
        case 'anomaly':
          result = runAnomalyDetection()
          break
        case 'heatmap':
          result = toggleHeatmap()
          break
        case 'impact':
          result = runImpactAnalysis()
          break
        case 'predict':
          result = enablePredictionMode()
          break
        case 'stats':
          result = showStatistics()
          break
        case 'reset':
          result = resetAnalysis()
          break
      }

      if (result) {
        await addAssistant(result)
      }
    },
    [
      addAssistant,
      enablePredictionMode,
      resetAnalysis,
      runAnomalyDetection,
      runClustering,
      runImpactAnalysis,
      showStatistics,
      toggleHeatmap,
    ],
  )

  const handleSend = useCallback(async () => {
    const text = userInput.trim()
    if (!text) return

    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setUserInput('')
    await delay(0)
    scrollToBottom()

    if (/聚类|分群|kmeans|cluster/i.test(text)) {
      await executeAction('cluster')
    } else if (/异常|离群|outlier|anomal/i.test(text)) {
      await executeAction('anomaly')
    } else if (/热力|heatmap|插值|分布/i.test(text)) {
      await executeAction('heatmap')
    } else if (/影响|缓冲|buffer|范围/i.test(text)) {
      await executeAction('impact')
    } else if (/预测|predict|idw/i.test(text)) {
      await executeAction('predict')
    } else if (/统计|概况|stat|汇总/i.test(text)) {
      await executeAction('stats')
    } else if (/重置|清除|reset|清空/i.test(text)) {
      await executeAction('reset')
    } else {
      await addAssistant(
        '抱歉，我暂时无法理解该指令。<br>请尝试以下命令：<br>' +
          '• <b>聚类分析</b> — K-Means 空间聚类<br>' +
          '• <b>异常检测</b> — Z-Score 异常站点<br>' +
          '• <b>热力图</b> — PM2.5 分布热力图<br>' +
          '• <b>影响范围</b> — 高污染影响区域<br>' +
          '• <b>空间预测</b> — IDW 插值预测<br>' +
          '• <b>统计概况</b> — 数据统计分析<br>' +
          '• <b>重置</b> — 清除分析结果',
      )
    }
  }, [addAssistant, executeAction, scrollToBottom, userInput])

  useEffect(() => {
    if (!mapContainer.current) return

    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: MAP_STYLES.DARK,
      center: [105, 35],
      zoom: 3.8,
      antialias: true,
    })

    mapRef.current = map

    map.addControl(new mapboxgl.NavigationControl(), 'top-left')

    function onMapClick(e: mapboxgl.MapMouseEvent) {
      if (!predictionModeRef.current || !mapRef.current) return

      const { lng, lat } = e.lngLat
      const predicted = idwPredict(lng, lat, stations)

      const color = predicted > 100 ? '#e74c3c' : predicted > 50 ? '#f39c12' : '#27ae60'

      if (predictionPopupRef.current) predictionPopupRef.current.remove()
      predictionPopupRef.current = new mapboxgl.Popup({ closeOnClick: true })
        .setLngLat([lng, lat])
        .setHTML(
          `<div style="font-size:13px;line-height:1.6">` +
            `<b>🤖 AI 空间预测</b><br>` +
            `经度：${lng.toFixed(3)}°<br>` +
            `纬度：${lat.toFixed(3)}°<br>` +
            `预测 PM2.5：<b style="color:${color}">${predicted}</b> μg/m³<br>` +
            `<span style="color:#888;font-size:11px">基于 IDW 反距离加权插值</span>` +
            `</div>`,
        )
        .addTo(mapRef.current)
    }

    map.on('load', () => {
      map.addSource('stations', {
        type: 'geojson',
        data: stationsToGeoJSON(),
      })

      map.addLayer({
        id: 'stations-circle',
        type: 'circle',
        source: 'stations',
        paint: {
          'circle-radius': 6,
          'circle-color': [
            'step',
            ['get', 'aqi'],
            '#00e400',
            50,
            '#ffff00',
            100,
            '#ff7e00',
            150,
            '#ff0000',
            200,
            '#8f3f97',
          ],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#fff',
          'circle-opacity': 0.9,
        },
      })

      map.addLayer({
        id: 'stations-label',
        type: 'symbol',
        source: 'stations',
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 11,
          'text-offset': [0, 1.5],
          'text-anchor': 'top',
        },
        paint: {
          'text-color': '#ddd',
          'text-halo-color': '#000',
          'text-halo-width': 1,
        },
        minzoom: 6,
      })

      map.on('click', 'stations-circle', (e) => {
        if (predictionModeRef.current) return
        if (!e.features || !e.features[0]) return

        const props = e.features[0].properties!
        const coords = (e.features[0].geometry as GeoJSON.Point).coordinates as [number, number]

        new mapboxgl.Popup({ closeOnClick: true })
          .setLngLat(coords)
          .setHTML(
            `<div style="font-size:13px;line-height:1.6">` +
              `<b>${props.name}</b><br>` +
              `PM2.5：<b>${props.pm25}</b> μg/m³<br>` +
              `AQI：<b>${props.aqi}</b><br>` +
              `温度：${props.temperature}°C<br>` +
              `湿度：${props.humidity}%` +
              `</div>`,
          )
          .addTo(map)
      })

      map.on('click', onMapClick)

      map.on('mouseenter', 'stations-circle', () => {
        if (!predictionModeRef.current && mapRef.current) {
          mapRef.current.getCanvas().style.cursor = 'pointer'
        }
      })
      map.on('mouseleave', 'stations-circle', () => {
        if (!predictionModeRef.current && mapRef.current) {
          mapRef.current.getCanvas().style.cursor = ''
        }
      })
    })

    return () => {
      if (predictionPopupRef.current) predictionPopupRef.current.remove()
      map.remove()
      mapRef.current = null
    }
  }, [])

  return (
    <div className="gis-ai-demo-container">
      <div ref={mapContainer} className="gis-ai-map-container" />

      <div className="gis-ai-panel">
        <div className="gis-ai-panel-header">
          <div className="gis-ai-header-icon">🧠</div>
          <div className="gis-ai-header-info">
            <h3>GIS 智能分析助手</h3>
            <span className="gis-ai-status-text">{stations.length} 个空气监测站已加载</span>
          </div>
        </div>

        <div className="gis-ai-chat-area" ref={chatArea}>
          {messages.map((msg, i) => (
            <div key={i} className={`gis-ai-message ${msg.role}`}>
              {msg.role === 'user' ? (
                <div className="gis-ai-message-bubble">{msg.content}</div>
              ) : (
                <div className="gis-ai-message-bubble" dangerouslySetInnerHTML={{ __html: msg.content }} />
              )}
            </div>
          ))}
          {isThinking && (
            <div className="gis-ai-message assistant">
              <div className="gis-ai-message-bubble gis-ai-thinking-bubble">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
              </div>
            </div>
          )}
        </div>

        <div className="gis-ai-quick-actions">
          {quickActions.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={() => executeAction(action.id)}
              className={`gis-ai-action-btn${activeActions.has(action.id) ? ' active' : ''}`}
            >
              {action.icon} {action.label}
            </button>
          ))}
        </div>

        <div className="gis-ai-input-area">
          <input
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSend()
            }}
            placeholder="输入分析指令，如：聚类分析、异常检测..."
            className="gis-ai-chat-input"
          />
          <button type="button" onClick={() => void handleSend()} className="gis-ai-send-btn">
            发送
          </button>
        </div>
      </div>
    </div>
  )
}
