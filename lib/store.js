/**
 * JSONL 存储：追加、读尾部 N 条、原子写。
 *
 * 设计约束：
 *  - **只依赖 `node:` 内置模块**；
 *  - 所有函数对「文件不存在」返回空结果而不是抛错；
 *  - 所有写操作走「临时文件 + rename」保证原子性，避免进程被杀时留下半行；
 *  - 单行解析失败只跳过该行（容忍手工编辑/断电截断）。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** 读尾部时的默认字节上限，防止超大文件把内存打满。 */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/**
 * 递归创建目录。
 * @param {string} dir
 */
export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

/**
 * 追加一条 JSON 记录（单行）。
 * @param {string} file
 * @param {unknown} record
 */
export async function appendJsonl(file, record) {
  await ensureDir(path.dirname(file))
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
}

/**
 * 读取 JSONL 文件的尾部内容（最多 maxBytes 字节）。
 * @param {string} file
 * @param {number} [maxBytes]
 * @returns {Promise<string>} 文件不存在时返回空串。
 */
export async function readTextTail(file, maxBytes = DEFAULT_MAX_BYTES) {
  let stat
  try {
    stat = await fs.stat(file)
  } catch {
    return ''
  }
  if (!stat.isFile() || stat.size === 0) return ''

  if (stat.size <= maxBytes) {
    try {
      return await fs.readFile(file, 'utf8')
    } catch {
      return ''
    }
  }

  const handle = await fs.open(file, 'r')
  try {
    const length = Math.min(maxBytes, stat.size)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, stat.size - length)
    const text = buffer.toString('utf8')
    const firstBreak = text.indexOf('\n')
    // 从中间截断时丢掉不完整的首行。
    return firstBreak === -1 ? '' : text.slice(firstBreak + 1)
  } finally {
    await handle.close()
  }
}

/**
 * 读取 JSONL 记录。
 * @param {string} file
 * @param {{ limit?: number, maxBytes?: number }} [options] `limit > 0` 时只返回最后 N 条。
 * @returns {Promise<Array<object>>}
 */
export async function readJsonl(file, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 0
  const text = await readTextTail(file, Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES)
  if (text.length === 0) return []

  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') records.push(parsed)
    } catch {
      // 跳过损坏行：宁可少一条，也不要让整块能力失效。
    }
  }

  return limit > 0 && records.length > limit ? records.slice(records.length - limit) : records
}

/**
 * 原子写文件（同目录临时文件 + rename）。
 * @param {string} file
 * @param {string} text
 */
export async function writeTextAtomic(file, text) {
  await ensureDir(path.dirname(file))
  const temp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    await fs.writeFile(temp, text, 'utf8')
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * 原子写整份 JSONL。
 * @param {string} file
 * @param {ReadonlyArray<unknown>} records
 */
export async function writeJsonlAtomic(file, records) {
  const list = Array.isArray(records) ? records : []
  const text = list.map((record) => JSON.stringify(record)).join('\n')
  await writeTextAtomic(file, text.length > 0 ? `${text}\n` : '')
}

/**
 * 把 JSONL 裁剪到最多 maxRecords 条（保留最新的），原子写回。
 * @param {string} file
 * @param {number} maxRecords
 * @returns {Promise<{ before: number, after: number }>}
 */
export async function trimJsonl(file, maxRecords) {
  const limit = Number.isFinite(maxRecords) && maxRecords > 0 ? Math.floor(maxRecords) : 0
  const records = await readJsonl(file, { maxBytes: Number.MAX_SAFE_INTEGER })
  if (limit === 0 || records.length <= limit) return { before: records.length, after: records.length }
  const kept = records.slice(records.length - limit)
  await writeJsonlAtomic(file, kept)
  return { before: records.length, after: kept.length }
}

/**
 * 读取文本文件，不存在返回 undefined。
 * @param {string} file
 * @returns {Promise<string | undefined>}
 */
export async function readTextSafe(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 列出目录下的文件名（不存在返回空数组）。
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listDir(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * 删除文件，忽略不存在。
 * @param {string} file
 */
export async function removeFile(file) {
  try {
    await fs.rm(file, { force: true })
    return true
  } catch {
    return false
  }
}
