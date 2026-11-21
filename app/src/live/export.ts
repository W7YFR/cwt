/* The Live page's log as files: the transcript as text, the QSOs as ADIF for
 * a logging program, and as CSV for a spreadsheet.
 *
 * ADIF has one record per station heard in each QSO. With your call in a QSO,
 * it is one record for each station you worked, with the reports both ways.
 *
 * Pure.
 */

import { FIELD_KEYS, KIND_LABEL, type Fields } from "./parse";
import type { Line, Qso } from "./log";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** A time as UTC date and time: 2026-11-21 18:04:05. */
function utc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** The transcript, one turn a line: time, pitch, sender, speed and text. */
export function transcriptText(lines: readonly Line[]): string {
  return lines
    .map((l) => {
      const who = l.sender ?? "?";
      const speed = l.turn.wpm ? ` ${l.turn.wpm} WPM` : "";
      return `${utc(l.turn.at)}Z  ${l.turn.hz} Hz  ${who}${speed}  ${l.turn.text}`;
    })
    .join("\n")
    .concat(lines.length ? "\n" : "");
}

/** One ADIF field. */
function adif(name: string, value: string | undefined): string {
  if (!value) return "";
  return `<${name}:${value.length}>${value} `;
}

/** The QSOs as ADIF. */
export function logAdif(qsos: readonly Qso[], myCall: string, version: string): string {
  const head = `Live log from CWT\n${adif("ADIF_VER", "3.1.4")}${adif("PROGRAMID", "CWT")}${adif("PROGRAMVERSION", version)}<EOH>\n`;
  const records: string[] = [];
  for (const q of qsos) {
    const d = new Date(q.at);
    const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
    const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    const me = q.stations.find((s) => s.mine);
    const kind = q.kind ? KIND_LABEL[q.kind] : "";
    for (const s of q.stations) {
      if (s.mine) continue;
      const f = s.fields;
      const others = q.stations.filter((o) => o !== s).map((o) => o.call);
      const comment = [kind, me ? "" : others.length ? `with ${others.join(" ")}` : "", f.rig ? `rig ${f.rig}` : "", f.ant ? `ant ${f.ant}` : "", f.number ? `nr ${f.number}` : ""]
        .filter(Boolean)
        .join("; ");
      records.push(
        adif("CALL", s.call) +
          adif("QSO_DATE", date) +
          adif("TIME_ON", time) +
          adif("MODE", "CW") +
          adif("NAME", f.name) +
          adif("QTH", f.qth) +
          adif("STATE", f.state) +
          adif("RST_RCVD", me ? f.rst : undefined) +
          adif("RST_SENT", me ? me.fields.rst : undefined) +
          adif("RX_PWR", f.power?.replace(/W$/, "")) +
          adif("SIG", f.park ? "POTA" : undefined) +
          adif("SIG_INFO", f.park) +
          adif("SKCC", f.skcc) +
          adif("STATION_CALLSIGN", me ? myCall : undefined) +
          adif("COMMENT", comment) +
          "<EOR>",
      );
    }
  }
  return `${head}${records.join("\n")}\n`;
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

const FIELD_HEADS: Readonly<Record<keyof Fields, string>> = {
  name: "Name",
  qth: "QTH",
  state: "State",
  rst: "Report sent",
  power: "Power",
  rig: "Rig",
  ant: "Antenna",
  number: "Number",
  park: "Park",
  skcc: "SKCC",
};

/** The QSOs as CSV: a row for each station in each QSO. */
export function logCsv(qsos: readonly Qso[]): string {
  const head = ["QSO", "Start (UTC)", "Pitch (Hz)", "Kind", "Call", "WPM", ...FIELD_KEYS.map((k) => FIELD_HEADS[k])];
  const rows = [head];
  qsos.forEach((q, i) => {
    for (const s of q.stations) {
      rows.push([
        String(i + 1),
        utc(q.at),
        String(q.hz),
        q.kind ? KIND_LABEL[q.kind] : "",
        s.call,
        s.wpm ? String(s.wpm) : "",
        ...FIELD_KEYS.map((k) => s.fields[k] ?? ""),
      ]);
    }
  });
  return rows.map((r) => r.map(csvCell).join(",")).join("\n").concat("\n");
}
