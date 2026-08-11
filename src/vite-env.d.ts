/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ONRAMPER_API_KEY?: string
  readonly VITE_ONRAMPER_SIGN_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
