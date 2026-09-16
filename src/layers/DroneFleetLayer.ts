/**
 * DroneFleetLayer - 低空无人机机群可视化图层
 *
 * 将无人机机群的全部渲染/动画/交互逻辑封装为一个独立类，
 * 实现 mapboxgl.CustomLayerInterface，可直接 addLayer 使用。
 *
 * 能力：
 *  - 加载 GLB 无人机模型（失败回退到程序化模型）
 *  - 数十架无人机航点导航飞行（平滑转向 + 横滚 + 俯仰）
 *  - 在线/离线状态着色，整机发光闪烁（颜色可运行时配置）
 *  - 彗星拖尾光带（粗细 / 颜色 / 颜色模式可调）
 *  - 高度投影线 + 地面雷达脉冲光环等科技效果
 *  - 模型大小随地图缩放自适应
 *  - 速度倍率、在线比例等运行时可调
 */

import mapboxgl from 'mapbox-gl'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/* ═══════════════════════ 类型定义 ═══════════════════════ */

/** 运行时可调配置 */
export interface DroneFleetConfig {
  /** 在线状态颜色（十六进制，如 #29ffd0） */
  onlineColor: string
  /** 离线状态颜色 */
  offlineColor: string
  /** 轨迹颜色模式：跟随状态 / 自定义 */
  trailColorMode: 'status' | 'custom'
  /** 自定义轨迹颜色 */
  trailColor: string
  /** 轨迹光带粗细（像素） */
  trailWidth: number
  /** 全局速度倍率 */
  speedFactor: number
  /** 在线比例 0~1 */
  onlineRatio: number
  /** 基础大小倍率 */
  sizeFactor: number
  /** 模型大小随缩放自适应 */
  zoomAdaptive: boolean
  /** 显示轨迹光带 */
  showTrails: boolean
  /** 显示高度投影线 */
  showDropLines: boolean
  /** 显示地面雷达光环 */
  showHalo: boolean
  /** 实时飞行 */
  flying: boolean
  /** 整机闪烁 */
  blink: boolean
}

/** 构造选项 */
export interface DroneFleetOptions extends Partial<DroneFleetConfig> {
  /** 机群参考中心 [lng, lat] */
  origin?: [number, number]
  /** 无人机数量 */
  total?: number
  /** 经纬度活动半径（度） */
  spread?: number
  /** 单架基础尺寸（米） */
  baseSizeMeters?: number
  /** 自适应缩放参考级别 */
  referenceZoom?: number
  /** GLB 模型地址（必填） */
  modelUrl: string
  /** 在线/离线数量变化回调 */
  onStats?: (online: number, offline: number) => void
}

/** 单架无人机运行时数据 */
interface Drone {
  online: boolean
  // 位置
  lng: number
  lat: number
  alt: number
  // 目标航点
  tLng: number
  tLat: number
  tAlt: number
  // 姿态
  heading: number
  bank: number
  pitch: number
  speed: number
  cruise: number
  blinkPhase: number
  haloPhase: number
  // 场景对象
  root: THREE.Group // 位置 + 航向 + 缩放
  tilt: THREE.Group // 横滚 + 俯仰
  rotors: THREE.Object3D | null
  materials: THREE.MeshStandardMaterial[]
  // 轨迹（彗星拖尾光带，三角带 ribbon 网格，可靠渲染 + 可调粗细）
  trail: number[]
  trailTimer: number
  trailMesh: THREE.Mesh
  trailPos: Float32Array
  trailCol: Float32Array
  // 高度投影线
  dropPos: Float32Array
  dropLine: THREE.Line
  dropMat: THREE.LineBasicMaterial
  // 地面雷达光环
  halo: THREE.Mesh
  haloMat: THREE.MeshBasicMaterial
}

/* ═══════════════════════ 常量 ═══════════════════════ */

const ALT_MIN = 60
const ALT_MAX = 200
const CRUISE_MIN = 12
const CRUISE_MAX = 28
const TURN_RATE = 0.7 // rad/s
const MAX_BANK = 0.55 // rad
const WP_REACH = 120 // m
const TRAIL_MAX = 90
const TRAIL_SAMPLE_DT = 0.1

const DEFAULT_CONFIG: DroneFleetConfig = {
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
}

