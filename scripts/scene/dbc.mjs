// Reads WDBC client database files (DBFilesClient/*.dbc): fixed-size records
// of 32-bit fields followed by a string block.

export function readDbc(buffer) {
  if (!buffer || buffer.length < 20 || buffer.toString('latin1', 0, 4) !== 'WDBC') {
    throw new Error('Not a WDBC file.');
  }
  const recordCount = buffer.readUInt32LE(4);
  const fieldCount = buffer.readUInt32LE(8);
  const recordSize = buffer.readUInt32LE(12);
  const stringBlockSize = buffer.readUInt32LE(16);
  const stringBlockOffset = 20 + recordCount * recordSize;
  if (stringBlockOffset + stringBlockSize > buffer.length) throw new Error('Truncated WDBC file.');

  const record = (index) => {
    const base = 20 + index * recordSize;
    return {
      uint: (field) => buffer.readUInt32LE(base + field * 4),
      int: (field) => buffer.readInt32LE(base + field * 4),
      float: (field) => buffer.readFloatLE(base + field * 4),
      string: (field) => {
        const offset = buffer.readUInt32LE(base + field * 4);
        if (!offset) return '';
        const start = stringBlockOffset + offset;
        const end = buffer.indexOf(0, start);
        return buffer.toString('utf8', start, end < 0 ? stringBlockOffset + stringBlockSize : end);
      },
    };
  };

  return {
    recordCount,
    fieldCount,
    record,
    *records() {
      for (let index = 0; index < recordCount; index += 1) yield record(index);
    },
    // Records by their first field (the ID), built on first use.
    byId() {
      const map = new Map();
      for (let index = 0; index < recordCount; index += 1) map.set(buffer.readUInt32LE(20 + index * recordSize), record(index));
      return map;
    },
  };
}
