// Minimal read-only ZIP reader (stored + deflate, basic ZIP64) built on node built-ins only.
import * as fs from 'fs';
import * as zlib from 'zlib';

interface ZipEntry {
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const n = fs.readSync(fd, buf, off, length - off, position + off);
    if (n <= 0) break;
    off += n;
  }
  return off === length ? buf : buf.subarray(0, off);
}

function u64(buf: Buffer, off: number): number {
  return Number(buf.readBigUInt64LE(off));
}

export class ZipFile {
  private entries = new Map<string, ZipEntry>();
  private fd: number | undefined;

  private constructor(fd: number) {
    this.fd = fd;
  }

  /** Opens a zip/jar file and reads its central directory. Returns undefined on any error. */
  static open(path: string): ZipFile | undefined {
    let fd: number | undefined;
    try {
      fd = fs.openSync(path, 'r');
      const zip = new ZipFile(fd);
      zip.readCentralDirectory(fs.fstatSync(fd).size);
      return zip;
    } catch {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
      return undefined;
    }
  }

  private readCentralDirectory(fileSize: number): void {
    const fd = this.fd!;
    const tailLen = Math.min(fileSize, 65535 + 22);
    const tailPos = fileSize - tailLen;
    const tail = readAt(fd, tailPos, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip file');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      // ZIP64: locator sits right before the EOCD record
      const locPos = tailPos + eocd - 20;
      if (locPos >= 0) {
        const loc = readAt(fd, locPos, 20);
        if (loc.readUInt32LE(0) === SIG_EOCD64_LOCATOR) {
          const rec = readAt(fd, u64(loc, 8), 56);
          if (rec.readUInt32LE(0) === SIG_EOCD64) {
            count = u64(rec, 32);
            cdSize = u64(rec, 40);
            cdOffset = u64(rec, 48);
          }
        }
      }
    }
    const cd = readAt(fd, cdOffset, cdSize);
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== SIG_CENTRAL) break;
      const method = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
        // ZIP64 extended information extra field (id 0x0001)
        let e = p + 46 + nameLen;
        const eEnd = e + extraLen;
        while (e + 4 <= eEnd) {
          const id = cd.readUInt16LE(e);
          const len = cd.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
            if (compressedSize === 0xffffffff) { compressedSize = u64(cd, q); q += 8; }
            if (localOffset === 0xffffffff) { localOffset = u64(cd, q); q += 8; }
            break;
          }
          e += 4 + len;
        }
      }
      this.entries.set(name, { method, compressedSize, size, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  entryNames(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Returns the uncompressed content of an entry, or undefined when missing/unsupported/corrupt. */
  read(name: string): Buffer | undefined {
    const e = this.entries.get(name);
    if (!e || this.fd === undefined) return undefined;
    try {
      const local = readAt(this.fd, e.localOffset, 30);
      if (local.length < 30 || local.readUInt32LE(0) !== SIG_LOCAL) return undefined;
      const dataPos = e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const data = readAt(this.fd, dataPos, e.compressedSize);
      if (e.method === 0) return data;
      if (e.method === 8) return zlib.inflateRawSync(data);
      return undefined;
    } catch {
      return undefined;
    }
  }

  close(): void {
    if (this.fd !== undefined) {
      try { fs.closeSync(this.fd); } catch { /* ignore */ }
      this.fd = undefined;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Minimal writer (stored entries only), used to create "pathing jars" whose manifest carries a long classpath.

let crcTable: Uint32Array | undefined;

function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function writeStoredZip(file: string, entries: { name: string; data: Buffer }[]): void {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(10, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, e.data);
    centrals.push(central, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, eocd]));
}

/** Builds a MANIFEST.MF whose Class-Path lists every entry (as file URLs; directories end with '/'). */
export function pathingManifest(entries: string[]): string {
  const urls = entries.map(e => {
    let u = e.replace(/\\/g, '/');
    if (!u.startsWith('/')) u = '/' + u;
    if (fs.statSync(e, { throwIfNoEntry: false })?.isDirectory() && !u.endsWith('/')) u += '/';
    return 'file:' + encodeURI(u).replace(/#/g, '%23');
  });
  const line = 'Class-Path: ' + urls.join(' ');
  // Manifest lines are limited to 72 bytes; continuation lines start with a space.
  const out: string[] = [];
  let rest = line;
  out.push(rest.slice(0, 70));
  rest = rest.slice(70);
  while (rest.length) {
    out.push(' ' + rest.slice(0, 69));
    rest = rest.slice(69);
  }
  return 'Manifest-Version: 1.0\r\n' + out.join('\r\n') + '\r\n\r\n';
}
