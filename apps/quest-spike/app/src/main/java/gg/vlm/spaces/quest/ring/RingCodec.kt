package gg.vlm.spaces.quest.ring

import java.security.MessageDigest

/** A decoded marker. [corrected] counts errors corrected plus erased symbols repaired. */
data class RingDecoded(val id: Long, val version: Int, val corrected: Int)

/** A registered test marker: [id] is an unsigned 32-bit value, [diameter] is in metres. */
data class RingTestMarker(val name: String, val id: Long, val diameter: Double)

val RING_TEST_MARKERS =
    listOf(
        RingTestMarker("RING120", 0x1D2C3B4AL, 0.120),
        RingTestMarker("RING140", 0x2E3D4C5BL, 0.140),
        RingTestMarker("RING170", 0x3F4E5D6CL, 0.170),
    )

/**
 * Ring marker codec: systematic RS(12,6) over GF(64) laid out on 3 staggered rings. A port of
 * apps/ring-marker/ringmarker/codec.py; apps/ring-marker/vectors/codec.json is the contract.
 *
 * Cell index = ring * 24 + cell; true means "on" (dark, raised). IDs are unsigned 32-bit values
 * held in a [Long].
 */
object RingCodec {
  const val CELLS = 72
  private const val PER_RING = 24
  private const val N = 12
  private const val K = 6
  private const val NSYM = 6
  private const val MAX_ERRORS = 2
  /**
   * 2 * errors + erasures may spend at most 4 of the 6 check symbols, so a wrong id needs at least
   * 3 symbol errors beyond what is corrected (the rest of the code spots damage).
   */
  private const val BUDGET = 4
  private val OFFSET = intArrayOf(0, 2, 4)
  private const val CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

  // --- GF(64), x^6 + x + 1 ---
  private val EXP = IntArray(126)
  private val LOG = IntArray(64)

  init {
    var x = 1
    for (i in 0 until 63) {
      EXP[i] = x
      LOG[x] = i
      x = x shl 1
      if (x and 64 != 0) x = x xor 0x43
    }
    for (i in 63 until 126) EXP[i] = EXP[i - 63]
  }

  private fun gmul(a: Int, b: Int): Int = if (a == 0 || b == 0) 0 else EXP[LOG[a] + LOG[b]]

  private fun ginv(a: Int): Int = EXP[63 - LOG[a]]

  private fun pmul(p: IntArray, q: IntArray): IntArray {
    val out = IntArray(p.size + q.size - 1)
    for (i in p.indices) for (j in q.indices) out[i + j] = out[i + j] xor gmul(p[i], q[j])
    return out
  }

  /** Evaluates a polynomial (low degree first) at [x]. */
  private fun peval(p: IntArray, x: Int): Int {
    var acc = 0
    for (i in p.indices.reversed()) acc = gmul(acc, x) xor p[i]
    return acc
  }

  /** Generator with roots alpha^0 .. alpha^5 (low degree first, monic). */
  private val GEN: IntArray =
      (0 until NSYM).fold(intArrayOf(1)) { g, j -> pmul(g, intArrayOf(EXP[j], 1)) }

  // --- layout and mask ---
  private val MASK: BooleanArray =
      MessageDigest.getInstance("SHA-256").digest("VLM ring marker v0".toByteArray(Charsets.US_ASCII))
          .let { d -> BooleanArray(CELLS) { i -> (d[i / 8].toInt() shr (7 - i % 8)) and 1 == 1 } }

  private val SYMBOL_CELLS: Array<IntArray> =
      Array(N) { j ->
        val ring = j / 4
        val start = ((j % 4) * 6 + OFFSET[ring]) % PER_RING
        IntArray(6) { b -> ring * PER_RING + (start + b) % PER_RING }
      }

  /** Systematic codeword: data symbols followed by 6 parity symbols. */
  private fun rsEncode(data: IntArray): IntArray {
    val rem = IntArray(NSYM) // rem[0] is the highest-degree remainder coefficient
    for (d in data) {
      val fb = d xor rem[0]
      for (i in 0 until NSYM - 1) rem[i] = rem[i + 1]
      rem[NSYM - 1] = 0
      if (fb != 0) for (i in 0 until NSYM) rem[i] = rem[i] xor gmul(fb, GEN[NSYM - 1 - i])
    }
    return data + rem
  }

