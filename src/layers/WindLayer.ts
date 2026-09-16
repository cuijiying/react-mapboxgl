/**
 * WindLayer - 风场粒子可视化图层
 *
 * 基于 WebGL 的风场粒子动画，使用帧缓冲 ping-pong 实现拖尾效果。
 * 实现 mapboxgl.CustomLayerInterface，可直接添加到 Mapbox GL 地图中。
 *
 * 渲染流程（每帧）：
 *  1. CPU 更新粒子位置（双线性插值查找风速，沿风向移动）
 *  2. 绑定拖尾 FBO，将上一帧纹理以 fadeOpacity 衰减写入目标纹理
 *  3. 将粒子以 GL_POINTS 绘制到目标纹理上
 *  4. 交换 ping-pong 纹理
 *  5. 将最新拖尾纹理合成到地图上
 */

import mapboxgl from 'mapbox-gl'

/* ═══════════════════════ 类型定义 ═══════════════════════ */

/** 风场网格数据 */
export interface WindData {
  /** 网格列数 */
  width: number
  /** 网格行数 */
  height: number
  /** U 分量（西→东）最小值 */
  uMin: number
  /** U 分量最大值 */
  uMax: number
  /** V 分量（南→北）最小值 */
  vMin: number
  /** V 分量最大值 */
  vMax: number
  /** U 分量数组，行优先、自北向南 */
  u: Float32Array
  /** V 分量数组，行优先、自北向南 */
  v: Float32Array
  /** 数据地理范围 [west, south, east, north] */
  bounds: [number, number, number, number]
}

/** 风场图层配置项 */
export interface WindLayerOptions {
  /** 图层 ID（默认 'wind-layer'） */
  id?: string
  /** 风场数据 */
  windData: WindData
  /** 粒子数量（默认 5000） */
  particleCount?: number
  /** 拖尾淡出系数 0-1，越大拖尾越长（默认 0.96） */
  fadeOpacity?: number
  /** 粒子速度缩放（默认 0.25） */
  speedFactor?: number
  /** 粒子绘制大小（默认 2） */
  particleSize?: number
  /** 总体不透明度 0-1（默认 0.9） */
  opacity?: number
  /** 粒子随机消亡概率（默认 0.003） */
  dropRate?: number
  /** 高速粒子额外消亡概率（默认 0.01） */
  dropRateBump?: number
  /** 粒子最大存活帧数（默认 100） */
  maxAge?: number
  /** 颜色渐变映射 { 归一化速度(0-1): 十六进制颜色 } */
  colorRamp?: Record<number, string>
}

/* ═══════════════════════ GLSL 着色器 ═══════════════════════ */

/** 粒子绘制 - 顶点着色器 */
const DRAW_VERT = `
attribute vec2 a_position;
attribute float a_speed;
uniform mat4 u_matrix;
uniform float u_pointSize;
varying float v_speed;
void main() {
  gl_PointSize = u_pointSize;
  gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);
  v_speed = a_speed;
}
`

/** 粒子绘制 - 片元着色器（圆形点 + 颜色渐变纹理） */
const DRAW_FRAG = `
precision mediump float;
uniform sampler2D u_colorRamp;
varying float v_speed;
void main() {
  vec2 d = 2.0 * gl_PointCoord - 1.0;
  if (dot(d, d) > 1.0) discard;
  gl_FragColor = texture2D(u_colorRamp, vec2(v_speed, 0.5));
}
`

