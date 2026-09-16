import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MAPBOX_ACCESS_TOKEN, MAP_STYLES } from '@/config/mapbox'
import droneModelUrl from '@/images/evtol.glb?url'
import './DroneFleetHud.css'

const ORIGIN: [number, number] = [116.3912, 39.9055]
const SPREAD = 0.028
const DRONE_TOTAL = 66

const BASE_SIZE_METERS = 45
const REFERENCE_ZOOM = 14

const ALT_MIN = 60
const ALT_MAX = 200
const CRUISE_MIN = 12
const CRUISE_MAX = 28
const TURN_RATE = 0.7
const MAX_BANK = 0.55
const WP_REACH = 120

const TRAIL_MAX = 90
const TRAIL_SAMPLE_DT = 0.1
const TRAIL_WIDTH = 12

const MODEL_HEADING_OFFSET = 0

const COLOR_ONLINE = new THREE.Color(0x29ffd0)
const COLOR_OFFLINE = new THREE.Color(0x5b6b7a)

interface Drone {
  id: number
  online: boolean
  lng: number
  lat: number
  alt: number
  tLng: number
  tLat: number
  tAlt: number
  heading: number
  bank: number
  pitch: number
  speed: number
  cruise: number
  blink: number
  rotorSpin: number
  root: THREE.Group
  tilt: THREE.Group
  rotors: THREE.Object3D | null
  materials: THREE.MeshStandardMaterial[]
  light: THREE.Mesh
  trail: number[]
  trailLen: number
  trailTimer: number
  trailPos: Float32Array
  trailCol: Float32Array
  trailLine: THREE.Mesh
  dropPos: Float32Array
  dropLine: THREE.Line
}

interface FleetRuntime {
  map: mapboxgl.Map | null
  scene: THREE.Scene | null
  camera: THREE.Camera | null
  renderer: THREE.WebGLRenderer | null
  droneTemplate: THREE.Object3D | null
  drones: Drone[]
  zoomAdaptive: boolean
  showTrails: boolean
  showDropLines: boolean
  flying: boolean
  sizeFactor: number
  setOnlineCount: (n: number) => void
  setOfflineCount: (n: number) => void
  setLoadStatus: (s: string) => void
}

const refMercator = mapboxgl.MercatorCoordinate.fromLngLat(ORIGIN, 0)
const refScale = refMercator.meterInMercatorCoordinateUnits()

const camMatrix = new THREE.Matrix4()
const worldMatrix = new THREE.Matrix4()
const worldScale = new THREE.Vector3(refScale, -refScale, refScale)
const _scenePt: [number, number, number] = [0, 0, 0]

let lastTime = performance.now()
let runtime: FleetRuntime | null = null

function toScene(lng: number, lat: number, alt: number, out: [number, number, number]) {
  const m = mapboxgl.MercatorCoordinate.fromLngLat([lng, lat], alt)
  out[0] = (m.x - refMercator.x) / refScale
  out[1] = -(m.y - refMercator.y) / refScale
  out[2] = (m.z - refMercator.z) / refScale
  return out
}

function createProceduralDrone(): THREE.Object3D {
  const drone = new THREE.Group()
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2c3e50, metalness: 0.6, roughness: 0.4 })
  const rotorMat = new THREE.MeshStandardMaterial({
    color: 0x111111,
    metalness: 0.3,
    roughness: 0.7,
    transparent: true,
    opacity: 0.5
  })

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.16), bodyMat)
  drone.add(body)

  const arm = 0.5
  const rotors = new THREE.Group()
  rotors.name = 'rotors'
  for (const [ax, ay] of [
    [arm, arm],
    [-arm, arm],
    [arm, -arm],
    [-arm, -arm]
  ] as Array<[number, number]>) {
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.1, 10), bodyMat)
    motor.position.set(ax, ay, 0.05)
    motor.rotation.x = Math.PI / 2
    drone.add(motor)
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.01), rotorMat)
    blade.position.set(ax, ay, 0.12)
    rotors.add(blade)
  }
  drone.add(rotors)
  return drone
}

