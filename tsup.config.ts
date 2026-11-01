/**
 * tsup 打包配置 —— 把 TypeScript 源码编译成 DSH 能直接 `import()` 的纯 JavaScript。
 *
 * 为什么是 CommonJS？
 *   DSH 的 Cordis loader 用 `unwrapExports()` 归一化模块形状：
 *     exports = exports.default ?? exports;  if (exports.__esModule) return exports.default ?? exports;
 *   所以 CJS 打包产物（module.exports = { name, inject, apply }）会被正确地
 *   当成插件对象；官方 ESM 写法同样可行，这里按 CJS 交付。
 *
 * 为什么 external 掉 better-sqlite3？
 *   它是 Node 原生模块（.node 二进制），打进 bundle 必然坏；必须由宿主按 ABI
 *   在运行时用 require() 解析。
 */
import { defineConfig } from 'tsup';

export default defineConfig({
  // 两个入口：
  //   lib/index.js                           ← 插件本体（DSH 通过 package.json main 加载）
  //   lib/adapters/agent/DshAdapter.js       ← 薄适配层单独可 require，便于二次开发
  entry: {
    index: 'src/index.ts',
    'adapters/agent/DshAdapter': 'src/adapters/agent/DshAdapter.ts',
    'cli/cli': 'src/cli/cli.ts',
  },
  outDir: 'lib',

  format: ['cjs'],
  target: 'node20',
  platform: 'node',

  // 每个入口一份自包含产物：插件被 link: 安装时不需要宿主再解析内部 import
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  minify: false,

  /**
   * 原生模块与宿主内置模块一律 external。
   * better-sqlite3 若被 esbuild 内联，.node 绑定会直接失效。
   */
  external: ['better-sqlite3', 'node:sqlite'],

  /**
   * 源码里有一处 `createRequire(import.meta.url)`（MemoryEngine 延迟加载
   * better-sqlite3）。CJS 产物没有 import.meta，用 esbuild 的 define 把它
   * 换成由 banner 定义的常量，运行时等价。
   */
  define: {
    'import.meta.url': 'APM_IMPORT_META_URL',
  },
  banner: {
    js: "const APM_IMPORT_META_URL = require('node:url').pathToFileURL(__filename).href;",
  },

  /**
   * 保留 UTF-8 原文，不要把中文转成 \uXXXX。
   * 产物更小、可读，也方便发布后直接 grep 提示词。
   */
  esbuildOptions(options) {
    options.charset = 'utf8';
  },
});
