/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAPBOX_ACCESS_TOKEN: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.glb?url' {
  const src: string
  export default src
}

declare module '*.png?url' {
  const src: string
  export default src
}

declare module '*.svg?url' {
  const src: string
  export default src
}
