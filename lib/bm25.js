/**
 * BM25 的对外入口。
 *
 * 纯函数实现放在 `lib/core/bm25.js`（基准测试直接 import 那份，不经过本文件）。
 * 这里只做 re-export，让插件代码从 `lib/` 顶层引用时路径更稳定。
 */

export {
  BM25_K1,
  BM25_B,
  tokenize,
  compareId,
  createIndex,
  scoreIndex,
  search,
  searchDocs,
} from './core/bm25.js'
