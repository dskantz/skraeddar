import * as THREE from 'three';

export interface PlacedGeometry {
  geometry: THREE.BufferGeometry;
  dx: number;
  dy: number;
}

/** Writes a binary STL containing all geometries, each translated by (dx, dy). */
export const geometriesToBinaryStl = (header: string, items: PlacedGeometry[]): Uint8Array<ArrayBuffer> => {
  const triangleCount = items.reduce((sum, { geometry }) => {
    const count = geometry.index ? geometry.index.count : geometry.attributes.position.count;
    return sum + count / 3;
  }, 0);
  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(new TextEncoder().encode(header.slice(0, 80)));
  view.setUint32(80, triangleCount, true);

  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const normal = new THREE.Vector3();
  let offset = 84;
  const write = (v: THREE.Vector3) => {
    view.setFloat32(offset, v.x, true);
    view.setFloat32(offset + 4, v.y, true);
    view.setFloat32(offset + 8, v.z, true);
    offset += 12;
  };

  for (const { geometry, dx, dy } of items) {
    const pos = geometry.attributes.position.array;
    const index = geometry.index ? geometry.index.array : null;
    const count = index ? index.length : pos.length / 3;
    const read = (target: THREE.Vector3, i: number) => {
      const k = (index ? index[i] : i) * 3;
      return target.set(pos[k] + dx, pos[k + 1] + dy, pos[k + 2]);
    };
    for (let i = 0; i < count; i += 3) {
      read(v1, i);
      read(v2, i + 1);
      read(v3, i + 2);
      normal.crossVectors(e1.subVectors(v2, v1), e2.subVectors(v3, v1)).normalize();
      write(normal);
      write(v1);
      write(v2);
      write(v3);
      offset += 2;
    }
  }
  return bytes;
};

/** Builds a 3MF package with each geometry as a separate build item. */
export const geometriesToThreeMf = (items: PlacedGeometry[]): Blob => {
  const objects = items.map(({ geometry, dx, dy }, itemIndex) => {
    const position = geometry.attributes.position;
    const index = geometry.index;
    const vertexCount = position.count;
    const triangleCount = index ? index.count / 3 : vertexCount / 3;
    const vertices = Array.from({ length: vertexCount }, (_, vertexIndex) => {
      const x = position.getX(vertexIndex) + dx;
      const y = position.getY(vertexIndex) + dy;
      const z = position.getZ(vertexIndex);
      return `<vertex x="${x}" y="${y}" z="${z}"/>`;
    }).join('');
    const triangles = Array.from({ length: triangleCount }, (_, triangleIndex) => {
      const vertexIndex = triangleIndex * 3;
      const v1 = index ? index.getX(vertexIndex) : vertexIndex;
      const v2 = index ? index.getX(vertexIndex + 1) : vertexIndex + 1;
      const v3 = index ? index.getX(vertexIndex + 2) : vertexIndex + 2;
      return `<triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`;
    }).join('');
    const id = itemIndex + 1;
    return {
      id,
      xml: `<object id="${id}" type="model" name="Part ${id}"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object>`
    };
  });

  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objects.map(({ xml }) => xml).join('')}</resources><build>${objects.map(({ id }) => `<item objectid="${id}"/>`).join('')}</build></model>`;
  const contentTypes = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
  const relationships = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';

  return createZip([
    { name: '[Content_Types].xml', content: contentTypes },
    { name: '_rels/.rels', content: relationships },
    { name: '3D/3dmodel.model', content: model }
  ]);
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (data: Uint8Array) => {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const DOS_DATE_1980_01_01 = (1 << 5) | 1;

/** Builds an uncompressed (stored) ZIP archive. */
export const createZip = (files: { name: string; content: string | Uint8Array<ArrayBuffer> }[]): Blob => {
  const encoder = new TextEncoder();
  const chunks: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(12, DOS_DATE_1980_01_01, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(14, DOS_DATE_1980_01_01, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);

    offset += 30 + name.length + data.length;
  }

  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
};

export const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};
