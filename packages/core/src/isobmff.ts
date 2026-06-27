// A minimal ISO Base Media File Format reader/writer — just enough to remux
// fragmented MP4 (CMAF/DASH) by recombining whole boxes. It never decodes media,
// only walks the box tree and patches a handful of integer fields in place.

export type Box = {
  type: string;
  /** Offset of the box header (its size field). */
  start: number;
  /** Offset just past the box. */
  end: number;
  /** Offset of the box payload (after the size/type, and any 64-bit largesize). */
  dataStart: number;
};

export function parseBoxes(data: Uint8Array, start = 0, end = data.length): Box[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const boxes: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
    let dataStart = offset + 8;
    if (size === 1) {
      size = Number(view.getBigUint64(offset + 8));
      dataStart = offset + 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < 8 || offset + size > end) {
      break;
    }
    boxes.push({ type, start: offset, end: offset + size, dataStart });
    offset += size;
  }
  return boxes;
}

export function findBox(boxes: Box[], type: string): Box | undefined {
  return boxes.find((box) => box.type === type);
}

export function childBoxes(data: Uint8Array, box: Box): Box[] {
  return parseBoxes(data, box.dataStart, box.end);
}

/** A standalone copy of a box's bytes, header included. */
export function sliceBox(data: Uint8Array, box: Box): Uint8Array {
  return data.slice(box.start, box.end);
}

export function buildBox(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(payload, 8);
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function readU32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset);
}

export function writeU32(data: Uint8Array, offset: number, value: number): void {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(offset, value);
}

/** The version byte of a full box (the first byte of its payload). */
export function boxVersion(data: Uint8Array, box: Box): number {
  return data[box.dataStart];
}