/* ═══════════════════════ DroneFleetLayer ═══════════════════════ */

export class DroneFleetLayer implements mapboxgl.CustomLayerInterface {
  readonly id = 'drone-fleet-layer'
  readonly type = 'custom' as const
  readonly renderingMode = '3d' as const

  /** 运行时配置（请通过 set* 方法修改以触发副作用） */
  readonly config: DroneFleetConfig

  onlineCount = 0
  offlineCount = 0

  private map: mapboxgl.Map
  private origin: [number, number]
  private total: number
  private spread: number
  private baseSize: number
  private refZoom: number
  private modelUrl: string
  private onStats?: (online: number, offline: number) => void

  private refMercator: mapboxgl.MercatorCoordinate
  private refScale: number

  private scene: THREE.Scene | null = null
  private camera: THREE.Camera | null = null
  private renderer: THREE.WebGLRenderer | null = null
  private template: THREE.Object3D | null = null

  private drones: Drone[] = []
  private trailMaterial: THREE.MeshBasicMaterial | null = null
  private haloGeo: THREE.RingGeometry | null = null

  private colorOnline = new THREE.Color()
  private colorOffline = new THREE.Color()
  private colorTrail = new THREE.Color()

  // 渲染期复用对象
  private camMatrix = new THREE.Matrix4()
  private worldMatrix = new THREE.Matrix4()
  private worldScale: THREE.Vector3
  private scenePt: [number, number, number] = [0, 0, 0]
  private lastTime = performance.now()

  // 性能：缓存 / 脏标记
  private lastScale = -1 // 上一帧最终缩放，变化时才写入 root.scale
  private prevBlink = true // 上一帧闪烁开关，用于在线机静止态只写一次 emissive
  private animating = true // 本帧是否需要继续重绘
  private static readonly EARTH_CIRCUM = 2 * Math.PI * 6371008.8 // 地球周长(米)

  constructor(map: mapboxgl.Map, options: DroneFleetOptions) {
    this.map = map
    this.origin = options.origin ?? [116.3912, 39.9055]
    this.total = options.total ?? 66
    this.spread = options.spread ?? 0.028
    this.baseSize = options.baseSizeMeters ?? 45
    this.refZoom = options.referenceZoom ?? 14
    this.modelUrl = options.modelUrl
    this.onStats = options.onStats

    this.config = { ...DEFAULT_CONFIG, ...options }
    this.colorOnline.set(this.config.onlineColor)
    this.colorOffline.set(this.config.offlineColor)
    this.colorTrail.set(this.config.trailColor)

    this.refMercator = mapboxgl.MercatorCoordinate.fromLngLat(this.origin, 0)
    this.refScale = this.refMercator.meterInMercatorCoordinateUnits()
    this.worldScale = new THREE.Vector3(this.refScale, -this.refScale, this.refScale)
    // 世界矩阵恒定（参考点 + 比例均不变），构造时计算一次，每帧仅与相机矩阵相乘
    this.worldMatrix
      .makeTranslation(this.refMercator.x, this.refMercator.y, this.refMercator.z ?? 0)
      .scale(this.worldScale)
  }

  /* ───────────── CustomLayerInterface ───────────── */

