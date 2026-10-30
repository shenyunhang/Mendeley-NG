/** Title comparison shared by metadata lookup and duplicate detection. */

export const norm = (s: string) =>
  (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Similarity in 0..1, based on the longest common subsequence like
 *  difflib's ratio.  It degrades more gracefully than plain Levenshtein when
 *  one version of a title has a subtitle appended. */
export function ratio(a: string, b: string): number {
  const A = norm(a)
  const B = norm(b)
  if (!A || !B) return 0
  if (A === B) return 1
  const n = A.length
  const m = B.length
  // rolling row of the LCS table; titles are short so O(n*m) is fine
  let prev = new Array<number>(m + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    const cur = new Array<number>(m + 1).fill(0)
    for (let j = 1; j <= m; j++) {
      cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    prev = cur
  }
  return (2 * prev[m]) / (n + m)
}

/** Anything below this is not the same paper.  See the note in lookup.ts:
 *  0.72 was tried and produced matches like "Object detection" against
 *  "Lifelong Object Detection" at 0.78. */
const THRESHOLD = 0.9

/** Substring containment is only trusted on long titles; two short titles
 *  that contain each other are usually different papers. */
const CONTAINS_MIN_LEN = 40

export function acceptable(title: string, cand: string): boolean {
  const r = ratio(title, cand)
  if (r >= THRESHOLD) return true
  const A = norm(title)
  const B = norm(cand)
  if (A.length < CONTAINS_MIN_LEN || B.length < CONTAINS_MIN_LEN) return false
  return (A.includes(B) || B.includes(A)) && r >= 0.75
}
