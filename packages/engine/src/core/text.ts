// File: packages/engine/src/core/text.ts
//
// Source texts and their coordinates.  Agda counts positions in code
// points (its `pos` is 1-based, after a leading byte-order mark it drops,
// in the text it reads with each CR LF made one LF: Agda.Utils.IO.UTF8's
// convertLineEndings, which turns the other line endings into LF one for
// one), and JavaScript strings, CodeMirror and VS Code count UTF-16 code
// units; the two differ at every character outside the Basic Multilingual
// Plane, and at every CR LF.
// The digest names the exact text Agda read: the SHA-256 of its UTF-8
// encoding, computed here so that the core needs no platform API.

const BOM = 0xfeff;

function isHighSurrogate(unit: number) {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number) {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** The number of code points in `text`. */
export function codePointLength(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    if (
      isHighSurrogate(text.charCodeAt(index)) &&
      isLowSurrogate(text.charCodeAt(index + 1))
    )
      index++;
    count++;
  }
  return count;
}

/** The UTF-16 offsets of a text's astral characters, by which code point
 * offsets and UTF-16 offsets convert in either direction, and the places
 * of its CR LFs, by which Agda's positions convert to either. */
export class OffsetTable {
  /** UTF-16 offsets of the high surrogates, ascending. */
  private readonly astral: number[] = [];
  /** Agda's 0-based indexes of the line ends that are CR LF in the text,
   * ascending: Agda reads each as one LF, at its CR's place. */
  private readonly crlf: number[] = [];
  /** 1 when the text starts with a byte-order mark, which Agda drops
   * before it counts positions. */
  readonly bom: number;
  readonly utf16Length: number;
  readonly codePoints: number;

  constructor(text: string) {
    this.bom = text.charCodeAt(0) === BOM ? 1 : 0;
    let codePoint = 0;
    for (let index = 0; index < text.length; index++, codePoint++) {
      const unit = text.charCodeAt(index);
      if (isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(index + 1))) {
        this.astral.push(index);
        index++;
      } else if (unit === 0x0d && text.charCodeAt(index + 1) === 0x0a) {
        this.crlf.push(codePoint - this.bom - this.crlf.length);
      }
    }
    this.utf16Length = text.length;
    this.codePoints = text.length - this.astral.length;
  }

  /** The UTF-16 offset of the code point at `codePoint` (0-based, as the
   * text is written, the byte-order mark included). */
  toUtf16(codePoint: number): number {
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > this.codePoints)
      throw new RangeError(`code point offset ${codePoint} is outside the text`);
    // Every astral character before the answer adds one unit.
    let low = 0;
    let high = this.astral.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.astral[middle] - middle < codePoint) low = middle + 1;
      else high = middle;
    }
    return codePoint + low;
  }

  /** The code point offset of a UTF-16 offset, which must not split a
   * surrogate pair. */
  toCodePoint(utf16: number): number {
    if (!Number.isInteger(utf16) || utf16 < 0 || utf16 > this.utf16Length)
      throw new RangeError(`UTF-16 offset ${utf16} is outside the text`);
    let low = 0;
    let high = this.astral.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.astral[middle] < utf16) low = middle + 1;
      else high = middle;
    }
    if (low > 0 && this.astral[low - 1] + 1 === utf16)
      throw new RangeError(`UTF-16 offset ${utf16} splits a surrogate pair`);
    return utf16 - low;
  }

  /** The UTF-16 offset of Agda's 1-based `pos`. */
  fromAgdaPos(pos: number): number {
    const index = pos - 1;
    // Every CR LF before it is one code point more in the text than in
    // Agda's count.
    let low = 0;
    let high = this.crlf.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.crlf[middle] < index) low = middle + 1;
      else high = middle;
    }
    return this.toUtf16(index + this.bom + low);
  }
}

/** Whether `converted` places every line and every code point of
 * `original` where `original` has it: the same lines, each with the same
 * number of code points.  A host's conversion of a source (the page's
 * module aliases for PLFA) must, since Agda's positions in the converted
 * text are read against the original. */
export function preservesPositions(original: string, converted: string): boolean {
  if (original === converted) return true;
  const before = original.split("\n");
  const after = converted.split("\n");
  if (before.length !== after.length) return false;
  for (let index = 0; index < before.length; index++) {
    if (codePointLength(before[index]) !== codePointLength(after[index]))
      return false;
  }
  return true;
}

/** The UTF-8 encoding of `text`; an unpaired surrogate becomes U+FFFD, as
 * TextEncoder writes it. */
export function utf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index++) {
    let point = text.charCodeAt(index);
    if (isHighSurrogate(point) && isLowSurrogate(text.charCodeAt(index + 1))) {
      point = 0x10000 + ((point - 0xd800) << 10) + (text.charCodeAt(index + 1) - 0xdc00);
      index++;
    } else if (isHighSurrogate(point) || isLowSurrogate(point)) {
      point = 0xfffd;
    }
    if (point < 0x80) bytes.push(point);
    else if (point < 0x800) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    else if (point < 0x10000)
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    else
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
  }
  return Uint8Array.from(bytes);
}

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The SHA-256 of `bytes`, in lowercase hexadecimal (FIPS 180-4). */
export function sha256Hex(bytes: Uint8Array): string {
  const length = bytes.length;
  const blocks = Math.ceil((length + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);

  const hash = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < blocks; block++) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(block * 64 + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotate(w[t - 15], 7) ^ rotate(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotate(w[t - 2], 17) ^ rotate(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let t = 0; t < 64; t++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + K[t] + w[t]) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    hash[0] += a;
    hash[1] += b;
    hash[2] += c;
    hash[3] += d;
    hash[4] += e;
    hash[5] += f;
    hash[6] += g;
    hash[7] += h;
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
}

/** The digest that names a source text: `sha256:` and the SHA-256 of its
 * UTF-8 encoding. */
export function sourceDigest(text: string): string {
  return `sha256:${sha256Hex(utf8(text))}`;
}
