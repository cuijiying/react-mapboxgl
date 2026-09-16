/**
 * GridLayer2.ts
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 *  工业级优化：基于 GPU 纹理采样的高性能格点渲染图层
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 与 GridLayer.ts（V1）的核心区别
 * ─────────────────────────────────────────────────────────────────────────────
 * V1 做法：为每个格子创建 2 个三角形，顶点数 = (rows+1)*(cols+1)，
 *          索引数 = rows*cols*6。数据量大时 CPU 侧构建和 GPU 侧绘制都很慢。
 *
 * V2 做法（本文件）：
 *   ✅ 只画一个四边形（2 个三角形，6 个顶点），覆盖整个格点范围
 *   ✅ 将数据值存入 GPU 纹理（DATA_TEXTURE），片元着色器通过纹理坐标采样获取值
 *   ✅ 将色标存入 1D 纹理（COLOR_RAMP_TEXTURE），在 GPU 上完成 value → color 映射
 *   ✅ 使用 texSubImage2D 实现增量数据更新，支持时间动画等场景
 *   ✅ 关闭 depthTest 提升性能（2D 图层无需深度测试）
 *
 * 整体流程示意
 * ─────────────────────────────────────────────────────────────────────────────
 *   CPU 端                                         GPU 端
 *  ┌──────────┐  上传纹理   ┌──────────────────┐   采样   ┌──────────────┐
 *  │ 格点数据  ├───────────►│  数据纹理(L/U8)  ├────────►│              │
 *  │ rows×cols │            └──────────────────┘         │  片元着色器  │──► 像素
 *  └──────────┘                                          │  (查色、过滤) │
 *  ┌──────────┐  上传纹理   ┌──────────────────┐   采样   │              │
 *  │ 色标数组  ├───────────►│ 色带纹理(RGBA)   ├────────►│              │
 *  └──────────┘            └──────────────────┘         └──────────────┘
 *
 * 着色器说明
 * ─────────────────────────────────────────────────────────────────────────────
 * 顶点着色器：
 *   - 只处理 4 个顶点（覆盖格点矩形范围的四个角）
 *   - 将 Mercator 坐标通过 MVP 矩阵转换到裁剪空间
 *   - 传递 UV 纹理坐标给片元着色器
 *
 * 片元着色器：
 *   1. 用 UV 坐标从数据纹理中采样，得到原始数据值
 *   2. 将数据值归一化到 [0, 1] 范围（根据色标的最小值和最大值）
 *   3. 用归一化后的值从色带纹理中采样，得到对应颜色
 *   4. 如果数据值超出过滤范围，执行 discard 丢弃该片元
 *   5. 乘以全局透明度后输出最终颜色
 */

import mapboxgl from 'mapbox-gl'

// ═══════════════════════════════════════════════════════════════════════════════
//  类型定义（与 GridLayer V1 共享相同接口，方便迁移）
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 单个颜色分段节点
 * @example { value: 20, color: [254, 224, 144, 255] }
 */
export interface ColorStop {
  value: number
  color: [number, number, number, number]   // RGBA，范围 [0, 255]
}

/**
 * 格点数据结构
 * @property lonStart — 左下角经度
 * @property latStart — 左下角纬度
 * @property lonStep  — 经向步长（°/格）
 * @property latStep  — 纬向步长（°/格）
 * @property rows     — 纬向行数
 * @property cols     — 经向列数
 * @property values   — values[row][col]，二维数据数组
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
 * 格点点击信息
 */
export interface GridClickInfo {
  lng: number
  lat: number
  value: number
  row: number
  col: number
}

/**
 * GridLayer2 构造选项
 * @property layerId    — 图层唯一标识（默认 'grid-layer-2'）
 * @property gridData   — 格点数据（必填）
 * @property colorStops — 色标分段数组（必填，至少 2 个节点）
 * @property opacity    — 全局透明度 [0, 1]，默认 0.85
 * @property filterMin  — 初始过滤下限（默认 colorStops 最小值）
 * @property filterMax  — 初始过滤上限（默认 colorStops 最大值）
 */
/**
 * 色斑图显示方式
 * - smooth       — 连续渐变色斑（默认）
 * - filled       — 等值面：按图例色标节点分段填色
 * - lines        — 等值线：仅绘制色标节点处的等值线
 * - filled+lines — 等值面 + 等值线叠加
 */
export type GridDisplayMode = 'smooth' | 'filled' | 'lines' | 'filled+lines'

export interface GridLayer2Options {
  layerId?: string
  gridData: GridData
  colorStops: ColorStop[]
  opacity?: number
  filterMin?: number
  filterMax?: number
  /** 显示方式，默认 'smooth' */
  displayMode?: GridDisplayMode
  /** 等值线颜色 RGBA [0, 255]，默认黑色半透明 */
  contourLineColor?: [number, number, number, number]
  /** 等值线宽度（纹理像素单位），默认 1.5 */
  contourLineWidth?: number
}

/** 图层事件类型映射 */
export interface GridLayer2EventMap {
  click: GridClickInfo
}

// ═══════════════════════════════════════════════════════════════════════════════
//  常量
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 色带纹理的宽度（像素数）。
 * 值越大，色标插值越细腻。256 对大多数场景已足够。
 */
const COLOR_RAMP_WIDTH = 256

/** 着色器中色标节点 uniform 数组的最大长度 */
const MAX_CONTOUR_LEVELS = 32

// ═══════════════════════════════════════════════════════════════════════════════
//  GLSL 着色器源码
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ─── 顶点着色器 ──────────────────────────────────────────────
 *
 * 输入 Attribute：
 *   a_position  — Mercator 坐标 (x, y)，范围 [0, 1]
 *   a_texCoord  — 纹理坐标 (u, v)，范围 [0, 1]
 *
 * 输入 Uniform：
 *   u_matrix    — Mapbox 传入的 4×4 MVP 矩阵
 *
 * 输出 Varying：
 *   v_texCoord  — 传递给片元着色器的纹理坐标
 *
 * 工作原理：
 *   将覆盖整个格点范围的矩形（4 个顶点）通过 MVP 矩阵
 *   变换到屏幕裁剪空间，同时传递 UV 以便片元着色器采样。
 */
const VERTEX_SHADER_SOURCE = `
  // ── Attribute（每个顶点独有的数据） ──
  attribute vec2 a_position;    // Mercator 投影坐标 (x, y)
  attribute vec2 a_texCoord;    // 纹理坐标 (u, v)

  // ── Uniform（所有顶点共享的数据） ──
  uniform mat4 u_matrix;        // Mapbox 提供的 Model-View-Projection 矩阵

  // ── Varying（传递给片元着色器，自动插值） ──
  varying vec2 v_texCoord;      // 插值后的纹理坐标

  void main() {
    // 1. 将 Mercator 平面坐标 [0,1]×[0,1] 通过矩阵变换到裁剪空间 [-1,1]^3
    //    vec4 的第三个分量 0.0 是 z 坐标（2D 图层 z=0）
    //    第四个分量 1.0 是齐次坐标 w
    gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);

    // 2. 直接传递纹理坐标，GPU 会在三角形内部自动做双线性插值
    v_texCoord = a_texCoord;
  }
`

