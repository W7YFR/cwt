/* A certificate for testing on a real device.
 *
 * The microphone is only offered to a secure context, and "secure" means https
 * or localhost. A phone on the LAN is neither: it reaches this machine at
 * http://192.168.x.x:5173, where `getUserMedia` does not exist at all — which
 * looks exactly like a browser that cannot record rather than like a policy.
 *
 * So the dev server needs a certificate, and the certificate needs to be one
 * the phone believes. A self-signed one is a coin toss: Safari will let you
 * click past the warning, but what it then grants a page it has been told not
 * to trust is not documented and not worth discovering halfway through
 * debugging something else. mkcert issues from a local authority instead —
 * install that authority on the phone once and the certificate is simply
 * valid, with no warning to click past and no question about what the browser
 * will allow.
 *
 * Nothing here is reachable from outside the LAN and nothing is published: the
 * authority lives on this machine, the certificate covers private addresses,
 * and `.devcert/` is ignored by git.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, URL } from "node:url";

const DIR = fileURLToPath(new URL("../.devcert/", import.meta.url));
export const CERT = `${DIR}cert.pem`;
export const KEY = `${DIR}key.pem`;
/* What the certificate was issued for, written beside it. Reading the names
   back out of a PEM means parsing one; this file is the same fact in the form
   it is actually needed in — a list to compare against today's addresses,
   because a laptop that moved to a different network has a certificate that no
   longer names it. */
const NAMES = `${DIR}names.json`;

/** Every address this machine can be reached at from the network it is on.
 *
 * IPv4 only, and no loopback: the point is the addresses a phone can dial.
 * Both are listed on the certificate anyway — `localhost` so the ordinary
 * `make dev` keeps working through the same files, and the LAN addresses so
 * the phone does. */
function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out.sort();
}

