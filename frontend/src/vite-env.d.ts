/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly ROUTER_PANEL_BRIDGE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
