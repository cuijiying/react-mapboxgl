import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import * as THREE from 'three'
import { MAPBOX_ACCESS_TOKEN, MAP_STYLES } from '@/config/mapbox'
import styles from './ThreeJsDemo.module.css'

const modelOrigin: [number, number] = [116.3912, 39.9055]
const modelAltitude = 0

function getModelTransform(origin: [number, number], altitude: number) {
  const modelAsMercatorCoordinate = mapboxgl.MercatorCoordinate.fromLngLat(origin, altitude)
  const scale = modelAsMercatorCoordinate.meterInMercatorCoordinateUnits()

  return {
    translateX: modelAsMercatorCoordinate.x,
    translateY: modelAsMercatorCoordinate.y,
    translateZ: modelAsMercatorCoordinate.z ?? 0,
    scale,
  }
}

function createModels(): THREE.Group {
  const group = new THREE.Group()

  const dodecaGeo = new THREE.DodecahedronGeometry(150, 0)
  const dodecaMat = new THREE.MeshPhongMaterial({
    color: 0xe74c3c,
    shininess: 100,
    flatShading: true,
  })
  const dodecaMesh = new THREE.Mesh(dodecaGeo, dodecaMat)
  dodecaMesh.position.set(0, 0, 200)
  dodecaMesh.name = 'dodecahedron'
  group.add(dodecaMesh)

  const torusGeo = new THREE.TorusGeometry(300, 30, 16, 64)
  const torusMat = new THREE.MeshPhongMaterial({
    color: 0x3498db,
    shininess: 80,
  })
  const torusMesh = new THREE.Mesh(torusGeo, torusMat)
  torusMesh.position.set(0, 0, 200)
  torusMesh.rotation.x = Math.PI / 2
  torusMesh.name = 'torus'
  group.add(torusMesh)

  const pillarPositions = [
    [-400, -400],
    [400, -400],
    [400, 400],
    [-400, 400],
  ]
  const pillarGeo = new THREE.CylinderGeometry(40, 50, 400, 8)
  const pillarMat = new THREE.MeshPhongMaterial({
    color: 0x2ecc71,
    shininess: 60,
  })
  pillarPositions.forEach(([x, y]) => {
    const pillar = new THREE.Mesh(pillarGeo, pillarMat)
    pillar.position.set(x!, y!, 200)
    pillar.rotation.x = Math.PI / 2
    group.add(pillar)
  })

  const baseGeo = new THREE.BoxGeometry(1000, 1000, 20)
  const baseMat = new THREE.MeshPhongMaterial({
    color: 0x95a5a6,
    shininess: 30,
    transparent: true,
    opacity: 0.8,
  })
  const baseMesh = new THREE.Mesh(baseGeo, baseMat)
  baseMesh.position.set(0, 0, 10)
  group.add(baseMesh)

  const sphereGeo = new THREE.SphereGeometry(80, 32, 32)
  const sphereMat = new THREE.MeshPhongMaterial({
    color: 0xf39c12,
    shininess: 120,
    emissive: 0xf39c12,
    emissiveIntensity: 0.2,
  })
  const sphereMesh = new THREE.Mesh(sphereGeo, sphereMat)
  sphereMesh.position.set(0, 0, 500)
  sphereMesh.name = 'floatingSphere'
  group.add(sphereMesh)

  return group
}

interface ThreeJsParams {
  autoRotate: boolean
  rotateSpeed: number
  modelScale: number
  ambientIntensity: number
  directionalIntensity: number
}