  async onAdd(_map: mapboxgl.Map, gl: WebGLRenderingContext) {
    this.scene = new THREE.Scene()
    this.camera = new THREE.Camera()

    // 光照
    this.scene.add(new THREE.AmbientLight(0xbcd4ff, 0.9))
    const key = new THREE.DirectionalLight(0xffffff, 1.5)
    key.position.set(0, -1, 1).normalize()
    this.scene.add(key)
    const rim = new THREE.DirectionalLight(0x4d9cff, 0.7)
    rim.position.set(1, 1, 0.4).normalize()
    this.scene.add(rim)

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.map.getCanvas(),
      context: gl,
      antialias: true
    })
    this.renderer.autoClear = false

    // 共享资源：轨迹光带使用顶点色 + 叠加发光的 Mesh 材质（在 Mapbox 共享 GL 上下文中稳定渲染）
    this.trailMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide
    })
    this.haloGeo = new THREE.RingGeometry(0.78, 1, 48)

    await this.loadTemplate()
    this.buildFleet()
    this.map.triggerRepaint()
  }

  render(_gl: WebGLRenderingContext, matrix: number[]) {
    if (!this.scene || !this.camera || !this.renderer) return

    this.update()

    // 相机矩阵 = Mapbox 投影矩阵 × 恒定世界矩阵
    this.camMatrix.fromArray(matrix as unknown as ArrayLike<number>)
    this.camera.projectionMatrix = this.camMatrix.multiply(this.worldMatrix)

    this.renderer.resetState()
    this.renderer.render(this.scene, this.camera)

    // 仅在存在动画时持续重绘，静止场景停止重绘以释放 CPU/GPU
    if (this.animating) this.map.triggerRepaint()
  }

  onRemove() {
    this.renderer?.dispose()
    this.renderer = null
    this.scene?.traverse((obj) => {
      const o = obj as THREE.Mesh | THREE.Line
      if (o.geometry) o.geometry.dispose?.()
      const mat = (o as THREE.Mesh).material
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else mat?.dispose?.()
    })
    this.trailMaterial?.dispose()
    this.haloGeo?.dispose()
    this.scene = null
    this.camera = null
    this.drones.length = 0
  }

  /* ───────────── 运行时设置（带副作用） ───────────── */

  setOnlineColor(hex: string) {
    this.config.onlineColor = hex
    this.colorOnline.set(hex)
    this.refreshStatusVisuals()
  }

  setOfflineColor(hex: string) {
    this.config.offlineColor = hex
    this.colorOffline.set(hex)
    this.refreshStatusVisuals()
  }

  setTrailColor(hex: string) {
    this.config.trailColor = hex
    this.colorTrail.set(hex)
  }

  setTrailColorMode(mode: 'status' | 'custom') {
    this.config.trailColorMode = mode
  }

  /** 调整在线比例并就地重置各机状态 */
  setOnlineRatio(ratio: number) {
    this.config.onlineRatio = ratio
    let online = 0
    for (const d of this.drones) {
      d.online = Math.random() < ratio
      if (d.online) online++
      // 重置该机的可见态与轨迹
      d.trail.length = 0
      this.applyDroneStatus(d)
      if (!d.online) {
        d.trailMesh.visible = false
        d.dropLine.visible = false
        d.halo.visible = false
      }
    }
    this.onlineCount = online
    this.offlineCount = this.total - online
    this.onStats?.(this.onlineCount, this.offlineCount)
    this.map.triggerRepaint()
  }

  /* ───────────── 模型加载与构建 ───────────── */

  private loadTemplate(): Promise<void> {
    return new Promise((resolve) => {
      new GLTFLoader().load(
        this.modelUrl,
        (gltf) => {
          this.template = this.normalizeModel(gltf.scene)
          resolve()
        },
        undefined,
        () => {
          this.template = this.createProceduralDrone()
          resolve()
        }
      )
    })
  }

  /** 把模型归一化到约 1 单位大小并直立（Y-up → Z-up） */
  private normalizeModel(model: THREE.Object3D): THREE.Object3D {
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

  /** 程序化无人机（GLB 加载失败时回退） */
  private createProceduralDrone(): THREE.Object3D {
    const drone = new THREE.Group()
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x2c3e50,
      metalness: 0.6,
      roughness: 0.4
    })
    const rotorMat = new THREE.MeshStandardMaterial({
      color: 0x111111,
      metalness: 0.3,
      roughness: 0.7,
      transparent: true,
      opacity: 0.5
    })
    drone.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.16), bodyMat))
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

  /** 克隆并替换为可调色标准材质（支持 emissive 闪烁） */
  private collectMaterials(obj: THREE.Object3D): THREE.MeshStandardMaterial[] {
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

  private buildFleet() {
    if (!this.scene) return
    let online = 0
    const onlineTarget = Math.round(this.total * this.config.onlineRatio)
    for (let i = 0; i < this.total; i++) {
      const isOnline = i < onlineTarget
      const drone = this.createDrone(isOnline)
      this.drones.push(drone)
      this.scene.add(drone.root, drone.trailMesh, drone.dropLine, drone.halo)
      if (drone.online) online++
    }
    // 打散在线/离线顺序的视觉聚集（简单洗牌状态位）
    this.onlineCount = online
    this.offlineCount = this.total - online
    this.onStats?.(this.onlineCount, this.offlineCount)
  }

  private randLng() {
    return this.origin[0] + (Math.random() - 0.5) * this.spread * 2
  }
  private randLat() {
    return this.origin[1] + (Math.random() - 0.5) * this.spread * 2
  }
  private randAlt() {
    return ALT_MIN + Math.random() * (ALT_MAX - ALT_MIN)
  }

  private createDrone(online: boolean): Drone {
    const root = new THREE.Group()
    const tilt = new THREE.Group()
    root.add(tilt)

    const model = (this.template as THREE.Object3D).clone(true)
    const materials = this.collectMaterials(model)
    tilt.add(model)

    // ───── 状态指示灯（已按需求注释，改为整机闪烁）─────
    // const light = new THREE.Mesh(
    //   new THREE.SphereGeometry(0.16, 16, 12),
    //   new THREE.MeshBasicMaterial({ color: statusColor, transparent: true })
    // )
    // light.position.set(0, 0, 0.7)
    // root.add(light)

    // 轨迹光带（三角带 ribbon：每个轨迹点生成左右两个顶点，宽度可调）
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
    const trailMesh = new THREE.Mesh(trailGeo, this.trailMaterial!)
    trailMesh.frustumCulled = false
    trailMesh.visible = false

    // 高度投影线
    const dropPos = new Float32Array(6)
    const dropGeo = new THREE.BufferGeometry()
    dropGeo.setAttribute('position', new THREE.BufferAttribute(dropPos, 3))
    const dropMat = new THREE.LineBasicMaterial({
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    const dropLine = new THREE.Line(dropGeo, dropMat)
    dropLine.frustumCulled = false

    // 地面雷达脉冲光环
    const haloMat = new THREE.MeshBasicMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide
    })
    const halo = new THREE.Mesh(this.haloGeo!, haloMat)
    halo.frustumCulled = false

    const drone: Drone = {
      online,
      lng: this.randLng(),
      lat: this.randLat(),
      alt: this.randAlt(),
      tLng: this.randLng(),
      tLat: this.randLat(),
      tAlt: this.randAlt(),
      heading: Math.random() * Math.PI * 2,
      bank: 0,
      pitch: 0,
      speed: 0,
      cruise: CRUISE_MIN + Math.random() * (CRUISE_MAX - CRUISE_MIN),
      blinkPhase: Math.random() * Math.PI * 2,
      haloPhase: Math.random(),
      root,
      tilt,
      rotors: model.getObjectByName('rotors') ?? null,
      materials,
      trail: [],
      trailTimer: 0,
      trailMesh,
      trailPos,
      trailCol,
      dropPos,
      dropLine,
      dropMat,
      halo,
      haloMat
    }

    this.applyDroneStatus(drone)
    this.place(drone)
    // 离线机不参与渲染循环，创建时直接隐藏其轨迹/投影线/光环
    if (!online) {
      drone.dropLine.visible = false
      drone.halo.visible = false
    }
    return drone
  }

  /** 根据在线状态刷新单机配色 */
  private applyDroneStatus(drone: Drone) {
    const c = drone.online ? this.colorOnline : this.colorOffline
    for (const m of drone.materials) {
      m.emissive.copy(c)
      m.emissiveIntensity = drone.online ? 0.8 : 0.5
    }
    drone.dropMat.color.copy(c)
    drone.haloMat.color.copy(c)
  }

  /** 颜色变更后刷新全部单机 */
  private refreshStatusVisuals() {
    for (const d of this.drones) this.applyDroneStatus(d)
    this.map.triggerRepaint()
  }

  /* ───────────── 坐标与姿态 ───────────── */

  private toScene(lng: number, lat: number, alt: number, out: [number, number, number]) {
    // 直接进行墨卡托投影，避免每次调用都分配 MercatorCoordinate 对象（每帧数百次调用）
    const latRad = (lat * Math.PI) / 180
    const mx = (180 + lng) / 360
    const my = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + latRad / 2))) / 360
    const mz = alt / (DroneFleetLayer.EARTH_CIRCUM * Math.cos(latRad))
    out[0] = (mx - this.refMercator.x) / this.refScale
    out[1] = -(my - this.refMercator.y) / this.refScale
    out[2] = (mz - (this.refMercator.z ?? 0)) / this.refScale
    return out
  }

  private place(drone: Drone) {
    this.toScene(drone.lng, drone.lat, drone.alt, this.scenePt)
    drone.root.position.set(this.scenePt[0], this.scenePt[1], this.scenePt[2])
    drone.root.rotation.z = -drone.heading
    drone.tilt.rotation.set(drone.pitch, drone.bank, 0)
  }

  private static normalizeAngle(a: number) {
    while (a > Math.PI) a -= Math.PI * 2
    while (a < -Math.PI) a += Math.PI * 2
    return a
  }

  /* ───────────── 每帧动画 ───────────── */

  private update() {
    const now = performance.now()
    const dt = Math.min((now - this.lastTime) / 1000, 0.05)
    this.lastTime = now
    const t = now / 1000

    const zoom = this.map.getZoom()
    let zoomMul = 1
    if (this.config.zoomAdaptive) {
      zoomMul = Math.min(Math.max(Math.pow(2, this.refZoom - zoom), 0.15), 48)
    }
    const finalScale = this.baseSize * this.config.sizeFactor * zoomMul
    const cosLat = Math.cos((this.origin[1] * Math.PI) / 180)

    // 仅在缩放/尺寸变化时重写 root.scale；闪烁关闭后仅在状态切换时写一次 emissive
    const scaleChanged = finalScale !== this.lastScale
    this.lastScale = finalScale
    const blink = this.config.blink
    const blinkJustOff = this.prevBlink && !blink
    this.prevBlink = blink
    const { flying, showHalo, showTrails, showDropLines } = this.config

    for (const drone of this.drones) {
      if (scaleChanged) drone.root.scale.setScalar(finalScale)

      // 离线机不参与任何动画，可见性已在创建/状态切换时设定，直接跳过
      if (!drone.online) continue

      // 整机闪烁（锐利的脉冲式堤光，明显可见）
      if (blink) {
        drone.blinkPhase += dt * 4
        const s = 0.5 + 0.5 * Math.sin(drone.blinkPhase)
        const pulse = s * s * s // 锐化为频闪效果
        const emi = 0.1 + 1.5 * pulse
        for (const m of drone.materials) m.emissiveIntensity = emi
      } else if (blinkJustOff) {
        for (const m of drone.materials) m.emissiveIntensity = 0.35
      }
      if (drone.rotors) drone.rotors.rotation.z += dt * 45

      // 飞行
      if (flying) {
        this.navigate(drone, dt, cosLat)
        this.place(drone)
        if (showDropLines) this.updateDrop(drone)
        drone.trailTimer += dt
        if (drone.trailTimer >= TRAIL_SAMPLE_DT) {
          drone.trailTimer = 0
          this.pushTrail(drone)
        }
      }

      // 地面雷达脉冲光环
      if (showHalo) {
        drone.halo.visible = true
        this.toScene(drone.lng, drone.lat, 0, this.scenePt)
        drone.halo.position.set(this.scenePt[0], this.scenePt[1], this.scenePt[2] + 0.0001)
        const pt = (t * 0.6 + drone.haloPhase) % 1
        const r = finalScale * (0.5 + pt * 1.9)
        drone.halo.scale.setScalar(r)
        drone.haloMat.opacity = (1 - pt) * 0.5
      } else {
        drone.halo.visible = false
      }

      drone.trailMesh.visible = showTrails && drone.trail.length >= 6
      drone.dropLine.visible = showDropLines
    }

    // 仅当存在动画（在线机 + 飞行/闪烁/光环）时才需要持续重绘
    this.animating =
      this.onlineCount > 0 && (flying || blink || showHalo)
  }

  private navigate(drone: Drone, dt: number, cosLat: number) {
    const dNorth = (drone.tLat - drone.lat) * 111320
    const dEast = (drone.tLng - drone.lng) * 111320 * cosLat
    const distH = Math.hypot(dNorth, dEast)
    const targetHeading = Math.atan2(dEast, dNorth)
    const diff = DroneFleetLayer.normalizeAngle(targetHeading - drone.heading)
    drone.heading += Math.max(-TURN_RATE * dt, Math.min(TURN_RATE * dt, diff))

    // 横滚随转弯，俯仰随爬升，平滑过渡
    const bankTarget = Math.max(-1, Math.min(1, diff)) * MAX_BANK
    drone.bank += (bankTarget - drone.bank) * Math.min(1, dt * 4)
    const altDiff = drone.tAlt - drone.alt
    const pitchTarget = Math.max(-0.18, Math.min(0.18, altDiff * 0.01))
    drone.pitch += (pitchTarget - drone.pitch) * Math.min(1, dt * 3)

    // 平滑加速到（巡航速度 × 速度倍率）
    const target = drone.cruise * this.config.speedFactor
    drone.speed += (target - drone.speed) * Math.min(1, dt * 2)

    const distM = drone.speed * dt
    drone.lat += (Math.cos(drone.heading) * distM) / 111320
    drone.lng += (Math.sin(drone.heading) * distM) / (111320 * cosLat)
    drone.alt += Math.max(-12 * dt, Math.min(12 * dt, altDiff))

    if (distH < WP_REACH) {
      drone.tLng = this.randLng()
      drone.tLat = this.randLat()
      drone.tAlt = this.randAlt()
    }
  }

  private updateDrop(drone: Drone) {
    this.toScene(drone.lng, drone.lat, drone.alt, this.scenePt)
    drone.dropPos[0] = this.scenePt[0]
    drone.dropPos[1] = this.scenePt[1]
    drone.dropPos[2] = this.scenePt[2]
    this.toScene(drone.lng, drone.lat, 0, this.scenePt)
    drone.dropPos[3] = this.scenePt[0]
    drone.dropPos[4] = this.scenePt[1]
    drone.dropPos[5] = this.scenePt[2]
    ;(drone.dropLine.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
  }

  /** 轨迹入队 + 重建彗星拖尾 ribbon（头亮尾暗） */
  private pushTrail(drone: Drone) {
    this.toScene(drone.lng, drone.lat, drone.alt, this.scenePt)
    drone.trail.push(this.scenePt[0], this.scenePt[1], this.scenePt[2])
    if (drone.trail.length > TRAIL_MAX * 3) drone.trail.splice(0, 3)

    const n = drone.trail.length / 3
    if (n < 2) return

    const base =
      this.config.trailColorMode === 'custom'
        ? this.colorTrail
        : drone.online
          ? this.colorOnline
          : this.colorOffline

    // 半宽（场景单位 = 米）：由面板 trailWidth 映射而来
    const half = this.config.trailWidth * 2
    const trail = drone.trail
    const pos = drone.trailPos
    const col = drone.trailCol

    for (let i = 0; i < n; i++) {
      const px = trail[i * 3]!
      const py = trail[i * 3 + 1]!
      const pz = trail[i * 3 + 2]!

      // 切线方向（前后邻点），取水平面内的法向作为带宽方向
      const i0 = Math.max(0, i - 1)
      const i1 = Math.min(n - 1, i + 1)
      const tx = trail[i1 * 3]! - trail[i0 * 3]!
      const ty = trail[i1 * 3 + 1]! - trail[i0 * 3 + 1]!
      // perp = normalize(cross(tangent, up)), up=(0,0,1) → (ty, -tx, 0)
      let nx = ty
      let ny = -tx
      const len = Math.hypot(nx, ny) || 1
      nx = (nx / len) * half
      ny = (ny / len) * half

      // 头部最亮，尾部渐暗
      const b = Math.pow(i / (n - 1), 1.6)
      const r = base.r * b
      const g = base.g * b
      const bl = base.b * b

      const o = i * 6
      pos[o] = px + nx
      pos[o + 1] = py + ny
      pos[o + 2] = pz
      pos[o + 3] = px - nx
      pos[o + 4] = py - ny
      pos[o + 5] = pz
      col[o] = r
      col[o + 1] = g
      col[o + 2] = bl
      col[o + 3] = r
      col[o + 4] = g
      col[o + 5] = bl
    }

    const geo = drone.trailMesh.geometry
    ;(geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true
    geo.setDrawRange(0, (n - 1) * 6)
  }
}