/** 全屏四边形 - 顶点着色器（淡出 & 合成共用） */
const QUAD_VERT = `
attribute vec2 a_position;
varying vec2 v_texCoord;
void main() {
  v_texCoord = (a_position + 1.0) / 2.0;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

/** 淡出 - 片元着色器（直接写入，不混合） */
const FADE_FRAG = `
precision mediump float;
uniform sampler2D u_texture;
uniform float u_fade;
varying vec2 v_texCoord;
void main() {
  vec4 color = texture2D(u_texture, v_texCoord);
  gl_FragColor = color * u_fade;
}
`

/** 合成 - 片元着色器（带透明度输出到地图） */
const SCREEN_FRAG = `
precision mediump float;
uniform sampler2D u_texture;
uniform float u_opacity;
varying vec2 v_texCoord;
void main() {
  vec4 color = texture2D(u_texture, v_texCoord);
  gl_FragColor = vec4(color.rgb, color.a * u_opacity);
}
`

/* ═══════════════════════ 工具函数 ═══════════════════════ */

/** 经纬度 → Mercator 归一化坐标 [0,1] × [0,1] */
function lngLatToMercator(lng: number, lat: number): [number, number] {
  const x = (lng + 180) / 360
  const sinLat = Math.sin((lat * Math.PI) / 180)
  const y = (1 - Math.log((1 + sinLat) / (1 - sinLat)) / (2 * Math.PI)) / 2
  return [x, y]
}

/** 编译 WebGL 着色器 */
function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error('Shader compile error: ' + info)
  }
  return shader
}

/** 创建着色器程序 */
function createProgram(gl: WebGLRenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc)
  const prog = gl.createProgram()!
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog)
    gl.deleteProgram(prog)
    throw new Error('Program link error: ' + info)
  }
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  return prog
}

/** 十六进制颜色 → [R, G, B, A] 0-255 */
function hexToRgba(hex: string): [number, number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    255,
  ]
}

/** 根据颜色渐变映射表生成 256×1 RGBA 像素数据 */
function buildColorRampPixels(ramp: Record<number, string>): Uint8Array {
  const stops = Object.entries(ramp)
    .map(([k, v]) => ({ t: parseFloat(k), c: hexToRgba(v) }))
    .sort((a, b) => a.t - b.t)
  const pixels = new Uint8Array(256 * 4)
  if (stops.length === 0) return pixels
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    let lo = stops[0]!,
      hi = stops[stops.length - 1]!
    for (let j = 0; j < stops.length - 1; j++) {
      if (t >= stops[j]!.t && t <= stops[j + 1]!.t) {
        lo = stops[j]!
        hi = stops[j + 1]!
        break
      }
    }
    const f = hi.t === lo.t ? 0 : (t - lo.t) / (hi.t - lo.t)
    for (let ch = 0; ch < 4; ch++) {
      pixels[i * 4 + ch] = Math.round(lo.c[ch]! + f * (hi.c[ch]! - lo.c[ch]!))
    }
  }
  return pixels
}

/** 默认风速颜色渐变 */
function defaultColorRamp(): Record<number, string> {
  return {
    0.0: '#3288bd',
    0.1: '#66c2a5',
    0.2: '#abdda4',
    0.3: '#e6f598',
    0.4: '#fee08b',
    0.5: '#fdae61',
    0.6: '#f46d43',
    1.0: '#d53e4f',
  }
}

/* ═══════════════════════ WindLayer 类 ═══════════════════════ */

export class WindLayer implements mapboxgl.CustomLayerInterface {
  readonly id: string
  readonly type = 'custom' as const
  readonly renderingMode = '2d' as const

  private map: mapboxgl.Map | null = null
  private gl: WebGLRenderingContext | null = null
  private _animating = false

  /* ── 参数 ── */
  private windData: WindData
  private _particleCount: number
  private _fadeOpacity: number
  private _speedFactor: number
  private _particleSize: number
  private _opacity: number
  private _dropRate: number
  private _dropRateBump: number
  private _maxAge: number
  private _colorRamp: Record<number, string>

  /* ── 粒子状态 ── */
  private pLng!: Float32Array
  private pLat!: Float32Array
  private pAge!: Float32Array
  private pSpeed!: Float32Array
  /** GPU 上传缓冲 [mercatorX, mercatorY, normSpeed] × N */
  private renderBuf!: Float32Array

  /* ── 缓存的最大风速 ── */
  private _maxWindSpeed = 1

  /* ── GL 资源 ── */
  private drawProg: WebGLProgram | null = null
  private fadeProg: WebGLProgram | null = null
  private screenProg: WebGLProgram | null = null
  private particleBuf: WebGLBuffer | null = null
  private quadBuf: WebGLBuffer | null = null
  private colorRampTex: WebGLTexture | null = null
  private trailTex0: WebGLTexture | null = null
  private trailTex1: WebGLTexture | null = null
  private fbo: WebGLFramebuffer | null = null
  private texW = 0
  private texH = 0

  constructor(options: WindLayerOptions) {
    this.id = options.id ?? 'wind-layer'
    this.windData = options.windData
    this._particleCount = options.particleCount ?? 5000
    this._fadeOpacity = options.fadeOpacity ?? 0.96
    this._speedFactor = options.speedFactor ?? 0.25
    this._particleSize = options.particleSize ?? 2
    this._opacity = options.opacity ?? 0.9
    this._dropRate = options.dropRate ?? 0.003
    this._dropRateBump = options.dropRateBump ?? 0.01
    this._maxAge = options.maxAge ?? 100
    this._colorRamp = options.colorRamp ?? defaultColorRamp()

    this._computeMaxSpeed()
  }

  /* ═══════════ CustomLayerInterface 生命周期 ═══════════ */

  onAdd(map: mapboxgl.Map, gl: WebGLRenderingContext): void {
    this.map = map
    this.gl = gl
    this._animating = true

    // 编译着色器程序
    this.drawProg = createProgram(gl, DRAW_VERT, DRAW_FRAG)
    this.fadeProg = createProgram(gl, QUAD_VERT, FADE_FRAG)
    this.screenProg = createProgram(gl, QUAD_VERT, SCREEN_FRAG)

    // 全屏四边形顶点缓冲（TRIANGLE_STRIP）
    this.quadBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    )

    // 粒子数据缓冲
    this.particleBuf = gl.createBuffer()!

    // 颜色渐变纹理 (256×1)
    this.colorRampTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.colorRampTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      buildColorRampPixels(this._colorRamp),
    )

    // 帧缓冲对象
    this.fbo = gl.createFramebuffer()!

    // 初始化粒子
    this._initParticles()
  }

  render(gl: WebGLRenderingContext, matrix: number[]): void {
    if (!this._animating || !this.map) return

    const canvas = gl.canvas as HTMLCanvasElement
    const w = canvas.width
    const h = canvas.height

    // 画布尺寸变化时重建拖尾纹理
    if (w !== this.texW || h !== this.texH) {
      this._createTrailTextures(gl, w, h)
    }

    // ── 1. CPU 更新粒子 ──
    this._updateParticles()

    // ── 2. 准备粒子 GPU 数据 ──
    for (let i = 0; i < this._particleCount; i++) {
      const [mx, my] = lngLatToMercator(this.pLng[i]!, this.pLat[i]!)
      this.renderBuf[i * 3] = mx
      this.renderBuf[i * 3 + 1] = my
      this.renderBuf[i * 3 + 2] = this.pSpeed[i]!
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuf!)
    gl.bufferData(gl.ARRAY_BUFFER, this.renderBuf, gl.DYNAMIC_DRAW)

    // ── 保存 Mapbox 帧缓冲 ──
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING)

    // ── 3. 渲染到拖尾 FBO (写入 trailTex1) ──
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo!)
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.trailTex1!, 0,
    )
    gl.viewport(0, 0, this.texW, this.texH)

    // 3a. 淡出：将 trailTex0 衰减后写入（无混合，直接覆写整个纹理）
    gl.disable(gl.BLEND)
    gl.useProgram(this.fadeProg!)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.trailTex0!)
    gl.uniform1i(gl.getUniformLocation(this.fadeProg!, 'u_texture'), 0)
    gl.uniform1f(gl.getUniformLocation(this.fadeProg!, 'u_fade'), this._fadeOpacity)
    this._drawQuad(gl, this.fadeProg!)

    // 3b. 绘制粒子（混合叠加到衰减后的拖尾上）
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this.drawProg!)
    gl.uniformMatrix4fv(gl.getUniformLocation(this.drawProg!, 'u_matrix'), false, matrix)
    gl.uniform1f(gl.getUniformLocation(this.drawProg!, 'u_pointSize'), this._particleSize)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.colorRampTex!)
    gl.uniform1i(gl.getUniformLocation(this.drawProg!, 'u_colorRamp'), 0)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuf!)
    const aPos = gl.getAttribLocation(this.drawProg!, 'a_position')
    const aSpd = gl.getAttribLocation(this.drawProg!, 'a_speed')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 12, 0)
    gl.enableVertexAttribArray(aSpd)
    gl.vertexAttribPointer(aSpd, 1, gl.FLOAT, false, 12, 8)
    gl.drawArrays(gl.POINTS, 0, this._particleCount)
    gl.disableVertexAttribArray(aPos)
    gl.disableVertexAttribArray(aSpd)

    // ── 4. 交换 ping-pong 纹理 ──
    ;[this.trailTex0, this.trailTex1] = [this.trailTex1, this.trailTex0]

    // ── 5. 将拖尾纹理合成到地图 ──
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo)
    gl.viewport(0, 0, w, h)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this.screenProg!)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.trailTex0!)
    gl.uniform1i(gl.getUniformLocation(this.screenProg!, 'u_texture'), 0)
    gl.uniform1f(gl.getUniformLocation(this.screenProg!, 'u_opacity'), this._opacity)
    this._drawQuad(gl, this.screenProg!)

    // 恢复混合状态
    gl.disable(gl.BLEND)

    // 持续触发动画
    if (this._animating) this.map!.triggerRepaint()
  }

  onRemove(_map: mapboxgl.Map, gl: WebGLRenderingContext): void {
    this._animating = false
    if (this.drawProg) gl.deleteProgram(this.drawProg)
    if (this.fadeProg) gl.deleteProgram(this.fadeProg)
    if (this.screenProg) gl.deleteProgram(this.screenProg)
    if (this.particleBuf) gl.deleteBuffer(this.particleBuf)
    if (this.quadBuf) gl.deleteBuffer(this.quadBuf)
    if (this.colorRampTex) gl.deleteTexture(this.colorRampTex)
    if (this.trailTex0) gl.deleteTexture(this.trailTex0)
    if (this.trailTex1) gl.deleteTexture(this.trailTex1)
    if (this.fbo) gl.deleteFramebuffer(this.fbo)
    this.drawProg = this.fadeProg = this.screenProg = null
    this.particleBuf = this.quadBuf = null
    this.colorRampTex = this.trailTex0 = this.trailTex1 = null
    this.fbo = null
    this.map = null
    this.gl = null
  }

  /* ═══════════ 内部方法 ═══════════ */

  /** 计算风场最大速度（用于归一化颜色映射） */
  private _computeMaxSpeed(): void {
    const { uMin, uMax, vMin, vMax } = this.windData
    const uAbs = Math.max(Math.abs(uMin), Math.abs(uMax))
    const vAbs = Math.max(Math.abs(vMin), Math.abs(vMax))
    this._maxWindSpeed = Math.sqrt(uAbs * uAbs + vAbs * vAbs) || 1
  }

  /** 初始化粒子数组 */
  private _initParticles(): void {
    this.pLng = new Float32Array(this._particleCount)
    this.pLat = new Float32Array(this._particleCount)
    this.pAge = new Float32Array(this._particleCount)
    this.pSpeed = new Float32Array(this._particleCount)
    this.renderBuf = new Float32Array(this._particleCount * 3)
    for (let i = 0; i < this._particleCount; i++) this._resetParticle(i)
  }

  /** 重置单个粒子到随机位置 */
  private _resetParticle(i: number): void {
    const [w, s, e, n] = this.windData.bounds
    this.pLng[i] = w + Math.random() * (e - w)
    this.pLat[i] = s + Math.random() * (n - s)
    this.pAge[i] = Math.floor(Math.random() * this._maxAge)
    this.pSpeed[i] = 0
  }

  /** 双线性插值查找某经纬度处的风速，越界返回 null */
  private _lookupWind(lng: number, lat: number): [number, number] | null {
    const { bounds, width, height, u, v } = this.windData
    const [west, south, east, north] = bounds
    if (lng < west || lng > east || lat < south || lat > north) return null

    const fx = ((lng - west) / (east - west)) * (width - 1)
    const fy = ((north - lat) / (north - south)) * (height - 1)
    const ix = Math.min(Math.floor(fx), width - 2)
    const iy = Math.min(Math.floor(fy), height - 2)
    const dx = fx - ix
    const dy = fy - iy

    const i00 = iy * width + ix
    const i10 = i00 + 1
    const i01 = i00 + width
    const i11 = i01 + 1

    const uVal =
      (1 - dx) * (1 - dy) * u[i00]! +
      dx * (1 - dy) * u[i10]! +
      (1 - dx) * dy * u[i01]! +
      dx * dy * u[i11]!
    const vVal =
      (1 - dx) * (1 - dy) * v[i00]! +
      dx * (1 - dy) * v[i10]! +
      (1 - dx) * dy * v[i01]! +
      dx * dy * v[i11]!

    return [uVal, vVal]
  }

  /** 每帧更新所有粒子位置 */
  private _updateParticles(): void {
    for (let i = 0; i < this._particleCount; i++) {
      // 查找当前位置风速
      const wind = this._lookupWind(this.pLng[i]!, this.pLat[i]!)
      if (!wind) {
        this._resetParticle(i)
        continue
      }

      const [u, v] = wind
      const speed = Math.sqrt(u * u + v * v)
      const normSpeed = speed / this._maxWindSpeed
      this.pSpeed[i] = Math.min(normSpeed, 1)

      // 递增年龄，判定消亡
      this.pAge[i]!++
      if (
        this.pAge[i]! > this._maxAge ||
        Math.random() < this._dropRate + normSpeed * this._dropRateBump
      ) {
        this._resetParticle(i)
        continue
      }

      // 按风速移动粒子（度/帧 = 风速 × 缩放系数）
      const scale = this._speedFactor * 0.01
      this.pLng[i]! += u * scale
      this.pLat[i]! += v * scale
    }
  }

  /** 创建 / 重建 ping-pong 拖尾纹理 */
  private _createTrailTextures(gl: WebGLRenderingContext, w: number, h: number): void {
    this.texW = w
    this.texH = h
    const makeTexture = () => {
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      return tex
    }
    if (this.trailTex0) gl.deleteTexture(this.trailTex0)
    if (this.trailTex1) gl.deleteTexture(this.trailTex1)
    this.trailTex0 = makeTexture()
    this.trailTex1 = makeTexture()
  }

  /** 绘制全屏四边形 */
  private _drawQuad(gl: WebGLRenderingContext, prog: WebGLProgram): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf!)
    const loc = gl.getAttribLocation(prog, 'a_position')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.disableVertexAttribArray(loc)
  }

  /* ═══════════ 公开 API（参数实时调整） ═══════════ */

  setParticleCount(n: number): void {
    this._particleCount = Math.max(1, Math.round(n))
    this._initParticles()
  }

  setSpeedFactor(v: number): void {
    this._speedFactor = v
  }

  setFadeOpacity(v: number): void {
    this._fadeOpacity = v
  }

  setParticleSize(v: number): void {
    this._particleSize = v
  }

  setOpacity(v: number): void {
    this._opacity = v
  }

  setDropRate(v: number): void {
    this._dropRate = v
  }

  setDropRateBump(v: number): void {
    this._dropRateBump = v
  }

  setMaxAge(v: number): void {
    this._maxAge = v
  }

  setColorRamp(ramp: Record<number, string>): void {
    this._colorRamp = ramp
    if (this.gl && this.colorRampTex) {
      const gl = this.gl
      gl.bindTexture(gl.TEXTURE_2D, this.colorRampTex)
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        buildColorRampPixels(ramp),
      )
    }
  }

  updateWindData(data: WindData): void {
    this.windData = data
    this._computeMaxSpeed()
  }
}

/* ═══════════════════════ 模拟数据生成 ═══════════════════════ */

/**
 * 生成中国范围内的模拟风场数据。
 *
 * 包含：
 *  - 基础西风带（纬度越高越强）
 *  - 华中气旋系统
 *  - 东南沿海反气旋系统
 *  - 随机扰动
 *
 * @param cols 网格列数（默认 100）
 * @param rows 网格行数（默认 80）
 */
export function generateChinaWindData(cols = 100, rows = 80): WindData {
  const bounds: [number, number, number, number] = [73, 18, 135, 54]
  const u = new Float32Array(rows * cols)
  const v = new Float32Array(rows * cols)
  let uMin = Infinity,
    uMax = -Infinity,
    vMin = Infinity,
    vMax = -Infinity

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const lng = bounds[0] + (i / (cols - 1)) * (bounds[2] - bounds[0])
      const lat = bounds[3] - (j / (rows - 1)) * (bounds[3] - bounds[1])

      // 基础西风带：纬度越高、西风越强
      const baseU = 5 + 8 * Math.sin(((lat - 18) / 36) * Math.PI)
      const baseV = 3 * Math.cos(((lng - 104) / 62) * Math.PI * 2)

      // 气旋 1（华中地区 ~108°E, 34°N）
      const dx1 = lng - 108
      const dy1 = lat - 34
      const r1sq = dx1 * dx1 + dy1 * dy1
      const c1 = 15 * Math.exp(-r1sq / 120)

      // 反气旋 2（东南沿海 ~121°E, 27°N）
      const dx2 = lng - 121
      const dy2 = lat - 27
      const r2sq = dx2 * dx2 + dy2 * dy2
      const c2 = 12 * Math.exp(-r2sq / 80)

      const uVal = baseU + -dy1 * c1 + dy2 * c2 + (Math.random() - 0.5) * 2
      const vVal = baseV + dx1 * c1 + -dx2 * c2 + (Math.random() - 0.5) * 2

      const idx = j * cols + i
      u[idx] = uVal
      v[idx] = vVal
      uMin = Math.min(uMin, uVal)
      uMax = Math.max(uMax, uVal)
      vMin = Math.min(vMin, vVal)
      vMax = Math.max(vMax, vVal)
    }
  }

  return { width: cols, height: rows, uMin, uMax, vMin, vMax, u, v, bounds }
}