export default function ThreeJsDemo() {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)

  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.Camera | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const ambientLightRef = useRef<THREE.AmbientLight | null>(null)
  const directionalLightRef = useRef<THREE.DirectionalLight | null>(null)
  const meshGroupRef = useRef<THREE.Group | null>(null)
  const animationTimeRef = useRef(0)

  const [autoRotate, setAutoRotate] = useState(true)
  const [rotateSpeed, setRotateSpeed] = useState(1.0)
  const [modelScale, setModelScale] = useState(1.0)
  const [ambientIntensity, setAmbientIntensity] = useState(0.6)
  const [directionalIntensity, setDirectionalIntensity] = useState(1.5)

  const paramsRef = useRef<ThreeJsParams>({
    autoRotate,
    rotateSpeed,
    modelScale,
    ambientIntensity,
    directionalIntensity,
  })

  paramsRef.current = {
    autoRotate,
    rotateSpeed,
    modelScale,
    ambientIntensity,
    directionalIntensity,
  }

  const updateModelScale = (scale: number) => {
    setModelScale(scale)
    if (meshGroupRef.current) {
      meshGroupRef.current.scale.setScalar(scale)
      mapRef.current?.triggerRepaint()
    }
  }

  const updateLighting = (ambient: number, directional: number) => {
    if (ambientLightRef.current) ambientLightRef.current.intensity = ambient
    if (directionalLightRef.current) directionalLightRef.current.intensity = directional
    mapRef.current?.triggerRepaint()
  }

  useEffect(() => {
    if (!mapContainerRef.current) return

    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLES.LIGHT,
      center: modelOrigin,
      zoom: 16,
      pitch: 60,
      bearing: -30,
      antialias: true,
    })

    mapRef.current = map
    map.addControl(new mapboxgl.NavigationControl(), 'top-right')

    const modelTransform = getModelTransform(modelOrigin, modelAltitude)

    const customLayer: mapboxgl.CustomLayerInterface = {
      id: 'threejs-layer',
      type: 'custom',
      renderingMode: '3d',

      onAdd(_map, gl) {
        const scene = new THREE.Scene()
        sceneRef.current = scene

        const camera = new THREE.Camera()
        cameraRef.current = camera

        const ambientLight = new THREE.AmbientLight(0xffffff, paramsRef.current.ambientIntensity)
        ambientLightRef.current = ambientLight
        scene.add(ambientLight)

        const directionalLight = new THREE.DirectionalLight(
          0xffffff,
          paramsRef.current.directionalIntensity,
        )
        directionalLight.position.set(0, -70, 100).normalize()
        directionalLightRef.current = directionalLight
        scene.add(directionalLight)

        const meshGroup = createModels()
        meshGroup.scale.setScalar(paramsRef.current.modelScale)
        meshGroupRef.current = meshGroup
        scene.add(meshGroup)

        const renderer = new THREE.WebGLRenderer({
          canvas: _map.getCanvas(),
          context: gl,
          antialias: true,
        })
        renderer.autoClear = false
        rendererRef.current = renderer
      },

      render(_gl, matrix) {
        const scene = sceneRef.current
        const camera = cameraRef.current
        const renderer = rendererRef.current
        const mapInstance = mapRef.current
        const meshGroup = meshGroupRef.current
        const params = paramsRef.current

        if (!scene || !camera || !renderer || !mapInstance) return

        animationTimeRef.current += 0.01 * params.rotateSpeed

        if (meshGroup) {
          const dodeca = meshGroup.getObjectByName('dodecahedron')
          if (dodeca && params.autoRotate) {
            dodeca.rotation.x = animationTimeRef.current
            dodeca.rotation.y = animationTimeRef.current * 0.7
          }

          const torus = meshGroup.getObjectByName('torus')
          if (torus && params.autoRotate) {
            torus.rotation.z = animationTimeRef.current * 0.5
          }

          const sphere = meshGroup.getObjectByName('floatingSphere')
          if (sphere) {
            sphere.position.z = 500 + Math.sin(animationTimeRef.current * 2) * 80
          }
        }

        const m = new THREE.Matrix4().fromArray(matrix as unknown as ArrayLike<number>)
        const l = new THREE.Matrix4()
          .makeTranslation(
            modelTransform.translateX,
            modelTransform.translateY,
            modelTransform.translateZ,
          )
          .scale(
            new THREE.Vector3(modelTransform.scale, -modelTransform.scale, modelTransform.scale),
          )

        camera.projectionMatrix = m.multiply(l)

        renderer.resetState()
        renderer.render(scene, camera)

        if (params.autoRotate) {
          mapInstance.triggerRepaint()
        }
      },

      onRemove() {
        const renderer = rendererRef.current
        const scene = sceneRef.current

        if (renderer) {
          renderer.dispose()
          rendererRef.current = null
        }
        if (scene) {
          scene.traverse((obj) => {
            if (obj instanceof THREE.Mesh) {
              obj.geometry.dispose()
              if (Array.isArray(obj.material)) {
                obj.material.forEach((m) => m.dispose())
              } else {
                obj.material.dispose()
              }
            }
          })
          sceneRef.current = null
        }
        cameraRef.current = null
        ambientLightRef.current = null
        directionalLightRef.current = null
        meshGroupRef.current = null
      },
    }

    map.on('style.load', () => {
      map.addLayer(customLayer)
    })

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  return (
    <div className={styles.demoContainer}>
      <div ref={mapContainerRef} className={styles.mapContainer} />

      <div className={styles.controlPanel}>
        <div className={styles.panelCard}>
          <h4 className={styles.panelTitle}>Three.js 三维场景</h4>
          <p className={styles.panelDesc}>
            使用 Mapbox GL 自定义图层 API 集成 Three.js，
            <br />
            在地图上渲染三维模型。
          </p>
        </div>

        <div className={styles.panelCard}>
          <h4 className={styles.panelTitle}>动画控制</h4>
          <div className={styles.checkboxGroup}>
            <label>
              <input
                type="checkbox"
                checked={autoRotate}
                onChange={(e) => {
                  setAutoRotate(e.target.checked)
                  mapRef.current?.triggerRepaint()
                }}
              />
              自动旋转
            </label>
          </div>
          <div className={styles.sliderGroup}>
            <label>旋转速度: {rotateSpeed.toFixed(1)}x</label>
            <input
              type="range"
              value={rotateSpeed}
              min={0.1}
              max={5}
              step={0.1}
              onChange={(e) => {
                setRotateSpeed(Number(e.target.value))
                mapRef.current?.triggerRepaint()
              }}
            />
          </div>
        </div>

        <div className={styles.panelCard}>
          <h4 className={styles.panelTitle}>模型缩放</h4>
          <div className={styles.sliderGroup}>
            <label>缩放: {modelScale.toFixed(1)}x</label>
            <input
              type="range"
              value={modelScale}
              min={0.5}
              max={5}
              step={0.1}
              onChange={(e) => updateModelScale(Number(e.target.value))}
            />
          </div>
        </div>

        <div className={styles.panelCard}>
          <h4 className={styles.panelTitle}>光照</h4>
          <div className={styles.sliderGroup}>
            <label>环境光: {(ambientIntensity * 100).toFixed(0)}%</label>
            <input
              type="range"
              value={ambientIntensity}
              min={0}
              max={2}
              step={0.05}
              onChange={(e) => {
                const value = Number(e.target.value)
                setAmbientIntensity(value)
                updateLighting(value, directionalIntensity)
              }}
            />
          </div>
          <div className={styles.sliderGroup}>
            <label>方向光: {(directionalIntensity * 100).toFixed(0)}%</label>
            <input
              type="range"
              value={directionalIntensity}
              min={0}
              max={3}
              step={0.05}
              onChange={(e) => {
                const value = Number(e.target.value)
                setDirectionalIntensity(value)
                updateLighting(ambientIntensity, value)
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
