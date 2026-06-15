// ─────────────────────────────────────────────────────────────────────────────
// build-cities.mjs — GeoNames gazetteer builder (the source of VERIFIED places)
//
// Downloads the GeoNames cities15000 dump (every city with population >= 15000),
// parses the tab-separated dump, and writes a compact JSON array to
// Server/src/data/cities.json that lib/geocode.js loads at runtime.
//
// Run:  node scripts/build-cities.mjs
//
// cities15000.txt columns (0-indexed, tab-separated):
//   0  geonameid
//   1  name
//   2  asciiname
//   4  latitude
//   5  longitude
//   8  country code (ISO-3166 alpha-2)
//   10 admin1 code
//   14 population
//
// ZIP handling: we DO NOT trust the local-header compressed size, because
// GeoNames entries use a data descriptor (bit 3 of the general-purpose flag),
// which means the local header carries compSize=0 / uncompSize=0 and the real
// sizes live in a trailing descriptor. Reading `compSize` blindly therefore
// inflates 0 bytes and writes 0 cities. Instead we shell out to the system
// unzip (tar -xf, which understands ZIP) for a robust, well-tested extraction.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "src", "data");
const OUT_FILE = join(OUT_DIR, "cities.json");
const URL = "https://download.geonames.org/export/dump/cities15000.zip";

// Column indices in cities15000.txt (0-indexed).
const COL = {
  geonameid: 0,
  name: 1,
  asciiname: 2,
  latitude: 4,
  longitude: 5,
  countrycode: 8,
  admin1code: 10,
  population: 14,
};

/**
 * Download the ZIP and extract cities15000.txt into `workDir`.
 *
 * Resilient by design: rather than parse the ZIP container ourselves (and risk
 * the data-descriptor / compSize=0 trap described above), we download with
 * curl and extract with `tar -xf`, both of which are present on the CI image
 * and on macOS / Linux / Git-Bash on Windows (curl.exe + bsdtar).
 *
 * @param {string} workDir
 * @returns {string} absolute path to the extracted cities15000.txt
 */
function downloadAndExtract(workDir) {
  const zipPath = join(workDir, "cities15000.zip");

  // curl -L follows the redirect GeoNames issues; -o writes to disk.
  // (curl.exe on Windows / curl on POSIX — same flags.)
  console.log(`Downloading ${URL} ...`);
  execFileSync("curl", ["-L", "-o", zipPath, URL], { stdio: "inherit" });

  // tar understands the ZIP format (bsdtar / libarchive) and handles data
  // descriptors correctly, so we never read a bogus compSize.
  console.log("Extracting cities15000.txt ...");
  execFileSync("tar", ["-xf", zipPath, "-C", workDir], { stdio: "inherit" });

  return join(workDir, "cities15000.txt");
}

/**
 * Parse the tab-separated dump into our compact record shape.
 *
 * @param {string} txt  raw contents of cities15000.txt
 * @returns {Array<{id:number,name:string,ascii:string,country:string,admin1:string,lat:number,lng:number,pop:number}>}
 */
function parse(txt) {
  const out = [];
  const lines = txt.split("\n");
  for (const line of lines) {
    if (!line) continue;
    const f = line.split("\t");
    // Guard against short/truncated lines so a malformed row never crashes the run.
    if (f.length <= COL.population) continue;
    const id = Number(f[COL.geonameid]);
    const lat = Number(f[COL.latitude]);
    const lng = Number(f[COL.longitude]);
    if (!Number.isFinite(id) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out.push({
      id,
      name: f[COL.name] || "",
      ascii: f[COL.asciiname] || "",
      country: (f[COL.countrycode] || "").toLowerCase(),
      admin1: f[COL.admin1code] || "",
      lat,
      lng,
      pop: Number(f[COL.population]) || 0,
    });
  }
  return out;
}

function main() {
  const workDir = mkdtempSync(join(tmpdir(), "klar-cities-"));
  try {
    const txtPath = downloadAndExtract(workDir);
    const txt = readFileSync(txtPath, "utf8");
    const cities = parse(txt);

    if (cities.length === 0) {
      throw new Error(
        "Parsed 0 cities — extraction likely failed (data-descriptor ZIP). " +
          "Check that curl + tar are available on PATH.",
      );
    }

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(OUT_FILE, JSON.stringify(cities));
    console.log(`Wrote ${cities.length} cities to ${OUT_FILE}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main();
