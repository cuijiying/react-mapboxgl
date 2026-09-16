/**
 * GridLayer.ts
 *
 * 基于 Mapbox GL JS CustomLayerInterface 封装的通用网格图层。
 * 使用 WebGL 直接绘制，支持大规模格点数据（百万级顶点）的高性能渲染。
 *
 * 主要功能
 * ─────────────────────────────────────────────────────
 * 1. 网格渲染  —— 将二维数组格点数据转换为 WebGL 三角网格并着色
 * 2. 动态过滤  —— 通过滑条实时更新温度范围；超出范围的格点片元被丢弃(discard)
 * 3. 透明度控制—— 整体 alpha 乘以因子，支持淡入淡出效果
 * 4. 数据更新  —— 调用 updateData() 可在不重建图层的前提下替换格点数据
 * 5. 点击事件  —— 封装空间查询逻辑，将地图点击坐标反算为格点索引，回调给上层
 * 6. 资源释放  —— onRemove / destroy 完整清理 WebGL 资源，避免内存泄漏
 */

import mapboxgl from 'mapbox-gl'

// ─────────────────────────────────────────────────────
//  类型定义
// ─────────────────────────────────────────────────────

/**
 * 单个颜色分段节点
 * @property value  — 对应的数据值（如温度 °C）
 * @property color  — 归一化 RGBA 颜色，每个分量范围 [0, 1]
 *
 * 示例：{ value: 0, color: [0.455, 0.678, 0.820, 1.0] }  // #74add1
 */
export interface ColorStop {
  value: number
  color: [number, number, number, number]
}

/**
 * 格点数据结构
 * @property lonStart — 起始经度（格点左下角）
 * @property latStart — 起始纬度（格点左下角）
 * @property lonStep  — 经向分辨率（°/格）
 * @property latStep  — 纬向分辨率（°/格）
 * @property rows     — 纬向格点行数
 * @property cols     — 经向格点列数
 * @property values   — 二维数组，values[row][col] 为该格点的数值
 */
export interface GridData {
  lonStart: number
  latStart: number
  lonStep: number
  latStep: number
  rows: number
  cols: number
  values: number[][]
}

/**
 * 点击事件回调携带的格点信息
 * @property lng   — 点击位置经度
 * @property lat   — 点击位置纬度
 * @property value — 对应格点的数据值
 * @property row   — 格点行索引
 * @property col   — 格点列索引
 */
export interface GridClickInfo {
  lng: number
  lat: number
  value: number
  row: number
  col: number
}

/**
 * GridLayer 构造选项
 * @property layerId    — 图层 ID（默认 'grid-layer'）
 * @property gridData   — 格点数据（必填）
 * @property colorStops — 色标分段数组（必填），至少包含 2 个节点
 * @property opacity    — 整体透明度 [0, 1]，默认 0.85
 * @property filterMin  — 初始过滤下限（默认取 colorStops 最小 value）
 * @property filterMax  — 初始过滤上限（默认取 colorStops 最大 value）
 * @property onClick    — 格点点击回调；不传则不注册鼠标事件
 */
export interface GridLayerOptions {
  layerId?: string
  gridData: GridData
  colorStops: ColorStop[]
  opacity?: number
  filterMin?: number
  filterMax?: number
  onClick?: (info: GridClickInfo) => void
}

// ─────────────────────────────────────────────────────
//  GLSL 着色器源码
// ─────────────────────────────────────────────────────

/**
 * 顶点着色器
 *
 * 输入属性（Attribute）
 *   a_position    — Mercator 投影坐标 (x, y)，范围 [0, 1]
 *   a_color       — 该顶点预计算颜色 (r, g, b, a)，归一化
 *   a_value       — 原始数据值（用于片元过滤）
 *
 * 输入 Uniform
 *   u_matrix      — Mapbox 传入的 MVP 矩阵（把 Mercator 坐标变换到裁剪空间）
 *
 * 输出 Varying（传递给片元着色器）
 *   v_color       — 插值颜色
 *   v_value       — 插值数据值
 */