/**
 * ─── 片元着色器 ──────────────────────────────────────────────
 *
 * 输入 Varying：
 *   v_texCoord    — 从顶点着色器插值得到的纹理坐标
 *
 * 输入 Uniform：
 *   u_dataTexture — 数据纹理（存储格点值，R 通道 = 归一化后的值）
 *   u_colorRamp   — 色带纹理（1D 查找表，横向坐标映射颜色）
 *   u_filterMin   — 过滤下限（原始数据值单位）
 *   u_filterMax   — 过滤上限
 *   u_dataMin     — 实际数据值域最小值（用于纹理 → 真实值反算）
 *   u_dataMax     — 实际数据值域最大值（用于纹理 → 真实值反算）
 *   u_colorMin    — 色标值域最小值（用于真实值 → 色带纹理坐标映射）
 *   u_colorMax    — 色标值域最大值（用于真实值 → 色带纹理坐标映射）
 *   u_opacity     — 全局透明度 [0, 1]
 *
 * 🔑 为什么需要两套值域（dataMin/dataMax 与 colorMin/colorMax）？
 *   数据纹理使用 UNSIGNED_BYTE 存储，值被归一化到 [0, 255]。
 *   归一化的基准是实际数据值域 [dataMin, dataMax]，这样才能完整保留所有数据精度。
 *   色带纹理是基于色标值域 [colorMin, colorMax] 构建的颜色查找表。
 *   这两个范围可能不同！例如：
 *     - 色标：[0°C=蓝, 40°C=红] → colorMin=0, colorMax=40
 *     - 实际数据：[-10°C ~ 50°C] → dataMin=-10, dataMax=50
 *   着色器需要两次映射：
 *     t → realValue（用 dataMin/dataMax）→ colorT（用 colorMin/colorMax）→ 颜色
 *
 * 工作原理：
 *   1. 从数据纹理采样得到归一化后的数据值 t ∈ [0, 1]
 *   2. 用 dataMin/dataMax 将 t 反算回真实数据值，判断是否在过滤范围内
 *   3. 用 colorMin/colorMax 将真实值重新映射为色带纹理坐标 colorT，查找颜色
 *   4. 乘以全局透明度后输出
 */
const FRAGMENT_SHADER_SOURCE = `
  precision mediump float;

  #define MAX_CONTOUR_LEVELS ${MAX_CONTOUR_LEVELS}

  varying vec2 v_texCoord;

  uniform sampler2D u_dataTexture;
  uniform sampler2D u_colorRamp;

  uniform float u_filterMin;
  uniform float u_filterMax;
  uniform float u_dataMin;
  uniform float u_dataMax;
  uniform float u_colorMin;
  uniform float u_colorMax;
  uniform float u_opacity;

  // 显示模式：0=smooth, 1=filled, 2=lines, 3=filled+lines
  uniform float u_displayMode;
  uniform float u_contourLevels[MAX_CONTOUR_LEVELS];
  uniform float u_contourCount;
  uniform vec2 u_texelSize;
  uniform vec4 u_contourLineColor;
  uniform float u_contourLineWidth;

  float sampleRealValue(vec2 uv) {
    float t = texture2D(u_dataTexture, uv).r;
    return u_dataMin + t * (u_dataMax - u_dataMin);
  }

  vec4 lookupColor(float realValue) {
    float colorT = clamp((realValue - u_colorMin) / (u_colorMax - u_colorMin), 0.0, 1.0);
    return texture2D(u_colorRamp, vec2(colorT, 0.5));
  }

  // WebGL 数组下标只能是常量或循环变量，用 loop 取末级色标值
  float getContourTopLevel() {
    float topLevel = u_contourLevels[0];
    for (int i = 0; i < MAX_CONTOUR_LEVELS; i++) {
      if (float(i + 1) >= u_contourCount) {
        topLevel = u_contourLevels[i];
        break;
      }
    }
    return topLevel;
  }

  // 等值面：按图例色标节点分段，每段使用下界节点颜色
  vec4 getFilledColor(float realValue) {
    int count = int(u_contourCount);
    if (count < 2) {
      return lookupColor(realValue);
    }

    for (int i = 0; i < MAX_CONTOUR_LEVELS - 1; i++) {
      if (float(i) >= u_contourCount - 1.0) break;

      float lo = u_contourLevels[i];
      float hi = u_contourLevels[i + 1];
      if (realValue >= lo && realValue < hi) {
        return lookupColor(lo);
      }
    }

    // 图例最高档：≥ 末级色标值（如 ≥ 40°C）
    float topLevel = getContourTopLevel();
    if (realValue >= topLevel) {
      return lookupColor(topLevel);
    }

    return lookupColor(realValue);
  }

  // 等值线：检测当前像素与相邻像素是否跨越色标节点值
  float getContourLineAlpha(vec2 uv, float centerValue) {
    float lineAlpha = 0.0;
    vec2 e = u_texelSize * u_contourLineWidth;

    float vR = sampleRealValue(uv + vec2(e.x, 0.0));
    float vL = sampleRealValue(uv - vec2(e.x, 0.0));
    float vU = sampleRealValue(uv - vec2(0.0, e.y));
    float vD = sampleRealValue(uv + vec2(0.0, e.y));

    for (int i = 0; i < MAX_CONTOUR_LEVELS; i++) {
      if (float(i) >= u_contourCount) break;

      float level = u_contourLevels[i];
      bool crossR = (centerValue - level) * (vR - level) <= 0.0;
      bool crossL = (centerValue - level) * (vL - level) <= 0.0;
      bool crossU = (centerValue - level) * (vU - level) <= 0.0;
      bool crossD = (centerValue - level) * (vD - level) <= 0.0;

      if (crossR || crossL || crossU || crossD) {
        lineAlpha = 1.0;
      }
    }

    return lineAlpha;
  }

  void main() {
    float realValue = sampleRealValue(v_texCoord);

    if (realValue < u_filterMin || realValue > u_filterMax) {
      discard;
    }

    vec4 fillColor;
    if (u_displayMode < 0.5) {
      // smooth — 连续渐变色斑
      fillColor = lookupColor(realValue);
    } else if (u_displayMode < 1.5 || u_displayMode >= 2.5) {
      // filled 或 filled+lines — 分段等值面
      fillColor = getFilledColor(realValue);
    } else {
      // lines — 仅等值线，底色透明
      fillColor = vec4(0.0);
    }

    float lineAlpha = 0.0;
    if (u_displayMode >= 1.5) {
      lineAlpha = getContourLineAlpha(v_texCoord, realValue);
    }

    if (lineAlpha > 0.0) {
      vec3 rgb = mix(fillColor.rgb, u_contourLineColor.rgb, lineAlpha);
      float alpha = max(fillColor.a, lineAlpha * u_contourLineColor.a) * u_opacity;
      gl_FragColor = vec4(rgb, alpha);
    } else if (u_displayMode >= 1.5 && u_displayMode < 2.5) {
      // lines 模式：非等值线区域透明
      discard;
    } else {
      gl_FragColor = vec4(fillColor.rgb, fillColor.a * u_opacity);
    }
  }
`

