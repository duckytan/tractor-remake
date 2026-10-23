/// <reference types="vite/client" />

/**
 * 构建时内联的应用版本号。
 * 由 `vite.config.ts` / `vitest.config.ts` 的 `define` 从 `package.json` 的 `version` 注入，
 * 单一来源是 package.json，运行期不读文件、零依赖。
 */
declare const __APP_VERSION__: string