const VERTEX_SHADER_SOURCE = `
  attribute vec2 a_position;
  attribute vec4 a_color;
  attribute float a_value;

  uniform mat4 u_matrix;

  varying vec4 v_color;
  varying float v_value;

  void main() {
    // u_matrix 将 Mercator 平面坐标 [0,1]×[0,1] 映射到 WebGL 裁剪空间 [-1,1]^3
    gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);
    v_color = a_color;
    v_value = a_value;
  }
`

/**
 * 片元着色器
 *
 * 输入 Uniform
 *   u_filterMin  — 过滤下限
 *   u_filterMax  — 过滤上限
 *   u_opacity    — 整体透明度因子
 *
 * 过滤逻辑：
 *   若插值数据值不在 [u_filterMin, u_filterMax] 内，执行 discard
 *   丢弃的片元不会写入帧缓冲，即视觉上"消失"，性能优于设 alpha=0
 */
const FRAGMENT_SHADER_SOURCE = `
  precision mediump float;

  varying vec4 v_color;
  varying float v_value;

  uniform float u_filterMin;
  uniform float u_filterMax;
  uniform float u_opacity;

  void main() {
    // 数据值范围过滤：超出范围直接丢弃片元
    if (v_value < u_filterMin || v_value > u_filterMax) {
      discard;
    }
    // 将顶点颜色的 alpha 乘以全局透明度因子后输出
    gl_FragColor = vec4(v_color.rgb, v_color.a * u_opacity);
  }
`

// ─────────────────────────────────────────────────────
//  工具函数
// ─────────────────────────────────────────────────────

/**
 * 根据数据值在色标分段表中进行线性插值，返回 RGBA 颜色。
 *
 * 算法说明：
 * 1. 若值 ≤ 最小节点，返回最小节点颜色
 * 2. 若值 ≥ 最大节点，返回最大节点颜色
 * 3. 否则找到夹住该值的两个相邻节点，按比例 t 做线性插值
 *
 * @param value      — 待映射的数据值
 * @param colorStops — 色标节点数组（已按 value 升序排列）
 * @returns 归一化 RGBA 四元组
 */
function interpolateColor(
  value: number,
  colorStops: ColorStop[]
): [number, number, number, number] {
  const n = colorStops.length
  if (n === 0) return [1, 1, 1, 1]

  const first = colorStops[0]!
  const last = colorStops[n - 1]!

  // 边界处理：值低于最小节点
  if (value <= first.value) {
    return [...first.color] as [number, number, number, number]
  }
  // 边界处理：值高于最大节点
  if (value >= last.value) {
    return [...last.color] as [number, number, number, number]
  }

  // 二分查找所在分段（此处数据量有限，顺序查找即可）
  for (let i = 0; i < n - 1; i++) {
    const lo = colorStops[i]!
    const hi = colorStops[i + 1]!
    if (value >= lo.value && value < hi.value) {
      // 插值系数 t ∈ [0, 1)
      const t = (value - lo.value) / (hi.value - lo.value)
      return [
        lo.color[0] + t * (hi.color[0] - lo.color[0]),
        lo.color[1] + t * (hi.color[1] - lo.color[1]),
        lo.color[2] + t * (hi.color[2] - lo.color[2]),
        lo.color[3] + t * (hi.color[3] - lo.color[3])
      ]
    }
  }

  return [1, 1, 1, 1]
}

/**
 * 将地理经纬度转换为 Web Mercator 归一化坐标 [0, 1]。
 *
 * Web Mercator（EPSG:3857）公式：
 *   x = (lon + 180) / 360
 *   y = (1 - ln(tan(φ) + sec(φ)) / π) / 2
 *
 * 其中 φ 为纬度弧度值，ln 为自然对数，sec = 1/cos。
 *
 * Mapbox GL JS 内部使用此坐标系，范围 [0,1]×[0,1] 对应全球范围。
 */
function lngLatToMercator(lon: number, lat: number): [number, number] {
  const x = (lon + 180) / 360
  const latRad = (lat * Math.PI) / 180
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2
  return [x, y]
}