function normalizeModel(model: THREE.Object3D): THREE.Object3D {
  const box = new THREE.Box3().setFromObject(model)
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(center)
  const maxDim = Math.max(size.x, size.y, size.z) || 1

  model.position.sub(center)
  model.rotation.x = Math.PI / 2

  const wrapper = new THREE.Group()
  wrapper.scale.setScalar(1 / maxDim)
  wrapper.add(model)
  return wrapper
}

function collectMaterials(obj: THREE.Object3D): THREE.MeshStandardMaterial[] {
  const list: THREE.MeshStandardMaterial[] = []
  obj.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    const mats = Array.isArray(child.material) ? child.material : [child.material]
    const cloned = mats.map((m) => {
      const std =
        m instanceof THREE.MeshStandardMaterial
          ? (m.clone() as THREE.MeshStandardMaterial)
          : new THREE.MeshStandardMaterial({ color: 0x9aa6b2, metalness: 0.5, roughness: 0.5 })
      list.push(std)
      return std
    })
    child.material = Array.isArray(child.material) ? cloned : cloned[0]!
  })
  return list
}

function randLng() {
  return ORIGIN[0] + (Math.random() - 0.5) * SPREAD * 2
}
function randLat() {
  return ORIGIN[1] + (Math.random() - 0.5) * SPREAD * 2
}
function randAlt() {
  return ALT_MIN + Math.random() * (ALT_MAX - ALT_MIN)
}

function placeDrone(drone: Drone) {
  toScene(drone.lng, drone.lat, drone.alt, _scenePt)
  drone.root.position.set(_scenePt[0], _scenePt[1], _scenePt[2])
  drone.root.rotation.z = -drone.heading + MODEL_HEADING_OFFSET
  drone.tilt.rotation.set(drone.pitch, drone.bank, 0)
}

