export type ZipEntry = {
  data: Uint8Array;
  name: string;
};

const encoder = new TextEncoder();
const table = new Uint32Array(256);
type PackedEntry = {
  crc: number;
  data: Uint8Array;
  name: Uint8Array;
};

for (let value = 0; value < table.length; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  table[value] = crc >>> 0;
}

export function zip(entries: ZipEntry[]): Uint8Array {
  const files = entries.map((entry) => {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    return { ...entry, crc, name };
  });
  const locals = files.map((file) => 30 + file.name.length + file.data.length);
  const centrals = files.map((file) => 46 + file.name.length);
  const localSize = locals.reduce((sum, size) => sum + size, 0);
  const centralSize = centrals.reduce((sum, size) => sum + size, 0);
  const result = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(result.buffer);
  let offset = 0;
  const centralOffsets: number[] = [];

  for (const file of files) {
    centralOffsets.push(offset);
    offset = writeLocal(view, result, offset, file);
  }

  const centralStart = offset;
  for (let index = 0; index < files.length; index += 1) {
    offset = writeCentral(view, result, offset, files[index], centralOffsets[index]);
  }

  writeEnd(view, offset, files.length, centralSize, centralStart);
  return result;
}

function writeLocal(
  view: DataView,
  target: Uint8Array,
  offset: number,
  file: PackedEntry,
): number {
  view.setUint32(offset, 0x04034b50, true);
  view.setUint16(offset + 4, 20, true);
  view.setUint16(offset + 6, 0x0800, true);
  view.setUint16(offset + 8, 0, true);
  writeDate(view, offset + 10);
  view.setUint32(offset + 14, file.crc, true);
  view.setUint32(offset + 18, file.data.length, true);
  view.setUint32(offset + 22, file.data.length, true);
  view.setUint16(offset + 26, file.name.length, true);
  view.setUint16(offset + 28, 0, true);
  target.set(file.name, offset + 30);
  target.set(file.data, offset + 30 + file.name.length);
  return offset + 30 + file.name.length + file.data.length;
}

function writeCentral(
  view: DataView,
  target: Uint8Array,
  offset: number,
  file: PackedEntry,
  localOffset: number,
): number {
  view.setUint32(offset, 0x02014b50, true);
  view.setUint16(offset + 4, 20, true);
  view.setUint16(offset + 6, 20, true);
  view.setUint16(offset + 8, 0x0800, true);
  view.setUint16(offset + 10, 0, true);
  writeDate(view, offset + 12);
  view.setUint32(offset + 16, file.crc, true);
  view.setUint32(offset + 20, file.data.length, true);
  view.setUint32(offset + 24, file.data.length, true);
  view.setUint16(offset + 28, file.name.length, true);
  view.setUint16(offset + 30, 0, true);
  view.setUint16(offset + 32, 0, true);
  view.setUint16(offset + 34, 0, true);
  view.setUint16(offset + 36, 0, true);
  view.setUint32(offset + 38, 0, true);
  view.setUint32(offset + 42, localOffset, true);
  target.set(file.name, offset + 46);
  return offset + 46 + file.name.length;
}

function writeEnd(view: DataView, offset: number, count: number, centralSize: number, centralStart: number): void {
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, count, true);
  view.setUint16(offset + 10, count, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, centralStart, true);
}

function writeDate(view: DataView, offset: number): void {
  const date = new Date();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  view.setUint16(offset, time, true);
  view.setUint16(offset + 2, day, true);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