/**
 * 编译单个 WebGL 着色器。
 * @param gl     — WebGL 上下文
 * @param type   — gl.VERTEX_SHADER 或 gl.FRAGMENT_SHADER
 * @param source — GLSL 源码字符串
 * @returns 编译好的 WebGLShader，失败时抛出错误
 */
function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string
): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('[GridLayer] 无法创建 Shader 对象')

  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`[GridLayer] Shader 编译失败:\n${info}`)
  }
  return shader
}

/**
 * 链接顶点着色器与片元着色器，生成 WebGLProgram。
 * @returns 链接好的 WebGLProgram
 */
function createProgram(
  gl: WebGLRenderingContext,
  vertexShader: WebGLShader,
  fragmentShader: WebGLShader
): WebGLProgram {
  const program = gl.createProgram()
  if (!program) throw new Error('[GridLayer] 无法创建 WebGLProgram')

  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`[GridLayer] Program 链接失败:\n${info}`)
  }
  return program
}

// ─────────────────────────────────────────────────────
//  GridLayer 主类
// ─────────────────────────────────────────────────────

/**
 * GridLayer — 通用格点 WebGL 自定义图层
 *
 * 使用方式：
 * ```ts
 * const layer = new GridLayer({
 *   gridData,
 *   colorStops: MY_COLOR_STOPS,
 *   onClick: (info) => console.log(info.value)
 * })
 * map.addLayer(layer)
 *
 * // 动态更新过滤范围
 * layer.setFilter(10, 35)
 * map.triggerRepaint()
 *
 * // 移除图层
 * map.removeLayer(layer.id)
 * ```
 */
export class GridLayer implements mapboxgl.CustomLayerInterface {
  // ── Mapbox CustomLayerInterface 必要字段 ──
  readonly id: string
  readonly type = 'custom' as const
  readonly renderingMode = '2d' as const

  // ── 配置 ──
  private readonly colorStops: ColorStop[]
  private gridData: GridData
  private opacity: number

  // ── 过滤范围（运行时可更新） ──
  private filterMin: number
  private filterMax: number

  // ── 回调 ──
  private readonly onClickCallback?: (info: GridClickInfo) => void

  // ── Mapbox 地图引用（onAdd 后有效） ──
  private map: mapboxgl.Map | null = null

  // ── WebGL 资源（onAdd 后有效，onRemove 时释放） ──
  private gl: WebGLRenderingContext | null = null
  private program: WebGLProgram | null = null
  private vertexBuffer: WebGLBuffer | null = null   // 顶点坐标缓冲
  private colorBuffer: WebGLBuffer | null = null    // 顶点颜色缓冲
  private valueBuffer: WebGLBuffer | null = null    // 顶点数据值缓冲
  private indexBuffer: WebGLBuffer | null = null    // 索引缓冲
  private numIndices = 0                            // 索引总数

  // ── WebGL Attribute / Uniform 位置缓存 ──
  private loc = {
    aPosition: -1,
    aColor: -1,
    aValue: -1,
    uMatrix: null as WebGLUniformLocation | null,
    uFilterMin: null as WebGLUniformLocation | null,
    uFilterMax: null as WebGLUniformLocation | null,
    uOpacity: null as WebGLUniformLocation | null
  }

  // ── 点击事件清理函数 ──
  private clickCleanup: (() => void) | null = null
  private mousemoveCleanup: (() => void) | null = null

  // ─────────────────────────────────────────────────────
  //  构造函数
  // ─────────────────────────────────────────────────────

  constructor(options: GridLayerOptions) {
    this.id = options.layerId ?? 'grid-layer'
    this.gridData = options.gridData
    this.colorStops = [...options.colorStops].sort((a, b) => a.value - b.value)
    this.opacity = options.opacity ?? 0.85
    this.onClickCallback = options.onClick

    // 过滤范围默认覆盖色标全域
    const values = this.colorStops.map((s) => s.value)
    this.filterMin = options.filterMin ?? Math.min(...values)
    this.filterMax = options.filterMax ?? Math.max(...values)
  }

