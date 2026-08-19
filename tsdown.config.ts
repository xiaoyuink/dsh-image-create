import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    outDir: 'lib',
    clean: true,
    format: 'esm',
    // 扩展名跟随 package type（type: module → .js），与 package.json 的
    // main/exports（lib/index.js）保持一致；不设 fixedExtension 时默认 .mjs。
    fixedExtension: false,
  },
  {
    entry: ['src/client/index.ts'],
    outDir: 'lib/client',
    format: 'cjs',
    fixedExtension: false,
    external: [
      /@deepseek-ai\/dsh-client-/,
      /@deepseek-ai\/dsh-client-ui-/,
      /@deepseek-ai\/dsh-client-locale/,
      /^react$/,
      /^react\/jsx-runtime$/,
      /^react\/jsx-dev-runtime$/,
      /^react-dom$/,
      /^react-dom\/client$/,
    ],
    // DSH 的 client 模块系统要求每个插件 bundle 通过
    // window.__ModuleLoader__.load({ id, factory }) 自注册（CJS factory 形态）。
    // cjs 格式 + banner/footer 把产物包裹成官方插件同款结构。
    banner: 'window.__ModuleLoader__.load({ id: "@xiaoyuink/dsh-image-create", factory: (require) => { var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    footer: ' return module.exports; } });',
  },
])