function mkcertPath() {
  try {
    return execFileSync("which", ["mkcert"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Whether the local authority has been created and trusted on this machine.
 *
 * `mkcert -install` is the step that needs a password, so it is the one step
 * this script will not take on someone's behalf.
 *
 * @param {string} mkcert */
function caInstalled(mkcert) {
  try {
    const root = execFileSync(mkcert, ["-CAROOT"], { encoding: "utf8" }).trim();
    return existsSync(`${root}/rootCA.pem`) ? root : null;
  } catch {
    return null;
  }
}

export function ensureCert({ quiet = false } = {}) {
  const mkcert = mkcertPath();
  if (!mkcert) {
    console.error(
      [
        "mkcert is not installed, and it is what issues the certificate.",
        "",
        "  brew install mkcert nss",
        "  mkcert -install        # asks for your password: it trusts the CA on this Mac",
        "",
        "Then run this again.",
      ].join("\n"),
    );
    process.exit(1);
  }
  const root = caInstalled(mkcert);
  if (!root) {
    console.error(
      ["The local authority has not been created yet:", "", "  mkcert -install", ""].join("\n"),
    );
    process.exit(1);
  }

  const lan = lanAddresses();
  const names = ["localhost", "127.0.0.1", "::1", ...lan];
  const have = existsSync(NAMES) ? JSON.parse(readFileSync(NAMES, "utf8")) : null;
  /* Re-issued when the addresses change, which is what moving between networks
     looks like from here. A certificate that does not name the address the
     phone is dialing is a warning page, and the cause of it — a different
     coffee shop — is a long way from the symptom. */
  const current =
    existsSync(CERT) && existsSync(KEY) && have && JSON.stringify(have) === JSON.stringify(names);

  if (!current) {
    mkdirSync(DIR, { recursive: true });
    execFileSync(mkcert, ["-cert-file", CERT, "-key-file", KEY, ...names], { stdio: "inherit" });
    writeFileSync(NAMES, JSON.stringify(names, null, 2) + "\n");
  }

  if (!quiet) {
    const where = lan.length
      ? lan.map((ip) => `  https://${ip}:5173`).join("\n")
      : "  (no LAN address found — is this machine on a network?)";
    console.log(
      [
        current ? "Certificate is current." : "Certificate issued.",
        "",
        "On the phone, once, so it trusts the authority that signed it:",
        `  1. AirDrop or otherwise open this file on the device:`,
        `       ${root}/rootCA.pem`,
        "  2. Settings → Profile Downloaded → Install",
        "  3. Settings → General → About → Certificate Trust Settings →",
        "     turn on full trust for mkcert",
        "",
        "Then, with the server running, open:",
        where,
        "",
      ].join("\n"),
    );
  }
  return { cert: CERT, key: KEY, addresses: lan };
}

/** Whether a path is safe to delete recursively.
 *
 * `mkcert -CAROOT` is a command substitution, and the documented way to remove
 * the authority used to be `rm -rf "$(mkcert -CAROOT)"`. On macOS that is a
 * silent no-op when mkcert is missing — which is the actual hazard: you are
 * told the authority is gone while your devices still trust it. Worse is a
 * path that is real but not the one meant.
 *
 * So nothing is deleted on the strength of a subprocess printing something.
 * It has to be an absolute path, to a directory that exists, that is not the
 * root or a home directory, that is more than one level down, and that
 * contains the file only a mkcert authority contains. Anything else is not the
 * thing this is allowed to remove.
 *
 * @param {string} dir
 * @returns {string | null} the reason it is unsafe, or null if it is fine */
function unsafeToRemove(dir) {
  if (!dir) return "the path is empty";
  if (!isAbsolute(dir)) return `not an absolute path: ${dir}`;
  const full = resolve(dir);
  if (full === sep) return "that is the filesystem root";
  if (full === resolve(homedir())) return "that is your home directory";
  if (full.split(sep).filter(Boolean).length < 2) return `too close to the root: ${full}`;
  if (!existsSync(full)) return null; // nothing to do is not unsafe
  if (!statSync(full).isDirectory()) return `not a directory: ${full}`;
  if (!existsSync(`${full}/rootCA.pem`)) return `no rootCA.pem in ${full} — not a mkcert CA`;
  return null;
}

/** @param {string} question */
async function confirm(question) {
  if (process.argv.includes("--yes")) return true;
  if (!process.stdin.isTTY) {
    console.error("Not a terminal, so nothing was removed. Re-run with --yes to mean it.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Undo `mkcert -install` and everything this script has written.
 *
 * Two separate things, and only one of them belongs to this project. The
 * certificate and key under `.devcert/` are ours and go without ceremony. The
 * authority is the machine's: every other project that has ever run
 * `mkcert -install` is trusting it too, and removing it breaks their local
 * https as well. So it is asked about, by name, before anything happens. */
export async function uninstallCert() {
  // Ours, and computed from this file rather than from any command output.
  if (existsSync(DIR)) {
    rmSync(DIR, { recursive: true, force: true });
    console.log(`Removed ${DIR}`);
  } else {
    console.log("No .devcert/ to remove — the dev server was already plain http.");
  }

  const mkcert = mkcertPath();
  if (!mkcert) {
    console.log(
      [
        "",
        "mkcert is not installed, so the local authority cannot be removed by name.",
        "If it was ever installed, it may still be trusted by this machine and by",
        "any device you loaded it onto. Reinstall mkcert and run this again:",
        "",
        "  brew install mkcert",
        "  make uninstall:cert",
        "",
      ].join("\n"),
    );
    return;
  }

  const root = caInstalled(mkcert);
  if (!root) {
    console.log("No mkcert authority on this machine. Nothing else to remove.");
    return;
  }

  const why = unsafeToRemove(root);
  if (why) {
    console.error(
      [
        "",
        `Refusing to delete the authority directory: ${why}`,
        "",
        `mkcert reported its root as: ${root || "(nothing)"}`,
        "Remove it by hand if that is really where it lives.",
        "",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    [
      "",
      `This removes the mkcert authority at ${root}.`,
      "",
      "It is shared: every project on this machine that uses a mkcert",
      "certificate will stop being trusted, and any device you installed it on",
      "keeps trusting it until you remove the profile there too.",
      "",
    ].join("\n"),
  );
  if (!(await confirm("Remove it?"))) {
    console.log("Left alone.");
    return;
  }

  // The system trust stores first, while mkcert still knows where its CA is.
  execFileSync(mkcert, ["-uninstall"], { stdio: "inherit" });
  rmSync(root, { recursive: true, force: true });
  console.log(
    [
      `Removed ${root}`,
      "",
      "On the phone, to finish: Settings → General → VPN & Device Management →",
      "the mkcert profile → Remove Profile.",
      "",
    ].join("\n"),
  );
}

// Run directly — `node scripts/devcert.mjs` — as well as imported by the vite
// config, which only ever reads the files this writes.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.argv.includes("--uninstall")) await uninstallCert();
  else ensureCert();
}