  // ─────────────────────────────────────────────────────
  //  Mapbox CustomLayerInterface 生命周期
  // ─────────────────────────────────────────────────────

  /**
   * onAdd
   * 由 Mapbox 在 `map.addLayer()` 时调用。
   * 此处完成所有 WebGL 初始化工作：
   *   1. 编译并链接着色器
   *   2. 将格点数据转换为 Float32Array 并上传 GPU 缓冲
   *   3. 缓存 attribute / uniform 位置
   *   4. 注册地图交互事件
   */
  onAdd(map: mapboxgl.Map, gl: WebGLRenderingContext): void {
    this.map = map
    this.gl = gl

    // ── 1. 构建 WebGL Program ──────────────────────────
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE)
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE)
    this.program = createProgram(gl, vs, fs)

    // 着色器对象链接后可删除，节省 GPU 内存
    gl.deleteShader(vs)
    gl.deleteShader(fs)

    // ── 2. 缓存 Attribute / Uniform 位置 ───────────────
    const prog = this.program
    this.loc.aPosition = gl.getAttribLocation(prog, 'a_position')
    this.loc.aColor = gl.getAttribLocation(prog, 'a_color')
    this.loc.aValue = gl.getAttribLocation(prog, 'a_value')
    this.loc.uMatrix = gl.getUniformLocation(prog, 'u_matrix')
    this.loc.uFilterMin = gl.getUniformLocation(prog, 'u_filterMin')
    this.loc.uFilterMax = gl.getUniformLocation(prog, 'u_filterMax')
    this.loc.uOpacity = gl.getUniformLocation(prog, 'u_opacity')

    // ── 3. 构建并上传缓冲数据 ──────────────────────────
    this._buildBuffers(gl)

    // ── 4. 注册地图交互事件 ────────────────────────────
    if (this.onClickCallback) {
      this._registerMapEvents()
    }
  }

  /**
   * render
   * 每帧由 Mapbox 调用（地图重绘时）。
   * 流程：
   *   1. 激活 Program
   *   2. 设置矩阵与过滤 Uniform
   *   3. 绑定各 Buffer 并配置指针
   *   4. 开启混合模式
   *   5. 执行 drawElements 绘制三角网格
   *
   * @param gl     — WebGL 上下文
   * @param matrix — Mapbox 提供的 MVP 矩阵（Float32Array，4×4 列主序）
   */
  render(gl: WebGLRenderingContext, matrix: number[]): void {
    if (!this.program || this.numIndices === 0) return

    const { loc } = this

    // ── 激活着色器程序 ──
    gl.useProgram(this.program)

    // ── 设置 Uniform 变量 ──
    // MVP 矩阵：将 Mercator 坐标变换到屏幕裁剪空间
    gl.uniformMatrix4fv(loc.uMatrix, false, matrix)
    // 动态过滤范围（每帧从 JS 端传入最新值）
    gl.uniform1f(loc.uFilterMin, this.filterMin)
    gl.uniform1f(loc.uFilterMax, this.filterMax)
    // 全局透明度
    gl.uniform1f(loc.uOpacity, this.opacity)

    // ── 绑定顶点坐标缓冲：a_position（2 个 float/顶点） ──
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer)
    gl.enableVertexAttribArray(loc.aPosition)
    // vertexAttribPointer 参数说明：
    //   index  — attribute 位置
    //   size   — 每个顶点的分量数量（2 = vec2）
    //   type   — 数据类型 FLOAT（32位浮点）
    //   normalized — 是否归一化（整型 attribute 才有意义，float 传 false）
    //   stride — 两个顶点起始字节之间的步长（0 = 紧密排列）
    //   offset — 从缓冲区起始的偏移字节
    gl.vertexAttribPointer(loc.aPosition, 2, gl.FLOAT, false, 0, 0)

    // ── 绑定颜色缓冲：a_color（4 个 float/顶点） ──
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer)
    gl.enableVertexAttribArray(loc.aColor)
    gl.vertexAttribPointer(loc.aColor, 4, gl.FLOAT, false, 0, 0)

    // ── 绑定数据值缓冲：a_value（1 个 float/顶点） ──
    gl.bindBuffer(gl.ARRAY_BUFFER, this.valueBuffer)
    gl.enableVertexAttribArray(loc.aValue)
    gl.vertexAttribPointer(loc.aValue, 1, gl.FLOAT, false, 0, 0)

    // ── 启用 Alpha 混合（透明渲染） ──
    // SRC_ALPHA / ONE_MINUS_SRC_ALPHA 是标准 "over" 混合公式：
    //   output = src.rgb * src.a + dst.rgb * (1 - src.a)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    // ── 绑定索引缓冲并执行绘制 ──
    // drawElements 使用索引数组引用顶点，避免顶点重复存储
    // UNSIGNED_INT 支持超过 65535 个顶点（需要 OES_element_index_uint 扩展）
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
    gl.drawElements(gl.TRIANGLES, this.numIndices, gl.UNSIGNED_INT, 0)
  }

  /**
   * onRemove
   * 由 Mapbox 在 `map.removeLayer()` 时调用。
   * 释放所有 WebGL GPU 资源并清理事件监听。
   */
  onRemove(_map: mapboxgl.Map, gl: WebGLRenderingContext): void {
    this._releaseGLResources(gl)
    this._unregisterMapEvents()
    this.map = null
    this.gl = null
  }

  // ─────────────────────────────────────────────────────
  //  公共 API
  // ─────────────────────────────────────────────────────

  /**
   * 设置数据值过滤范围。
   *
   * 调用后需在外部执行 map.triggerRepaint() 触发重绘：
   * ```ts
   * layer.setFilter(10, 35)
   * map.triggerRepaint()
   * ```
   * @param min — 过滤下限（含）
   * @param max — 过滤上限（含）
   */
  setFilter(min: number, max: number): void {
    this.filterMin = min
    this.filterMax = max
    this.map?.triggerRepaint()
  }

  /**
   * 获取当前过滤范围
   */
  getFilter(): { min: number; max: number } {
    return { min: this.filterMin, max: this.filterMax }
  }

  /**
   * 动态修改整体透明度。
   * @param opacity — [0, 1]，0 完全透明，1 完全不透明
   */
  setOpacity(opacity: number): void {
    this.opacity = Math.max(0, Math.min(1, opacity))
    this.map?.triggerRepaint()
  }

  /**
   * 更新格点数据（无需重建图层，直接替换 GPU 缓冲）。
   * 适用于数据实时刷新场景。
   *
   * 调用后需在外部执行 map.triggerRepaint() 触发重绘。
   * @param newData — 新的格点数据，行列数可变
   */
  updateData(newData: GridData): void {
    this.gridData = newData
    if (this.gl) {
      this._buildBuffers(this.gl)
      this.map?.triggerRepaint()
    }
  }

  /**
   * 获取当前格点数据的地理范围。
   * @returns { lonMin, lonMax, latMin, latMax }
   */
  getBounds(): { lonMin: number; lonMax: number; latMin: number; latMax: number } {
    const { lonStart, latStart, lonStep, latStep, rows, cols } = this.gridData
    return {
      lonMin: lonStart,
      lonMax: lonStart + cols * lonStep,
      latMin: latStart,
      latMax: latStart + rows * latStep
    }
  }

  // ─────────────────────────────────────────────────────
  //  私有方法
  // ─────────────────────────────────────────────────────

  /**
   * 根据 gridData 构建 WebGL 缓冲数据并上传 GPU。
   *
   * 数据布局说明
   * ──────────────────────────────────────────────────
   * 设格点为 rows × cols，则顶点网格为 (rows+1) × (cols+1)。
   *
   * 顶点编号示意（rows=2, cols=3）：
   *   0  1  2  3
   *   4  5  6  7
   *   8  9 10 11
   *
   * 每个"格子"由两个三角形组成：
   *   ┌─────┐
   *   │ ╲ ₂│   三角形 1: topLeft, bottomLeft, topRight
   *   │₁ ╲ │   三角形 2: topRight, bottomLeft, bottomRight
   *   └─────┘
   *
   * 为何使用索引（Index Buffer）？
   *   相邻格子共享顶点，索引方式可避免重复存储顶点数据。
   *   对于 100×200 的格点，顶点数 = 101×201 = 20301，
   *   但三角形数 = 2×100×200 = 40000，索引数 = 120000。
   *
   * UNSIGNED_INT 说明
   *   WebGL 默认 drawElements 只支持 UNSIGNED_SHORT（最多 65535 顶点）。
   *   启用 OES_element_index_uint 扩展后可用 UNSIGNED_INT，支持更大数据量。
   */
  private _buildBuffers(gl: WebGLRenderingContext): void {
    // 尝试启用 32 位索引扩展（大多数现代设备均支持）
    gl.getExtension('OES_element_index_uint')

    const { lonStart, latStart, lonStep, latStep, rows, cols, values } = this.gridData

    // 顶点网格尺寸
    const vRows = rows + 1
    const vCols = cols + 1
    const vertexCount = vRows * vCols

    const positions = new Float32Array(vertexCount * 2)   // (x, y) × 顶点数
    const colors = new Float32Array(vertexCount * 4)      // (r, g, b, a) × 顶点数
    const valuesArr = new Float32Array(vertexCount)       // value × 顶点数

    // ── 填充顶点属性 ──────────────────────────────────
    for (let row = 0; row < vRows; row++) {
      for (let col = 0; col < vCols; col++) {
        const idx = row * vCols + col

        // 经纬度坐标
        const lon = lonStart + col * lonStep
        const lat = latStart + row * latStep

        // Mercator 坐标
        const [mx, my] = lngLatToMercator(lon, lat)
        positions[idx * 2] = mx
        positions[idx * 2 + 1] = my

        // 取最近格点的数值（顶点在格点网格边界时取相邻格点），边界是指右/下边界
        const r = Math.min(row, rows - 1)
        const c = Math.min(col, cols - 1)
        const val = values[r]?.[c] ?? 0
        valuesArr[idx] = val

        // 颜色插值
        const [cr, cg, cb, ca] = interpolateColor(val, this.colorStops)
        colors[idx * 4] = cr
        colors[idx * 4 + 1] = cg
        colors[idx * 4 + 2] = cb
        colors[idx * 4 + 3] = ca
      }
    }

    // ── 构建三角形索引 ─────────────────────────────────
    const indexCount = rows * cols * 6  // 每格 2 个三角形 × 3 个顶点
    const indices = new Uint32Array(indexCount)
    let iPtr = 0

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const tl = row * vCols + col         // top-left
        const tr = tl + 1                    // top-right
        const bl = (row + 1) * vCols + col  // bottom-left
        const br = bl + 1                   // bottom-right

        // 三角形 1（左下）
        indices[iPtr++] = tl
        indices[iPtr++] = bl
        indices[iPtr++] = tr

        // 三角形 2（右上）
        indices[iPtr++] = tr
        indices[iPtr++] = bl
        indices[iPtr++] = br
      }
    }
    this.numIndices = indexCount

    // ── 创建或复用缓冲区并上传数据 ─────────────────────
    this.vertexBuffer = this._uploadBuffer(gl, this.vertexBuffer, positions, gl.ARRAY_BUFFER)
    this.colorBuffer = this._uploadBuffer(gl, this.colorBuffer, colors, gl.ARRAY_BUFFER)
    this.valueBuffer = this._uploadBuffer(gl, this.valueBuffer, valuesArr, gl.ARRAY_BUFFER)
    this.indexBuffer = this._uploadBuffer(gl, this.indexBuffer, indices, gl.ELEMENT_ARRAY_BUFFER)
  }

  /**
   * 将 TypedArray 数据上传到 GPU 缓冲区。
   * 若缓冲区已存在则复用，否则新建。
   *
   * @param gl      — WebGL 上下文
   * @param buf     — 已有的 WebGLBuffer（可为 null）
   * @param data    — 待上传的 TypedArray
   * @param target  — 缓冲绑定目标（ARRAY_BUFFER 或 ELEMENT_ARRAY_BUFFER）
   * @returns       — 绑定并填充好的 WebGLBuffer
   */
  private _uploadBuffer(
    gl: WebGLRenderingContext,
    buf: WebGLBuffer | null,
    data: BufferSource,
    target: number
  ): WebGLBuffer {
    const buffer = buf ?? gl.createBuffer()!
    gl.bindBuffer(target, buffer)
    // STATIC_DRAW 提示 GPU 数据不会频繁修改，利于驱动优化
    gl.bufferData(target, data, gl.STATIC_DRAW)
    return buffer
  }

  /**
   * 注册图层相关的地图交互事件。
   * - click     — 格点点击，回调 GridClickInfo
   * - mousemove — 在数据覆盖范围内改变鼠标指针为 pointer
   */
  private _registerMapEvents(): void {
    if (!this.map || !this.onClickCallback) return
    const map = this.map

    // 点击事件处理器
    const handleClick = (e: mapboxgl.MapMouseEvent) => {
      const info = this._hitTest(e.lngLat.lng, e.lngLat.lat)
      if (info && this.onClickCallback) {
        this.onClickCallback(info)
      }
    }

    // 鼠标移动事件处理器：在数据范围内显示 pointer 样式
    const handleMousemove = (e: mapboxgl.MapMouseEvent) => {
      const inside = this._isInsideBounds(e.lngLat.lng, e.lngLat.lat)
      map.getCanvas().style.cursor = inside ? 'pointer' : ''
    }

    map.on('click', handleClick)
    map.on('mousemove', handleMousemove)

    // 保存清理函数，onRemove 时调用
    this.clickCleanup = () => map.off('click', handleClick)
    this.mousemoveCleanup = () => {
      map.off('mousemove', handleMousemove)
      map.getCanvas().style.cursor = ''
    }
  }

  /** 移除地图交互事件 */
  private _unregisterMapEvents(): void {
    this.clickCleanup?.()
    this.mousemoveCleanup?.()
    this.clickCleanup = null
    this.mousemoveCleanup = null
  }

  /**
   * 空间命中检测：将经纬度坐标反算为格点索引并返回格点信息。
   * @returns GridClickInfo 或 null（点击位置在数据范围外）
   */
  private _hitTest(lng: number, lat: number): GridClickInfo | null {
    const { lonStart, latStart, lonStep, latStep, rows, cols, values } = this.gridData
    if (!this._isInsideBounds(lng, lat)) return null

    const col = Math.floor((lng - lonStart) / lonStep)
    const row = Math.floor((lat - latStart) / latStep)

    // 边界夹紧（防止浮点精度误差导致越界）
    const safeRow = Math.max(0, Math.min(rows - 1, row))
    const safeCol = Math.max(0, Math.min(cols - 1, col))

    return {
      lng,
      lat,
      value: values[safeRow]?.[safeCol] ?? 0,
      row: safeRow,
      col: safeCol
    }
  }

  /**
   * 判断经纬度坐标是否在格点数据地理范围内。
   */
  private _isInsideBounds(lng: number, lat: number): boolean {
    const bounds = this.getBounds()
    return (
      lng >= bounds.lonMin &&
      lng <= bounds.lonMax &&
      lat >= bounds.latMin &&
      lat <= bounds.latMax
    )
  }

  /**
   * 释放所有 WebGL GPU 资源。
   * 须在 onRemove 时调用，否则 GPU 内存泄漏。
   */
  private _releaseGLResources(gl: WebGLRenderingContext): void {
    if (this.program) {
      gl.deleteProgram(this.program)
      this.program = null
    }
    if (this.vertexBuffer) {
      gl.deleteBuffer(this.vertexBuffer)
      this.vertexBuffer = null
    }
    if (this.colorBuffer) {
      gl.deleteBuffer(this.colorBuffer)
      this.colorBuffer = null
    }
    if (this.valueBuffer) {
      gl.deleteBuffer(this.valueBuffer)
      this.valueBuffer = null
    }
    if (this.indexBuffer) {
      gl.deleteBuffer(this.indexBuffer)
      this.indexBuffer = null
    }
    this.numIndices = 0
  }
}