// ═══════════════════════════════════════════════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 将地理经纬度 (lon, lat) 转换为 Web Mercator 归一化坐标 [0, 1]。
 *
 * Web Mercator（EPSG:3857）是几乎所有 Web 地图使用的投影方式。
 *
 * 公式推导：
 *   x = (lon + 180°) / 360°              → 经度线性映射到 [0, 1]
 *   y = (1 - ln(tan(φ) + sec(φ))/π) / 2  → 纬度非线性映射到 [0, 1]
 *
 * 其中 φ 是纬度的弧度值。
 * Mapbox GL JS 内部使用这个坐标系，全球范围对应 [0,1]×[0,1]。
 */
function lngLatToMercator(lon: number, lat: number): [number, number] {
  const x = (lon + 180) / 360
  const latRad = (lat * Math.PI) / 180
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2
  return [x, y]
}

/**
 * 编译单个 WebGL 着色器（Vertex 或 Fragment）。
 *
 * WebGL 着色器编译流程：
 *   1. gl.createShader(type)     — 创建空的着色器对象
 *   2. gl.shaderSource(s, code)  — 绑定 GLSL 源码
 *   3. gl.compileShader(s)       — 编译
 *   4. gl.getShaderParameter()   — 检查编译是否成功
 *
 * @param gl     — WebGL 渲染上下文
 * @param type   — gl.VERTEX_SHADER 或 gl.FRAGMENT_SHADER
 * @param source — GLSL 着色器源码
 * @returns 编译后的 WebGLShader 对象
 */
function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string
): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('[GridLayer2] 无法创建着色器对象')

  gl.shaderSource(shader, source)   // 绑定源码
  gl.compileShader(shader)          // 编译

  // 检查编译状态
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`[GridLayer2] 着色器编译失败:\n${info}`)
  }
  return shader
}

/**
 * 将顶点着色器和片元着色器链接为可执行的 WebGLProgram。
 *
 * 链接流程：
 *   1. gl.createProgram()              — 创建 Program 对象
 *   2. gl.attachShader(prog, vs/fs)    — 附加两个着色器
 *   3. gl.linkProgram(prog)            — 链接
 *   4. gl.getProgramParameter()        — 检查链接结果
 */
function createProgram(
  gl: WebGLRenderingContext,
  vs: WebGLShader,
  fs: WebGLShader
): WebGLProgram {
  const program = gl.createProgram()
  if (!program) throw new Error('[GridLayer2] 无法创建 WebGLProgram')

  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`[GridLayer2] Program 链接失败:\n${info}`)
  }
  return program
}

/**
 * 根据色标数组生成 256×1 的 RGBA 色带像素数据。
 *
 * 色带纹理用法：
 *   - 纹理宽度 = 256 像素（足够细腻的颜色渐变）
 *   - 每个像素存 RGBA 4 字节
 *   - 第 i 个像素对应归一化值 t = i / 255
 *   - 通过线性插值色标数组，计算该 t 对应的颜色
 *
 * 这样在着色器中只需一次纹理采样即可完成 value → color 映射，
 * 不再需要在 JavaScript 中为每个顶点预计算颜色。
 *
 * @param colorStops — 已按 value 升序排列的色标节点数组
 * @returns Uint8Array，长度 = 256 * 4（RGBA）
 */
function buildColorRampPixels(colorStops: ColorStop[]): Uint8Array {
  const pixels = new Uint8Array(COLOR_RAMP_WIDTH * 4)

  // 色标值域范围
  const minVal = colorStops[0]!.value
  const maxVal = colorStops[colorStops.length - 1]!.value
  const range = maxVal - minVal

  for (let i = 0; i < COLOR_RAMP_WIDTH; i++) {
    // 当前像素对应的真实数据值
    const t = i / (COLOR_RAMP_WIDTH - 1)         // 归一化 [0, 1]
    const value = minVal + t * range               // 反算到原始值域

    // 在色标数组中做线性插值
    const rgba = interpolateColor(value, colorStops)

    // 写入像素（颜色值已是 [0,255] 范围，直接写入并裁剪）
    pixels[i * 4 + 0] = Math.max(0, Math.min(255, Math.round(rgba[0]))) // R
    pixels[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(rgba[1]))) // G
    pixels[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(rgba[2]))) // B
    pixels[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(rgba[3]))) // A
  }

  return pixels
}

/**
 * 在色标数组中对给定值做线性插值，返回 RGBA 颜色值（范围 [0, 255]）。
 * （与 GridLayer V1 中的同名函数逻辑相同）
 */
function interpolateColor(
  value: number,
  colorStops: ColorStop[]
): [number, number, number, number] {
  const n = colorStops.length
  if (n === 0) return [255, 255, 255, 255]  // 无色标时返回白色（[0,255] 范围）

  const first = colorStops[0]!
  const last = colorStops[n - 1]!

  if (value <= first.value) return [...first.color] as [number, number, number, number]
  if (value >= last.value) return [...last.color] as [number, number, number, number]

  for (let i = 0; i < n - 1; i++) {
    const lo = colorStops[i]!
    const hi = colorStops[i + 1]!
    if (value >= lo.value && value < hi.value) {
      const t = (value - lo.value) / (hi.value - lo.value)
      return [
        lo.color[0] + t * (hi.color[0] - lo.color[0]),
        lo.color[1] + t * (hi.color[1] - lo.color[1]),
        lo.color[2] + t * (hi.color[2] - lo.color[2]),
        lo.color[3] + t * (hi.color[3] - lo.color[3])
      ]
    }
  }
  // 理论上不会执行到这里（for 循环已覆盖所有区间），作为安全兜底返回白色
  return [255, 255, 255, 255]
}

/**
 * 将二维格点数据展平为一维 Uint8Array，同时做归一化。
 *
 * 归一化公式：t = (value - minVal) / (maxVal - minVal)
 * 结果 t ∈ [0, 1]，存入纹理的 R 通道。
 *
 * 为什么要归一化？
 *   WebGL 的 LUMINANCE + FLOAT 纹理虽然可以存原始值，
 *   但并非所有设备都支持浮点纹理。将值归一化到 [0,1] 后，
 *   可以用普通 LUMINANCE + UNSIGNED_BYTE 纹理存储
 *   （精度 1/255 ≈ 0.004，对温度等场景足够）。
 *   同时这也与色带纹理的采样坐标 [0,1] 自然对齐。
 *
 * @param values — 二维数据数组 values[row][col]
 * @param rows   — 行数
 * @param cols   — 列数
 * @param minVal — 归一化下界
 * @param maxVal — 归一化上界
 * @returns 展平并归一化的 Uint8Array，长度 = rows * cols
 */
function flattenAndNormalize(
  values: number[][],
  rows: number,
  cols: number,
  minVal: number,
  maxVal: number
): Uint8Array {
  const data = new Uint8Array(rows * cols)
  const range = maxVal - minVal || 1 // 避免除零

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const val = values[row]?.[col] ?? minVal
      // 归一化到 [0, 1]，然后缩放到 [0, 255]
      const t = Math.max(0, Math.min(1, (val - minVal) / range))
      data[row * cols + col] = Math.round(t * 255)
    }
  }
  return data
}