function createDrone(id: number): Drone {
  const rt = runtime!
  const online = Math.random() > 0.32
  const statusColor = online ? COLOR_ONLINE : COLOR_OFFLINE

  const root = new THREE.Group()
  const tilt = new THREE.Group()
  root.add(tilt)

  const model = (rt.droneTemplate as THREE.Object3D).clone(true)
  const materials = collectMaterials(model)
  tilt.add(model)

  materials.forEach((m) => {
    m.emissive = statusColor.clone()
    m.emissiveIntensity = online ? 0.25 : 0.08
  })

  const light = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 16, 12),
    new THREE.MeshBasicMaterial({ color: statusColor, transparent: true })
  )
  light.position.set(0, 0, 0.7)
  root.add(light)

  const trailPos = new Float32Array(TRAIL_MAX * 2 * 3)
  const trailCol = new Float32Array(TRAIL_MAX * 2 * 3)
  const trailGeo = new THREE.BufferGeometry()
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3))
  trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3))
  const trailIdx = new Uint16Array((TRAIL_MAX - 1) * 6)
  for (let i = 0; i < TRAIL_MAX - 1; i++) {
    const a = i * 2
    const o = i * 6
    trailIdx[o] = a
    trailIdx[o + 1] = a + 1
    trailIdx[o + 2] = a + 2
    trailIdx[o + 3] = a + 1
    trailIdx[o + 4] = a + 3
    trailIdx[o + 5] = a + 2
  }
  trailGeo.setIndex(new THREE.BufferAttribute(trailIdx, 1))
  trailGeo.setDrawRange(0, 0)
  const trailLine = new THREE.Mesh(
    trailGeo,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  )
  trailLine.frustumCulled = false

  const dropPos = new Float32Array(6)
  const dropGeo = new THREE.BufferGeometry()
  dropGeo.setAttribute('position', new THREE.BufferAttribute(dropPos, 3))
  const dropLine = new THREE.Line(
    dropGeo,
    new THREE.LineBasicMaterial({
      color: statusColor,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
  )
  dropLine.frustumCulled = false

  const drone: Drone = {
    id,
    online,
    lng: randLng(),
    lat: randLat(),
    alt: randAlt(),
    tLng: randLng(),
    tLat: randLat(),
    tAlt: randAlt(),
    heading: Math.random() * Math.PI * 2,
    bank: 0,
    pitch: 0,
    speed: 0,
    cruise: CRUISE_MIN + Math.random() * (CRUISE_MAX - CRUISE_MIN),
    blink: Math.random() * Math.PI * 2,
    rotorSpin: 0,
    root,
    tilt,
    rotors: model.getObjectByName('rotors') ?? null,
    materials,
    light,
    trail: [],
    trailLen: 0,
    trailTimer: 0,
    trailPos,
    trailCol,
    trailLine,
    dropPos,
    dropLine
  }

  placeDrone(drone)
  return drone
}

function normalizeAngle(a: number) {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}

function updateDrop(drone: Drone) {
  toScene(drone.lng, drone.lat, drone.alt, _scenePt)
  drone.dropPos[0] = _scenePt[0]
  drone.dropPos[1] = _scenePt[1]
  drone.dropPos[2] = _scenePt[2]
  toScene(drone.lng, drone.lat, 0, _scenePt)
  drone.dropPos[3] = _scenePt[0]
  drone.dropPos[4] = _scenePt[1]
  drone.dropPos[5] = _scenePt[2]
  ;(drone.dropLine.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
}

function pushTrail(drone: Drone) {
  toScene(drone.lng, drone.lat, drone.alt, _scenePt)
  drone.trail.push(_scenePt[0], _scenePt[1], _scenePt[2])
  if (drone.trail.length > TRAIL_MAX * 3) drone.trail.splice(0, 3)

  const n = drone.trail.length / 3
  drone.trailLen = n
  if (n < 2) {
    drone.trailLine.geometry.setDrawRange(0, 0)
    return
  }

  const c = drone.online ? COLOR_ONLINE : COLOR_OFFLINE
  const half = TRAIL_WIDTH / 2

  for (let i = 0; i < n; i++) {
    const px = drone.trail[i * 3]!
    const py = drone.trail[i * 3 + 1]!
    const pz = drone.trail[i * 3 + 2]!

    const i0 = Math.max(0, i - 1)
    const i1 = Math.min(n - 1, i + 1)
    const tx = drone.trail[i1 * 3]! - drone.trail[i0 * 3]!
    const ty = drone.trail[i1 * 3 + 1]! - drone.trail[i0 * 3 + 1]!
    let nx = ty
    let ny = -tx
    const len = Math.hypot(nx, ny) || 1
    nx = (nx / len) * half
    ny = (ny / len) * half

    const b = Math.pow(i / Math.max(1, n - 1), 1.6)
    const r = c.r * b
    const g = c.g * b
    const bl = c.b * b

    const o = i * 6
    drone.trailPos[o] = px + nx
    drone.trailPos[o + 1] = py + ny
    drone.trailPos[o + 2] = pz
    drone.trailPos[o + 3] = px - nx
    drone.trailPos[o + 4] = py - ny
    drone.trailPos[o + 5] = pz
    drone.trailCol[o] = r
    drone.trailCol[o + 1] = g
    drone.trailCol[o + 2] = bl
    drone.trailCol[o + 3] = r
    drone.trailCol[o + 4] = g
    drone.trailCol[o + 5] = bl
  }
  const geo = drone.trailLine.geometry
  ;(geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
  ;(geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true
  geo.setDrawRange(0, (n - 1) * 6)
}

function updateAnimation() {
  const rt = runtime
  if (!rt) return

  const now = performance.now()
  const dt = Math.min((now - lastTime) / 1000, 0.05)
  lastTime = now

  const zoom = rt.map ? rt.map.getZoom() : REFERENCE_ZOOM
  let zoomMul = 1
  if (rt.zoomAdaptive) {
    zoomMul = Math.min(Math.max(Math.pow(2, REFERENCE_ZOOM - zoom), 0.15), 48)
  }
  const finalScale = BASE_SIZE_METERS * rt.sizeFactor * zoomMul

  const cosLat = Math.cos((ORIGIN[1] * Math.PI) / 180)

  for (const drone of rt.drones) {
    drone.root.scale.setScalar(finalScale)

    if (drone.online) {
      drone.blink += dt * 5
      const pulse = 0.5 + 0.5 * Math.sin(drone.blink)
      ;(drone.light.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.65 * pulse
      const emi = 0.2 + 0.5 * pulse
      for (const m of drone.materials) m.emissiveIntensity = emi
      if (drone.rotors) drone.rotors.rotation.z += dt * 45
    }

    if (rt.flying && drone.online) {
      const dNorth = (drone.tLat - drone.lat) * 111320
      const dEast = (drone.tLng - drone.lng) * 111320 * cosLat
      const distH = Math.hypot(dNorth, dEast)
      const targetHeading = Math.atan2(dEast, dNorth)
      const diff = normalizeAngle(targetHeading - drone.heading)
      const turn = Math.max(-TURN_RATE * dt, Math.min(TURN_RATE * dt, diff))
      drone.heading += turn

      const bankTarget = Math.max(-1, Math.min(1, diff)) * MAX_BANK
      drone.bank += (bankTarget - drone.bank) * Math.min(1, dt * 4)
      const altDiff = drone.tAlt - drone.alt
      const pitchTarget = Math.max(-0.18, Math.min(0.18, altDiff * 0.01))
      drone.pitch += (pitchTarget - drone.pitch) * Math.min(1, dt * 3)

      drone.speed += (drone.cruise - drone.speed) * Math.min(1, dt * 2)

      const distM = drone.speed * dt
      drone.lat += (Math.cos(drone.heading) * distM) / 111320
      drone.lng += (Math.sin(drone.heading) * distM) / (111320 * cosLat)
      drone.alt += Math.max(-12 * dt, Math.min(12 * dt, altDiff))

      if (distH < WP_REACH) {
        drone.tLng = randLng()
        drone.tLat = randLat()
        drone.tAlt = randAlt()
      }

      placeDrone(drone)
      updateDrop(drone)

      drone.trailTimer += dt
      if (drone.trailTimer >= TRAIL_SAMPLE_DT) {
        drone.trailTimer = 0
        pushTrail(drone)
      }
    }

    drone.trailLine.visible = rt.showTrails && drone.online && drone.trailLen > 1
    drone.dropLine.visible = rt.showDropLines && drone.online
  }
}

function buildFleet() {
  const rt = runtime
  if (!rt?.scene) return
  let online = 0
  for (let i = 0; i < DRONE_TOTAL; i++) {
    const drone = createDrone(i)
    rt.drones.push(drone)
    rt.scene.add(drone.root, drone.trailLine, drone.dropLine)
    if (drone.online) online++
  }
  rt.setOnlineCount(online)
  rt.setOfflineCount(DRONE_TOTAL - online)
}

function loadDroneTemplate(): Promise<void> {
  const rt = runtime!
  return new Promise((resolve) => {
    new GLTFLoader().load(
      droneModelUrl,
      (gltf) => {
        rt.droneTemplate = normalizeModel(gltf.scene)
        rt.setLoadStatus('')
        resolve()
      },
      undefined,
      () => {
        rt.droneTemplate = createProceduralDrone()
        rt.setLoadStatus('未能加载 eVTOL 模型, 已使用内置无人机')
        resolve()
      }
    )
  })
}

export default function DroneFleetDemoInit() {
  const mapContainer = useRef<HTMLDivElement>(null)

  const [onlineCount, setOnlineCount] = useState(0)
  const [offlineCount, setOfflineCount] = useState(0)
  const [currentZoom, setCurrentZoom] = useState(REFERENCE_ZOOM)
  const [zoomAdaptive, setZoomAdaptive] = useState(true)
  const [showTrails, setShowTrails] = useState(true)
  const [showDropLines, setShowDropLines] = useState(true)
  const [flying, setFlying] = useState(true)
  const [sizeFactor, setSizeFactor] = useState(1.0)
  const [loadStatus, setLoadStatus] = useState('正在加载 eVTOL 模型…')

  const zoomAdaptiveRef = useRef(zoomAdaptive)
  const showTrailsRef = useRef(showTrails)
  const showDropLinesRef = useRef(showDropLines)
  const flyingRef = useRef(flying)
  const sizeFactorRef = useRef(sizeFactor)
  zoomAdaptiveRef.current = zoomAdaptive
  showTrailsRef.current = showTrails
  showDropLinesRef.current = showDropLines
  flyingRef.current = flying
  sizeFactorRef.current = sizeFactor

  useEffect(() => {
    runtime?.map?.triggerRepaint()
  }, [zoomAdaptive, showTrails, showDropLines, flying, sizeFactor])

  useEffect(() => {
    if (!mapContainer.current) return

    runtime = {
      map: null,
      scene: null,
      camera: null,
      renderer: null,
      droneTemplate: null,
      drones: [],
      get zoomAdaptive() {
        return zoomAdaptiveRef.current
      },
      get showTrails() {
        return showTrailsRef.current
      },
      get showDropLines() {
        return showDropLinesRef.current
      },
      get flying() {
        return flyingRef.current
      },
      get sizeFactor() {
        return sizeFactorRef.current
      },
      setOnlineCount,
      setOfflineCount,
      setLoadStatus
    }

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
    runtime.map = map

    map.addControl(new mapboxgl.NavigationControl(), 'top-right')
    map.on('zoom', () => {
      setCurrentZoom(map.getZoom())
    })

    const customLayer: mapboxgl.CustomLayerInterface = {
      id: 'drone-fleet-layer',
      type: 'custom',
      renderingMode: '3d',

      async onAdd(_map, gl) {
        const rt = runtime!
        rt.scene = new THREE.Scene()
        rt.camera = new THREE.Camera()

        rt.scene.add(new THREE.AmbientLight(0xbcd4ff, 0.9))
        const key = new THREE.DirectionalLight(0xffffff, 1.5)
        key.position.set(0, -1, 1).normalize()
        rt.scene.add(key)
        const rim = new THREE.DirectionalLight(0x4d9cff, 0.7)
        rim.position.set(1, 1, 0.4).normalize()
        rt.scene.add(rim)

        rt.renderer = new THREE.WebGLRenderer({ canvas: _map.getCanvas(), context: gl, antialias: true })
        rt.renderer.autoClear = false

        await loadDroneTemplate()
        buildFleet()
        _map.triggerRepaint()
      },

      render(_gl, matrix) {
        const rt = runtime
        if (!rt?.scene || !rt.camera || !rt.renderer || !rt.map) return
        updateAnimation()

        camMatrix.fromArray(matrix as unknown as ArrayLike<number>)
        worldMatrix
          .makeTranslation(refMercator.x, refMercator.y, refMercator.z)
          .scale(worldScale)
        rt.camera.projectionMatrix = camMatrix.multiply(worldMatrix)

        rt.renderer.resetState()
        rt.renderer.render(rt.scene, rt.camera)
        rt.map.triggerRepaint()
      },

      onRemove() {
        const rt = runtime
        rt?.renderer?.dispose()
        if (rt) {
          rt.renderer = null
          rt.scene?.traverse((obj) => {
            if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
              obj.geometry.dispose()
              const mat = obj.material
              Array.isArray(mat) ? mat.forEach((m) => m.dispose()) : (mat as THREE.Material).dispose()
            }
          })
          rt.scene = null
          rt.camera = null
          rt.drones.length = 0
        }
      }
    }

    map.on('style.load', () => map.addLayer(customLayer))

    return () => {
      map.remove()
      runtime = null
      lastTime = performance.now()
    }
  }, [])

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
            <span className="tag online">ONLINE</span>
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
          <label className="hud-switch">
            <input
              type="checkbox"
              checked={zoomAdaptive}
              onChange={(e) => setZoomAdaptive(e.target.checked)}
            />
            <span>模型大小随缩放自适应</span>
          </label>
          <label className="hud-switch">
            <input
              type="checkbox"
              checked={showTrails}
              onChange={(e) => setShowTrails(e.target.checked)}
            />
            <span>飞行轨迹光带</span>
          </label>
          <label className="hud-switch">
            <input
              type="checkbox"
              checked={showDropLines}
              onChange={(e) => setShowDropLines(e.target.checked)}
            />
            <span>高度投影线</span>
          </label>
          <label className="hud-switch">
            <input type="checkbox" checked={flying} onChange={(e) => setFlying(e.target.checked)} />
            <span>实时飞行</span>
          </label>
          <div className="hud-slider">
            <label>
              基础大小 <b>{sizeFactor.toFixed(1)}x</b>
            </label>
            <input
              type="range"
              value={sizeFactor}
              min={0.2}
              max={4}
              step={0.1}
              onChange={(e) => setSizeFactor(Number(e.target.value))}
            />
          </div>
        </div>

        {loadStatus && <div className="hud-card hud-status">{loadStatus}</div>}
      </div>
    </div>
  )
}
