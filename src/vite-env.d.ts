/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ONRAMP_APP_ID?: string
  readonly VITE_ONRAMP_SANDBOX?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