  /** Encodes a 32-bit [id] and 4-bit [version] into 72 masked cells. */
  fun encode(id: Long, version: Int = 0): BooleanArray {
    require(id in 0 until (1L shl 32)) { "id must be 32-bit" }
    require(version in 0 until 16) { "version must be 4-bit" }
    val value = (version.toLong() shl 32) or id
    val data = IntArray(K) { i -> ((value shr (30 - 6 * i)) and 63).toInt() }
    val symbols = rsEncode(data)
    val cells = BooleanArray(CELLS)
    for (j in symbols.indices) {
      for (b in 0 until 6) cells[SYMBOL_CELLS[j][b]] = (symbols[j] shr (5 - b)) and 1 == 1
    }
    return BooleanArray(CELLS) { cells[it] != MASK[it] }
  }

  // --- decoding ---
  private fun berlekampMassey(s: IntArray): IntArray {
    var c = mutableListOf(1)
    var b = mutableListOf(1)
    var l = 0
    var m = 1
    var bb = 1
    for (n in s.indices) {
      var d = s[n]
      for (i in 1..l) if (i < c.size) d = d xor gmul(c[i], s[n - i])
      if (d == 0) {
        m++
        continue
      }
      val t = c.toList()
      val coef = gmul(d, ginv(bb))
      val shifted = List(m) { 0 } + b.map { gmul(coef, it) }
      while (c.size < shifted.size) c.add(0)
      for (i in shifted.indices) c[i] = c[i] xor shifted[i]
      if (2 * l <= n) {
        l = n + 1 - l
        b = t.toMutableList()
        bb = d
        m = 1
      } else {
        m++
      }
    }
    val out = IntArray(l + 1)
    for (i in 0..l) if (i < c.size) out[i] = c[i]
    return out
  }

  /**
   * Decodes 72 cells in transmitted order; null entries are erasures. Returns null unless the word
   * is a codeword within the correction budget (errors <= 2 and 2 * errors + erasures <= 4).
   */
  fun decode(cells: Array<Boolean?>): RingDecoded? {
    require(cells.size == CELLS) { "expected 72 cells" }
    val raw = Array(CELLS) { i -> cells[i]?.let { it != MASK[i] } }
    val recv = IntArray(N)
    val erased = mutableListOf<Int>()
    for (j in 0 until N) {
      var v = 0
      var gone = false
      for (c in SYMBOL_CELLS[j]) {
        val bit = raw[c]
        if (bit == null) {
          gone = true
          break
        }
        v = (v shl 1) or (if (bit) 1 else 0)
      }
      if (gone) erased.add(j) else recv[j] = v
    }
    val e = erased.size
    if (e > NSYM) return null
    val loc = IntArray(N) { j -> EXP[(N - 1 - j) % 63] } // X_j = alpha^(11-j)
    val syn =
        IntArray(NSYM) { t ->
          var acc = 0
          for (j in 0 until N) acc = acc xor gmul(recv[j], EXP[(t * (N - 1 - j)) % 63])
          acc
        }

    var gamma = intArrayOf(1)
    for (j in erased) gamma = pmul(gamma, intArrayOf(1, loc[j]))
    val product = pmul(syn, gamma)
    val mod = IntArray(NSYM) { if (it < product.size) product[it] else 0 }
    val sigma = berlekampMassey(mod.copyOfRange(e, NSYM))
    var nerr = sigma.size - 1
    while (nerr > 0 && sigma[nerr] == 0) nerr--
    if (sigma.size - 1 != nerr) return null // degree-deficient locator
    if (nerr > MAX_ERRORS) return null
    if (2 * nerr + e > BUDGET) return null
    val lam = pmul(gamma, sigma.copyOfRange(0, nerr + 1))
    val omega = pmul(syn, lam).let { p -> IntArray(NSYM) { if (it < p.size) p[it] else 0 } }
    val dlam = IntArray(lam.size - 1) { k -> if ((k + 1) % 2 == 1) lam[k + 1] else 0 }

    val fixed = recv.copyOf()
    var roots = 0
    for (j in 0 until N) {
      val xinv = ginv(loc[j])
      if (peval(lam, xinv) != 0) continue
      roots++
      val den = peval(dlam, xinv)
      if (den == 0) return null
      fixed[j] = fixed[j] xor gmul(loc[j], gmul(peval(omega, xinv), ginv(den)))
    }
    if (roots != lam.size - 1) return null

    // Safety net: expected unreachable once the degree and root-count checks pass.
    if (!rsEncode(fixed.copyOfRange(0, K)).contentEquals(fixed)) return null
    var value = 0L
    for (j in 0 until K) value = (value shl 6) or fixed[j].toLong()
    val nbad = (0 until N).count { it !in erased && fixed[it] != recv[it] }
    return RingDecoded(value and 0xFFFFFFFFL, (value shr 32).toInt(), nbad + e)
  }

  /** The 32-bit [id] as 7 Crockford base32 characters. */
  fun codeOf(id: Long): String =
      String(CharArray(7) { i -> CROCKFORD[((id shr (30 - 5 * i)) and 31).toInt()] })
}