/** 将显示模式枚举映射为着色器 uniform 数值 */
function displayModeToUniform(mode: GridDisplayMode): number {
  switch (mode) {
    case 'filled': return 1
    case 'lines': return 2
    case 'filled+lines': return 3
    default: return 0
  }
}

/** 构建等值线/等值面所用的色标节点 uniform 数组 */
function buildContourLevelsUniform(colorStops: ColorStop[]): Float32Array {
  const levels = new Float32Array(MAX_CONTOUR_LEVELS)
  const count = Math.min(colorStops.length, MAX_CONTOUR_LEVELS)
  for (let i = 0; i < count; i++) {
    levels[i] = colorStops[i]!.value
  }
  return levels
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GridLayer2 主类
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GridLayer2 — 基于 GPU 纹理采样的高性能格点自定义图层。
 *
 * 核心优化思路：
 * ─────────────────────────────────────────────────────────────────────────────
 * 传统做法（V1）：                   本做法（V2）：
 *   CPU 构建百万级顶点/三角形         只有 4 个顶点（一个矩形）
 *   CPU 预计算每个顶点的颜色          GPU 纹理采样 → 自动颜色映射
 *   更新数据要重建所有缓冲             texSubImage2D 增量传输
 *   无法动态换色标                     替换色带纹理即可
 *
 * GPU 纹理管线：
 * ─────────────────────────────────────────────────────────────────────────────
 * ┌───────────────┐         ┌───────────────┐         ┌───────────────┐
 * │   数据纹理     │  采样   │   片元着色器   │  采样   │   色带纹理     │
 * │ (rows × cols) ├────────►│               ├────────►│  (256 × 1)    │
 * │ LUMINANCE U8  │    t    │  t → color    │  color  │  RGBA U8      │
 * └───────────────┘         └───────────────┘         └───────────────┘
 *
 * 使用示例：
 * ```ts
 * const layer = new GridLayer2({
 *   gridData: myGridData,
 *   colorStops: myColorStops,
 * })
 * map.addLayer(layer)
 *
 * // 监听点击事件
 * layer.on('click', (info) => console.log(info))
 *
 * // 动态更新过滤范围
 * layer.setFilter(10, 35)
 *
 * // 动态更新数据（时间动画）
 * layer.updateData(newGridData)
 * ```
 */
export class GridLayer2 implements mapboxgl.CustomLayerInterface {
  // ── Mapbox CustomLayerInterface 必需字段 ──
  readonly id: string
  readonly type = 'custom' as const
  readonly renderingMode = '2d' as const
  /** 渲染槽位：middle 使 GPU 色斑图位于矢量标注层下方 */
  readonly slot = 'middle' as const

  // ── 配置数据 ──
  private colorStops: ColorStop[]
  private gridData: GridData
  private opacity: number

  // ── 色标值域（用于色带纹理映射） ──
  private colorMin: number
  private colorMax: number

  // ── 实际数据值域（用于数据纹理归一化） ──
  private dataMin: number
  private dataMax: number

  // ── 过滤范围 ──
  private filterMin: number
  private filterMax: number

  // ── 显示方式 ──
  private displayMode: GridDisplayMode
  private contourLineColor: [number, number, number, number]
  private contourLineWidth: number
  private contourLevelsUniform: Float32Array

  // ── 事件系统 ──
  private eventHandlers: { [K in keyof GridLayer2EventMap]?: ((data: GridLayer2EventMap[K]) => void)[] } = {}

  // ── 地图引用 ──
  private map: mapboxgl.Map | null = null

  // ── WebGL 资源 ──
  private gl: WebGLRenderingContext | null = null
  private program: WebGLProgram | null = null

  // 顶点缓冲：只有 4 个顶点（矩形的四个角）
  private positionBuffer: WebGLBuffer | null = null
  private texCoordBuffer: WebGLBuffer | null = null
  // 索引缓冲：2 个三角形 = 6 个索引
  private indexBuffer: WebGLBuffer | null = null

  // GPU 纹理
  private dataTexture: WebGLTexture | null = null     // 数据纹理 (rows × cols)
  private colorRampTexture: WebGLTexture | null = null // 色带纹理 (256 × 1)

  // Attribute / Uniform 位置缓存
  private loc = {
    aPosition: -1,
    aTexCoord: -1,
    uMatrix: null as WebGLUniformLocation | null,
    uDataTexture: null as WebGLUniformLocation | null,
    uColorRamp: null as WebGLUniformLocation | null,
    uFilterMin: null as WebGLUniformLocation | null,
    uFilterMax: null as WebGLUniformLocation | null,
    uDataMin: null as WebGLUniformLocation | null,
    uDataMax: null as WebGLUniformLocation | null,
    uColorMin: null as WebGLUniformLocation | null,
    uColorMax: null as WebGLUniformLocation | null,
    uOpacity: null as WebGLUniformLocation | null,
    uDisplayMode: null as WebGLUniformLocation | null,
    uContourLevels: null as WebGLUniformLocation | null,
    uContourCount: null as WebGLUniformLocation | null,
    uTexelSize: null as WebGLUniformLocation | null,
    uContourLineColor: null as WebGLUniformLocation | null,
    uContourLineWidth: null as WebGLUniformLocation | null
  }

  // ── 事件清理函数 ──
  private clickCleanup: (() => void) | null = null
  private mousemoveCleanup: (() => void) | null = null

  // ═══════════════════════════════════════════════════════════════════════════
  //  构造函数
  // ═══════════════════════════════════════════════════════════════════════════

  constructor(options: GridLayer2Options) {
    this.id = options.layerId ?? 'grid-layer-2'
    this.gridData = options.gridData
    this.colorStops = [...options.colorStops].sort((a, b) => a.value - b.value)
    this.opacity = options.opacity ?? 0.85

    // 色标值域范围（用于色带纹理映射）
    const stopValues = this.colorStops.map((s) => s.value)
    this.colorMin = Math.min(...stopValues)
    this.colorMax = Math.max(...stopValues)

    // 实际数据值域范围（用于数据纹理归一化，至少覆盖色标范围）
    const dataRange = this._computeDataRange(options.gridData)
    this.dataMin = dataRange.min
    this.dataMax = dataRange.max

    // 过滤范围默认覆盖色标全域
    this.filterMin = options.filterMin ?? this.colorMin
    this.filterMax = options.filterMax ?? this.colorMax

    // 显示方式
    this.displayMode = options.displayMode ?? 'smooth'
    this.contourLineColor = options.contourLineColor ?? [30, 30, 30, 200]
    this.contourLineWidth = options.contourLineWidth ?? 1.5
    this.contourLevelsUniform = buildContourLevelsUniform(this.colorStops)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Mapbox CustomLayerInterface 生命周期方法
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * onAdd — 由 Mapbox 在 map.addLayer() 时自动调用。
   *
   * 在这里完成所有 WebGL 初始化工作：
   *   1. 编译着色器、链接 Program
   *   2. 查找并缓存 attribute/uniform 位置
   *   3. 创建顶点缓冲（只有 4 个顶点！）
   *   4. 创建数据纹理和色带纹理
   *   5. 注册交互事件
   *
   * @param map — Mapbox Map 实例
   * @param gl  — WebGL 渲染上下文（由 Mapbox 提供，与地图共享）
   */
  onAdd(map: mapboxgl.Map, gl: WebGLRenderingContext): void {
    this.map = map
    this.gl = gl

    // ─── 1. 编译着色器并链接 Program ─────────────────────
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE)
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE)
    this.program = createProgram(gl, vs, fs)

    // 着色器对象链接后可安全删除（GPU 已持有副本）
    gl.deleteShader(vs)
    gl.deleteShader(fs)

    // ─── 2. 缓存 Attribute 和 Uniform 位置 ──────────────
    // getAttribLocation 返回 attribute 变量在 Program 中的索引号
    // getUniformLocation 返回 uniform 变量的引用
    const prog = this.program
    this.loc.aPosition = gl.getAttribLocation(prog, 'a_position')
    this.loc.aTexCoord = gl.getAttribLocation(prog, 'a_texCoord')
    this.loc.uMatrix = gl.getUniformLocation(prog, 'u_matrix')
    this.loc.uDataTexture = gl.getUniformLocation(prog, 'u_dataTexture')
    this.loc.uColorRamp = gl.getUniformLocation(prog, 'u_colorRamp')
    this.loc.uFilterMin = gl.getUniformLocation(prog, 'u_filterMin')
    this.loc.uFilterMax = gl.getUniformLocation(prog, 'u_filterMax')
    this.loc.uDataMin = gl.getUniformLocation(prog, 'u_dataMin')
    this.loc.uDataMax = gl.getUniformLocation(prog, 'u_dataMax')
    this.loc.uColorMin = gl.getUniformLocation(prog, 'u_colorMin')
    this.loc.uColorMax = gl.getUniformLocation(prog, 'u_colorMax')
    this.loc.uOpacity = gl.getUniformLocation(prog, 'u_opacity')
    this.loc.uDisplayMode = gl.getUniformLocation(prog, 'u_displayMode')
    this.loc.uContourLevels = gl.getUniformLocation(prog, 'u_contourLevels')
    this.loc.uContourCount = gl.getUniformLocation(prog, 'u_contourCount')
    this.loc.uTexelSize = gl.getUniformLocation(prog, 'u_texelSize')
    this.loc.uContourLineColor = gl.getUniformLocation(prog, 'u_contourLineColor')
    this.loc.uContourLineWidth = gl.getUniformLocation(prog, 'u_contourLineWidth')

    // ─── 3. 创建顶点缓冲 ────────────────────────────────
    this._buildQuadBuffers(gl)

    // ─── 4. 创建并上传纹理 ──────────────────────────────
    this._createDataTexture(gl)
    this._createColorRampTexture(gl)

    // ─── 5. 注册交互事件 ────────────────────────────────
    this._registerMapEvents()
  }

  /**
   * render — 每帧由 Mapbox 调用（地图移动/缩放/重绘时）。
   *
   * 绘制流程：
   *   1. 激活着色器 Program
   *   2. 关闭深度测试（2D 图层优化）
   *   3. 设置 Uniform 变量（矩阵、过滤参数、纹理单元等）
   *   4. 绑定纹理到对应纹理单元
   *   5. 绑定顶点缓冲并配置 attribute 指针
   *   6. 启用 Alpha 混合
   *   7. 执行 drawElements 绘制
   *
   * @param gl     — WebGL 上下文
   * @param matrix — Mapbox 提供的 4×4 MVP 矩阵（列主序 Float32Array）
   */
  render(gl: WebGLRenderingContext, matrix: number[]): void {
    if (!this.program) return

    const { loc } = this

    // ─── 1. 激活着色器 ───────────────────────────────────
    gl.useProgram(this.program)

    // ─── 2. 关闭深度测试 ─────────────────────────────────
    // 2D 图层不需要深度比较，关闭可减少 GPU 管线开销
    gl.disable(gl.DEPTH_TEST)

    // ─── 3. 设置 Uniform 变量 ────────────────────────────
    // MVP 矩阵
    gl.uniformMatrix4fv(loc.uMatrix, false, matrix)
    // 过滤范围（原始数据值单位）
    gl.uniform1f(loc.uFilterMin, this.filterMin)
    gl.uniform1f(loc.uFilterMax, this.filterMax)
    // 实际数据值域（用于着色器中反算真实值）
    gl.uniform1f(loc.uDataMin, this.dataMin)
    gl.uniform1f(loc.uDataMax, this.dataMax)
    // 色标值域（用于色带纹理颜色映射）
    gl.uniform1f(loc.uColorMin, this.colorMin)
    gl.uniform1f(loc.uColorMax, this.colorMax)
    // 全局透明度
    gl.uniform1f(loc.uOpacity, this.opacity)

    // 显示方式与等值线参数
    gl.uniform1f(loc.uDisplayMode, displayModeToUniform(this.displayMode))
    gl.uniform1fv(loc.uContourLevels, this.contourLevelsUniform)
    gl.uniform1f(loc.uContourCount, this.colorStops.length)
    const { cols, rows } = this.gridData
    gl.uniform2f(loc.uTexelSize, 1 / cols, 1 / rows)
    const [lr, lg, lb, la] = this.contourLineColor
    gl.uniform4f(loc.uContourLineColor, lr / 255, lg / 255, lb / 255, la / 255)
    gl.uniform1f(loc.uContourLineWidth, this.contourLineWidth)

    // ─── 4. 绑定纹理 ────────────────────────────────────
    // WebGL 纹理单元机制：
    //   activeTexture(TEXTURE0) → 选择 0 号纹理单元
    //   bindTexture(target, tex) → 将纹理对象绑定到当前活跃的纹理单元
    //   uniform1i(sampler, 0)    → 告诉着色器的 sampler2D 从 0 号纹理单元采样
    //
    // 数据纹理 → 纹理单元 0
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.dataTexture)
    gl.uniform1i(loc.uDataTexture, 0)            // sampler 使用 TEXTURE0

    // 色带纹理 → 纹理单元 1
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.colorRampTexture)
    gl.uniform1i(loc.uColorRamp, 1)              // sampler 使用 TEXTURE1

    // ─── 5. 绑定顶点缓冲 ────────────────────────────────
    // a_position — 四个角的 Mercator 坐标 (x, y)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer)
    gl.enableVertexAttribArray(loc.aPosition)
    gl.vertexAttribPointer(
      loc.aPosition,
      2,          // 每个顶点 2 个分量 (x, y)
      gl.FLOAT,   // 数据类型 Float32
      false,      // 不归一化（已经是 float）
      0,          // stride = 0 表示紧密排列
      0           // offset = 0 从头开始
    )

    // a_texCoord — 纹理坐标 (u, v)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer)
    gl.enableVertexAttribArray(loc.aTexCoord)
    gl.vertexAttribPointer(loc.aTexCoord, 2, gl.FLOAT, false, 0, 0)

    // ─── 6. 启用 Alpha 混合 ─────────────────────────────
    // 混合公式：output = src.rgb * src.a + dst.rgb * (1 - src.a)
    // 使透明区域可以看到下方的地图图层
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    // ─── 7. 绘制 ────────────────────────────────────────
    // 只绘制 2 个三角形（6 个索引），极度轻量！
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0)
  }

  /**
   * onRemove — 由 Mapbox 在 map.removeLayer() 时自动调用。
   * 必须释放所有 GPU 资源，否则会造成 GPU 内存泄漏。
   */
  onRemove(_map: mapboxgl.Map, gl: WebGLRenderingContext): void {
    this._releaseGLResources(gl)
    this._unregisterMapEvents()
    this.map = null
    this.gl = null
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  公共 API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 设置数据值过滤范围。
   * 超出 [min, max] 的格点像素将被着色器 discard。
   */
  setFilter(min: number, max: number): void {
    this.filterMin = min
    this.filterMax = max
    this.map?.triggerRepaint()
  }

  /** 获取当前过滤范围 */
  getFilter(): { min: number; max: number } {
    return { min: this.filterMin, max: this.filterMax }
  }

  /**
   * 动态修改全局透明度。
   * @param opacity — [0, 1]
   */
  setOpacity(opacity: number): void {
    this.opacity = Math.max(0, Math.min(1, opacity))
    this.map?.triggerRepaint()
  }

  /**
   * 设置显示方式。
   * @param mode — smooth | filled | lines | filled+lines
   */
  setDisplayMode(mode: GridDisplayMode): void {
    this.displayMode = mode
    this.map?.triggerRepaint()
  }

  /** 获取当前显示方式 */
  getDisplayMode(): GridDisplayMode {
    return this.displayMode
  }

  /**
   * 设置等值线样式。
   */
  setContourLineStyle(options: {
    color?: [number, number, number, number]
    width?: number
  }): void {
    if (options.color) this.contourLineColor = options.color
    if (options.width !== undefined) this.contourLineWidth = options.width
    this.map?.triggerRepaint()
  }

  /**
   * 动态更新色标数组。
   *
   * 会重建色带纹理并刷新 colorMin/colorMax 范围。
   * 由于数据纹理的归一化基准依赖色标范围（_computeDataRange 会扩展到覆盖色标），
   * 所以也会重建数据纹理以确保归一化基准一致。
   *
   * 性能开销：重新生成 256 像素色带 + 重新归一化数据纹理，仍然非常快。
   *
   * @param colorStops — 新的色标数组（至少 2 个节点）
   */
  updateColorStops(colorStops: ColorStop[]): void {
    this.colorStops = [...colorStops].sort((a, b) => a.value - b.value)
    this.contourLevelsUniform = buildContourLevelsUniform(this.colorStops)

    const stopValues = this.colorStops.map((s) => s.value)
    this.colorMin = Math.min(...stopValues)
    this.colorMax = Math.max(...stopValues)

    // 色标范围变化后，_computeDataRange 结果可能改变（因为会扩展到覆盖色标）
    const dataRange = this._computeDataRange(this.gridData)
    this.dataMin = dataRange.min
    this.dataMax = dataRange.max

    if (this.gl) {
      // 重建色带纹理
      this._createColorRampTexture(this.gl)
      // 数据归一化基准可能变化，需要重建数据纹理
      this._createDataTexture(this.gl)
    }

    this.map?.triggerRepaint()
  }

  /**
   * 🔑 核心优化：使用 texSubImage2D 增量更新数据纹理。
   *
   * texSubImage2D vs texImage2D：
   *   texImage2D    — 重新分配纹理内存 + 上传数据（开销大）
   *   texSubImage2D — 直接修改已有纹理的像素数据（无需重新分配内存，开销小）
   *
   * 适用场景：时间序列动画、实时数据推送
   *   比如每秒更新一帧温度数据，只需调用 updateData()，
   *   GPU 纹理内存不会反复分配释放。
   *
   * @param newData — 新格点数据（行列数必须 与原始数据一致）
   */
  updateData(newData: GridData): void {
    if (!this.gl || !this.dataTexture) {
      this.gridData = newData
      return
    }
    const gl = this.gl

    // 先比较行列尺寸和地理范围是否变化（必须在赋值之前比较！）
    const sizeChanged =
      newData.rows !== this.gridData.rows || newData.cols !== this.gridData.cols
    const extentChanged =
      newData.lonStart !== this.gridData.lonStart ||
      newData.latStart !== this.gridData.latStart ||
      newData.lonStep !== this.gridData.lonStep ||
      newData.latStep !== this.gridData.latStep

    // 更新引用
    this.gridData = newData

    // 重新计算实际数据值域范围
    const dataRange = this._computeDataRange(newData)
    this.dataMin = dataRange.min
    this.dataMax = dataRange.max

    // 如果新数据的行列数与原来不同，需要重建纹理
    // （texSubImage2D 不能改变纹理尺寸）
    if (sizeChanged) {
      this._createDataTexture(gl)
      this._buildQuadBuffers(gl)
    } else {
      // 地理范围变化时需要重建四边形顶点（Mercator 坐标变了）
      if (extentChanged) {
        this._buildQuadBuffers(gl)
      }
      // 行列数相同：使用 texSubImage2D 增量更新（高效！）
      const pixels = flattenAndNormalize(
        newData.values,
        newData.rows,
        newData.cols,
        this.dataMin,
        this.dataMax
      )

      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.bindTexture(gl.TEXTURE_2D, this.dataTexture)
      // texSubImage2D 参数说明：
      //   target     — gl.TEXTURE_2D
      //   level      — Mipmap 层级，0 = 基础层
      //   xoffset    — 从第 0 列开始写
      //   yoffset    — 从第 0 行开始写
      //   width      — 写入宽度 = cols
      //   height     — 写入高度 = rows
      //   format     — 纹理格式 LUMINANCE（单通道灰度）
      //   type       — 数据类型 UNSIGNED_BYTE
      //   pixels     — 像素数据
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,                    // mipmap level 0
        0, 0,                 // x, y offset
        newData.cols,         // width
        newData.rows,         // height
        gl.LUMINANCE,         // 单通道格式
        gl.UNSIGNED_BYTE,     // 8 位无符号整数
        pixels
      )
      // 恢复 WebGL 默认状态
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    }

    this.map?.triggerRepaint()
  }

  /**
   * 注册事件监听器。
   * @param type    — 事件类型（如 'click'）
   * @param handler — 回调函数
   */
  on<K extends keyof GridLayer2EventMap>(
    type: K,
    handler: (data: GridLayer2EventMap[K]) => void
  ): void {
    if (!this.eventHandlers[type]) {
      this.eventHandlers[type] = []
    }
    this.eventHandlers[type]!.push(handler)
  }

  /**
   * 移除事件监听器。
   * @param type    — 事件类型
   * @param handler — 要移除的回调函数引用
   */
  off<K extends keyof GridLayer2EventMap>(
    type: K,
    handler: (data: GridLayer2EventMap[K]) => void
  ): void {
    const handlers = this.eventHandlers[type]
    if (handlers) {
      const idx = handlers.indexOf(handler)
      if (idx >= 0) handlers.splice(idx, 1)
    }
  }

  /**
   * 触发事件（内部使用）。
   */
  private emit<K extends keyof GridLayer2EventMap>(type: K, data: GridLayer2EventMap[K]): void {
    const handlers = this.eventHandlers[type]
    if (handlers) {
      handlers.forEach((h) => h(data))
    }
  }

  /**
   * 获取格点数据的地理范围。
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  私有方法 — 顶点缓冲
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 构建覆盖格点范围的矩形顶点缓冲（仅 4 个顶点 + 6 个索引）。
   *
   * 与 V1 的巨大差异：
   *   V1: (rows+1)*(cols+1) 个顶点 + rows*cols*6 个索引
   *       → 100×200 的网格 = 20301 顶点 + 120000 索引
   *   V2: 4 个顶点 + 6 个索引（恒定！）
   *
   * 矩形四个角的顺序和纹理坐标映射：
   *
   *   顶点 2 (左上)────── 顶点 3 (右上)
   *      │                    │
   *      │     纹理映射       │
   *      │   UV: (0,0)→(1,0) │
   *      │        ↓           │
   *      │   UV: (0,1)→(1,1) │
   *      │                    │
   *   顶点 0 (左下)────── 顶点 1 (右下)
   *
   * 注意纹理坐标 v 方向：
   *   纹理的 v=0 对应纹理图像的顶部（数组第 0 行）
   *   但地理上第 0 行在底部（latStart），所以需要翻转
   */
  private _buildQuadBuffers(gl: WebGLRenderingContext): void {
    const { lonStart, latStart, lonStep, latStep, rows, cols } = this.gridData

    // 格点范围的四个角经纬度
    const lonMin = lonStart
    const lonMax = lonStart + cols * lonStep
    const latMin = latStart
    const latMax = latStart + rows * latStep

    // 转换为 Mercator 坐标
    const [x0, y0] = lngLatToMercator(lonMin, latMin) // 左下
    const [x1, y1] = lngLatToMercator(lonMax, latMin) // 右下
    const [x2, y2] = lngLatToMercator(lonMin, latMax) // 左上
    const [x3, y3] = lngLatToMercator(lonMax, latMax) // 右上

    // ── 顶点坐标缓冲 (4 个顶点，每个 2 个 float) ──
    // 顺序：左下 → 右下 → 左上 → 右上
    const positions = new Float32Array([
      x0, y0,  // 顶点 0: 左下
      x1, y1,  // 顶点 1: 右下
      x2, y2,  // 顶点 2: 左上
      x3, y3   // 顶点 3: 右上
    ])

    // ── 纹理坐标缓冲 (4 个顶点，每个 2 个 float) ──
    // 纹理 v=0 是图像顶部 = 数据最后一行(最高纬度)
    // 纹理 v=1 是图像底部 = 数据第一行(最低纬度)
    // 所以左下顶点(最低纬度) → v=1，左上顶点(最高纬度) → v=0
    const texCoords = new Float32Array([
      0.0, 1.0,  // 顶点 0 (左下): u=0, v=1（纹理底部 = 低纬度）
      1.0, 1.0,  // 顶点 1 (右下): u=1, v=1
      0.0, 0.0,  // 顶点 2 (左上): u=0, v=0（纹理顶部 = 高纬度）
      1.0, 0.0   // 顶点 3 (右上): u=1, v=0
    ])

    // ── 索引缓冲 (2 个三角形，共 6 个索引) ──
    // 三角形 1: 顶点 0, 1, 2（左下三角）
    // 三角形 2: 顶点 2, 1, 3（右上三角）
    const indices = new Uint16Array([
      0, 1, 2,   // 三角形 1
      2, 1, 3    // 三角形 2
    ])

    // ── 上传到 GPU ──
    this.positionBuffer = this._uploadBuffer(gl, this.positionBuffer, positions, gl.ARRAY_BUFFER)
    this.texCoordBuffer = this._uploadBuffer(gl, this.texCoordBuffer, texCoords, gl.ARRAY_BUFFER)
    this.indexBuffer = this._uploadBuffer(gl, this.indexBuffer, indices, gl.ELEMENT_ARRAY_BUFFER)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  私有方法 — 纹理创建与更新
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 创建数据纹理：将格点数据存入 GPU 纹理。
   *
   * 纹理格式选择：LUMINANCE + UNSIGNED_BYTE
   *   - LUMINANCE：单通道灰度纹理，采样结果 = (L, L, L, 1.0)
   *     我们只用 .r 通道读取值
   *   - UNSIGNED_BYTE：8 位精度，范围 [0, 255] → 归一化后 [0.0, 1.0]
   *     精度 ≈ 1/255 ≈ 0.004，对温度等场景完全够用
   *
   * 为什么不用 FLOAT 纹理？
   *   - 需要 OES_texture_float 扩展，并非所有设备支持
   *   - UNSIGNED_BYTE 兼容性最好，性能也更优
   *   - 如果需要更高精度，可以使用 RG 两通道拼接 16 位
   *
   * 纹理参数设置：
   *   - CLAMP_TO_EDGE：超出 [0,1] 范围时使用边缘像素值
   *   - LINEAR：双线性插值（让格点之间过渡平滑）
   *   - 也可以改为 NEAREST 获得棋盘格效果
   */
  private _createDataTexture(gl: WebGLRenderingContext): void {
    const { rows, cols, values } = this.gridData

    // 展平并归一化数据
    const pixels = flattenAndNormalize(values, rows, cols, this.dataMin, this.dataMax)

    // 创建或复用纹理对象
    if (!this.dataTexture) {
      this.dataTexture = gl.createTexture()
    }

    gl.bindTexture(gl.TEXTURE_2D, this.dataTexture)

    // ── 设置纹理参数 ──
    // TEXTURE_WRAP_S / T：纹理坐标超出 [0,1] 时的处理方式
    //   CLAMP_TO_EDGE = 使用边缘像素颜色（不重复平铺）
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    // TEXTURE_MIN_FILTER / MAG_FILTER：缩放时的插值方式
    //   LINEAR = 双线性插值（相邻 4 个像素加权平均）
    //   这使得格点之间的颜色过渡更加平滑
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

    // ── 设置像素存储参数 ──
    // UNPACK_FLIP_Y_WEBGL：翻转纹理 Y 轴，使数据行序与 UV 纹理坐标正确对应
    // 翻转后：数据第 0 行(低纬) → 纹理顶部(v=0)
    //   左下顶点(低纬度, v=1) 采样纹理底部 → 翻转后的最后行 → 原数据第 0 行(低纬) ✓
    //   左上顶点(高纬度, v=0) 采样纹理顶部 → 翻转后的第 0 行 → 原数据最后行(高纬) ✓
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)
    // WebGL 默认行对齐为 4 字节，但 LUMINANCE 每行字节数 = cols
    // 如果 cols 不是 4 的倍数，会读取到错误的像素
    // 设为 1 表示逐字节对齐，避免此问题
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)

    // ── 上传纹理数据 ──
    // texImage2D 参数说明：
    //   target         — gl.TEXTURE_2D
    //   level          — Mipmap 层级，0 = 基础层（我们不使用 mipmap）
    //   internalFormat — GPU 内部存储格式（LUMINANCE = 单通道）
    //   width, height  — 纹理尺寸（= 格点列数 × 行数）
    //   border         — 必须为 0（WebGL 规范要求）
    //   format         — 输入数据格式（和 internalFormat 匹配）
    //   type           — 输入数据类型
    //   pixels         — 像素数据
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,                    // level
      gl.LUMINANCE,         // 内部格式：单通道
      cols,                 // 宽度 = 列数
      rows,                 // 高度 = 行数
      0,                    // 边框（必须为 0）
      gl.LUMINANCE,         // 输入格式
      gl.UNSIGNED_BYTE,     // 数据类型
      pixels                // 像素数据
    )
    // 恢复 WebGL 默认状态，避免影响 Mapbox 内部纹理操作
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
  }

  /**
   * 创建色带纹理：256×1 的 RGBA 纹理，用于 value → color 查找。
   *
   * 色带纹理的工作原理：
   *   将色标数组预渲染为一条 256 像素长的水平彩色条带
   *   着色器中只需一次纹理采样 texture2D(colorRamp, vec2(t, 0.5))
   *   即可将归一化值 t 映射为颜色
   *
   * 为什么高度为 1？
   *   因为这是一维查找表，只有 u 坐标有意义，v 始终为 0.5
   */
  private _createColorRampTexture(gl: WebGLRenderingContext): void {
    const pixels = buildColorRampPixels(this.colorStops)

    if (!this.colorRampTexture) {
      this.colorRampTexture = gl.createTexture()
    }

    gl.bindTexture(gl.TEXTURE_2D, this.colorRampTexture)

    // 色带纹理使用 LINEAR 插值，使颜色过渡平滑
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

    // ── 上传色带像素 ──
    // gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4) // RGBA 每行 256×4=1024 字节，4 字节对齐
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,                    // level
      gl.RGBA,              // 内部格式
      COLOR_RAMP_WIDTH,     // 宽度 = 256
      1,                    // 高度 = 1
      0,                    // 边框
      gl.RGBA,              // 输入格式
      gl.UNSIGNED_BYTE,     // 数据类型
      pixels                // 像素数据
    )
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  私有方法 — 缓冲区工具
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 将 TypedArray 上传到 GPU 缓冲区（复用已有缓冲或新建）。
   */
  private _uploadBuffer(
    gl: WebGLRenderingContext,
    buf: WebGLBuffer | null,
    data: BufferSource,
    target: number
  ): WebGLBuffer {
    const buffer = buf ?? gl.createBuffer()!
    gl.bindBuffer(target, buffer)
    gl.bufferData(target, data, gl.STATIC_DRAW)
    return buffer
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  私有方法 — 地图交互事件
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 注册地图点击和鼠标移动事件。
   * - click：回调格点信息
   * - mousemove：在数据范围内显示 pointer 指针
   */
  private _registerMapEvents(): void {
    if (!this.map) return
    const map = this.map

    const handleClick = (e: mapboxgl.MapMouseEvent) => {
      const info = this._hitTest(e.lngLat.lng, e.lngLat.lat)
      if (info) {
        this.emit('click', info)
      }
    }

    const handleMousemove = (e: mapboxgl.MapMouseEvent) => {
      const inside = this._isInsideBounds(e.lngLat.lng, e.lngLat.lat)
      map.getCanvas().style.cursor = inside ? 'pointer' : ''
    }

    map.on('click', handleClick)
    map.on('mousemove', handleMousemove)

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
   * 点击命中检测：经纬度 → 格点行列索引。
   */
  private _hitTest(lng: number, lat: number): GridClickInfo | null {
    const { lonStart, latStart, lonStep, latStep, rows, cols, values } = this.gridData
    if (!this._isInsideBounds(lng, lat)) return null

    const col = Math.floor((lng - lonStart) / lonStep)
    const row = Math.floor((lat - latStart) / latStep)
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

  /** 判断坐标是否在格点数据地理范围内 */
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
   * 计算格点数据的实际值域范围。
   *
   * 算法说明：
   *   使用 Infinity / -Infinity 作为初始值是求最小/最大值的标准模式：
   *   - min 初始为 Infinity  → 任何有效数字都 < Infinity，第一个值就会成为新 min
   *   - max 初始为 -Infinity → 任何有效数字都 > -Infinity，第一个值就会成为新 max
   *   - 遍历结束后，若 min 仍为 Infinity，说明没有找到任何有效数据
   *
   * 返回值说明：
   *   返回的范围至少覆盖色标范围 [colorMin, colorMax]。
   *   这样做的考量：
   *   - 确保数据纹理的归一化基准足够宽，色标范围内的所有值都可以被正确映射
   *   - 当数据范围窄于色标时（如数据 [5,35] vs 色标 [0,40]），
   *     扩展后的基准确保色带中间部分的颜色不会被压缩变形
   *   - 当数据范围宽于色标时（如数据 [-10,50] vs 色标 [0,40]），
   *     超出色标的值仍能被精确归一化，支持 filter 正确过滤
   */
  private _computeDataRange(data: GridData): { min: number; max: number } {
    let min = Infinity      // 初始为正无穷大，任何实际值都会更小
    let max = -Infinity     // 初始为负无穷大，任何实际值都会更大
    for (let row = 0; row < data.rows; row++) {
      const rowData = data.values[row]
      if (!rowData) continue
      for (let col = 0; col < data.cols; col++) {
        const val = rowData[col]
        if (val !== undefined) {
          if (val < min) min = val
          if (val > max) max = val
        }
      }
    }
    // 如果遍历后 min/max 仍为初始值，说明数据全为空或 undefined，
    // 回退使用色标范围以确保着色器不会因除零而崩溃
    if (min === Infinity || max === -Infinity) {
      return { min: this.colorMin, max: this.colorMax }
    }
    // 扩展范围以至少覆盖色标值域，
    // 确保色带纹理的整个色彩范围都能被正确映射
    return {
      min: Math.min(min, this.colorMin),
      max: Math.max(max, this.colorMax)
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  私有方法 — 资源释放
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 释放所有 GPU 资源。
   *
   * WebGL 资源生命周期管理：
   *   WebGL 资源（Buffer、Texture、Program）分配在 GPU 显存中，
   *   JavaScript GC 无法自动回收它们。
   *   必须手动调用 deleteXxx() 释放，否则会造成 GPU 内存泄漏。
   *
   * 释放顺序不重要，但要确保：
   *   1. 释放后将引用置为 null（避免多次释放或悬垂引用）
   *   2. 不在释放后再尝试渲染
   */
  private _releaseGLResources(gl: WebGLRenderingContext): void {
    // 释放着色器程序
    if (this.program) {
      gl.deleteProgram(this.program)
      this.program = null
    }
    // 释放顶点缓冲
    if (this.positionBuffer) {
      gl.deleteBuffer(this.positionBuffer)
      this.positionBuffer = null
    }
    if (this.texCoordBuffer) {
      gl.deleteBuffer(this.texCoordBuffer)
      this.texCoordBuffer = null
    }
    if (this.indexBuffer) {
      gl.deleteBuffer(this.indexBuffer)
      this.indexBuffer = null
    }
    // 释放纹理
    if (this.dataTexture) {
      gl.deleteTexture(this.dataTexture)
      this.dataTexture = null
    }
    if (this.colorRampTexture) {
      gl.deleteTexture(this.colorRampTexture)
      this.colorRampTexture = null
    }
  }
}
