/**
 * Fetches the film, which is not in the repository, and makes the copy the browser tests play.
 *
 * The film's tracks, storyboard, stills and posters are committed. The film itself is not (it is 38 MB), so a fresh
 * clone has nothing to play on the workbench pages and the browser tests cannot start. This downloads each file
 * listed in `media-src/film/checksums.json` from the live site into the place the workbench expects it, checks its
 * size and SHA-256 against that list, and then writes `test-fixtures/film-720-silent.mp4`, the same film with no
 * audio track, which every automated browser plays instead (tests/e2e/support/silence.mjs).
 *
 * Usage:
 *   node scripts/film-fetch.mjs                 download what is missing, verify, make the silent copy
 *   node scripts/film-fetch.mjs --check         ask the site for each file's size and compare; download nothing
 *   node scripts/film-fetch.mjs --from <url>    another address that serves the same paths (or FILM_BASE=<url>)
 *
 * A file already in place with the right checksum is left alone. A download whose checksum is wrong is deleted and
 * the script exits 1. The silent copy needs ffmpeg on the PATH; it is a copy of the picture's stream, not a re-encode.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const repo = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const list = JSON.parse(readFileSync(repo('media-src/film/checksums.json'), 'utf8'));
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const given = args.includes('--from') ? args[args.indexOf('--from') + 1] : process.env.FILM_BASE;
const base = (given ?? list.from).replace(/\/?$/, '/');
const megabytes = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

const sha256 = async (path) => {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
};
const matches = async (path, file) => existsSync(path) && statSync(path).size === file.bytes && (await sha256(path)) === file.sha256;

let failed = false;
for (const file of list.files) {
  const url = new URL(file.name, base).href;
  const to = repo(file.to);

  if (checkOnly) {
    const response = await fetch(url, { method: 'HEAD' });
    const size = Number(response.headers.get('content-length'));
    const same = response.ok && size === file.bytes;
    console.log(`${same ? 'same  ' : 'DIFFER'}  ${url}  ${response.status}, ${size || '?'} bytes (the list says ${file.bytes})`);
    failed ||= !same;
    continue;
  }

  if (await matches(to, file)) {
    console.log(`have    ${file.to}`);
    continue;
  }
  console.log(`get     ${url}  (${megabytes(file.bytes)})`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    console.error(`        ${response.status} ${response.statusText}`);
    failed = true;
    continue;
  }
  mkdirSync(dirname(to), { recursive: true });
  const partial = `${to}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  if (await matches(partial, file)) {
    renameSync(partial, to);
    console.log(`ok      ${file.to}`);
  } else {
    console.error(`        not the file the list names: ${statSync(partial).size} bytes, sha256 ${await sha256(partial)}`);
    console.error(`        expected ${file.bytes} bytes, sha256 ${file.sha256}. Nothing was kept.`);
    rmSync(partial);
    failed = true;
  }
}

if (!checkOnly && !failed) {
  const { from, to } = list.silent;
  mkdirSync(dirname(repo(to)), { recursive: true });
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', repo(from), '-c:v', 'copy', '-an', '-movflags', '+faststart', repo(to)], { stdio: ['ignore', 'ignore', 'inherit'] });
    console.log(`ok      ${to}  (${megabytes(statSync(repo(to)).size)}, no audio track)`);
  } catch (error) {
    console.error(`        could not write ${to}: ${error.code === 'ENOENT' ? 'ffmpeg is not on the PATH' : error.message}`);
    console.error(`        ffmpeg -i ${from} -c:v copy -an -movflags +faststart ${to}`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
