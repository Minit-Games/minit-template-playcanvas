// A ZIP writer in pure Node, because `zip` does not exist on Windows.
//
// The alternative was shelling out to 7-Zip or `tar -a`, but both put a
// platform-specific binary back in the packaging path -- the exact thing that
// made this template unshippable on Windows in the first place. Deflate ships
// in node:zlib, and the container format is a few dozen lines, so the ZIP is
// built here and the toolchain stays "Node and nothing else".
import { deflateRawSync } from 'node:zlib';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const CRC = (() => {
	const t = new Int32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) { c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; }
		t[i] = c;
	}
	return t;
})();

function crc32(buf) {
	let c = ~0;
	for (let i = 0; i < buf.length; i++) { c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); }
	return (~c) >>> 0;
}

/** Every file under dir, as paths relative to it, with POSIX separators. */
export async function walk(dir, base = dir) {
	const out = [];
	for (const e of await readdir(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) { out.push(...await walk(p, base)); }
		// ZIP entry names are always "/"-separated, whatever the host uses.
		else if (e.isFile()) { out.push(relative(base, p).split(sep).join('/')); }
	}
	return out.sort();
}

/**
 * Write `entries` ([{ name, data }]) to a ZIP at `out`.
 * Returns the archive size in bytes.
 */
export async function writeZip(out, entries) {
	const now = new Date();
	// DOS timestamps: 2-second resolution, epoch 1980.
	const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
	const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

	const locals = [], central = [];
	let offset = 0;

	for (const { name, data, dir } of entries) {
		const nameBuf = Buffer.from(name, 'utf8');
		const comp = dir ? data : deflateRawSync(data, { level: 9 });
		// Deflate can inflate an incompressible file; store it raw if so.
		const deflated = !dir && comp.length < data.length;
		const body = deflated ? comp : data;
		const method = deflated ? 8 : 0;
		const sum = crc32(data);

		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0);   // local file header
		lh.writeUInt16LE(20, 4);           // version needed
		lh.writeUInt16LE(0x0800, 6);       // bit 11: the name is UTF-8
		lh.writeUInt16LE(method, 8);
		lh.writeUInt16LE(time, 10);
		lh.writeUInt16LE(date, 12);
		lh.writeUInt32LE(sum, 14);
		lh.writeUInt32LE(body.length, 18);
		lh.writeUInt32LE(data.length, 22);
		lh.writeUInt16LE(nameBuf.length, 26);
		lh.writeUInt16LE(0, 28);
		locals.push(lh, nameBuf, body);

		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0);   // central directory header
		ch.writeUInt16LE(20, 4);           // version made by
		ch.writeUInt16LE(20, 6);           // version needed
		ch.writeUInt16LE(0x0800, 8);
		ch.writeUInt16LE(method, 10);
		ch.writeUInt16LE(time, 12);
		ch.writeUInt16LE(date, 14);
		ch.writeUInt32LE(sum, 16);
		ch.writeUInt32LE(body.length, 20);
		ch.writeUInt32LE(data.length, 24);
		ch.writeUInt16LE(nameBuf.length, 28);
		// external attrs (>>>0: the shift overflows int32). The low byte carries
		// the DOS directory flag, which is what most extractors actually read.
		ch.writeUInt32LE(dir ? (((0o40755 << 16) >>> 0) | 0x10) : ((0o100644 << 16) >>> 0), 38);
		ch.writeUInt32LE(offset, 42);
		central.push(ch, nameBuf);

		offset += lh.length + nameBuf.length + body.length;
	}

	const cd = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);   // end of central directory
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cd.length, 12);
	eocd.writeUInt32LE(offset, 16);

	const zip = Buffer.concat([...locals, cd, eocd]);
	await writeFile(out, zip);
	return zip.length;
}

/** Zip the contents of `dir` (no leading folder inside the archive). */
export async function zipDir(dir, out, exclude = []) {
	const names = (await walk(dir)).filter((n) => !exclude.includes(n));

	// Explicit directory entries. The spec makes them optional and every
	// extractor tested here infers the tree without them, but `zip` emits them
	// and this archive goes to the Creator Console -- so match what has been
	// uploading successfully rather than bet on the console's extractor.
	const dirs = new Set();
	for (const n of names) {
		const parts = n.split('/');
		for (let i = 1; i < parts.length; i++) { dirs.add(parts.slice(0, i).join('/') + '/'); }
	}

	const entries = [...dirs].sort().map((name) => ({ name, data: Buffer.alloc(0), dir: true }));
	for (const name of names) { entries.push({ name, data: await readFile(join(dir, name)) }); }
	return { bytes: await writeZip(out, entries), names };
}
