/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WS_URL: string
  readonly VITE_BUILD_VERSION?: string
  readonly VITE_BUILD_IDENTITY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
