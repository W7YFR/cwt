/* The exchange at the end of a QSO: each item as one side sent it and as
 * the other copied it.
 *
 * The station's items: what it sent, and what you copied of each, read off
 * your copy of its lines. Lined up as the grade lines them up, so a name you
 * copied as JIN shows JIN. With its lines not for copying, there is no copy
 * to show.
 *
 * Your items: what you meant to send, from User, and what the station took.
 * Where User leaves an item empty, what the station took shows alone, with
 * nothing to check it against. A report has no right answer, so it is never
 * marked wrong.
 *
 * Pure.
 */

import type { Qso } from "./cq";
import { FORMATS } from "./formats";
import { isRun, type AnyQso, type RunQso } from "./run";
import { gradeCopy } from "./show";
import { regionOf } from "./station";

/** One item, one way. */
export interface ReportRow {
  /** Sent by the station, or by you. */
  readonly from: "them" | "you";
  readonly label: string;
  /** What was sent: by the station, or what you meant to send. Empty when
   *  not known. */
  readonly sent: string;
  /** What the other side copied, or null with no copy to read. Empty when
   *  it copied nothing. */
  readonly copied: string | null;
  /** Whether the copy is right, or null when there is nothing to check. */
  readonly ok: boolean | null;
}

/** One of the station's lines, with your copy of it, or null when it was
 *  not for copying. */
export interface TheirLine {
  readonly text: string;
  readonly typed: string | null;
}

/** You, as you meant to send yourself: from User. Empty items are not
 *  known. */
export interface Meant {
  readonly call: string;
  readonly name: string;
  readonly qth: string;
  readonly region: string;
  readonly nr: string;
}

const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/** What you copied where `value` was sent, in one line: the characters you
 *  typed in the columns over its characters. Null when the line does not
 *  hold it. */
function copiedIn(line: TheirLine, value: string): string | null {
  if (line.typed === null) return null;
  const words = line.text.toUpperCase().split(/\s+/).filter(Boolean);
  const want = value.split(/\s+/);
  // Where the value starts, counted in characters sent, spaces left out.
  let at = -1;
  let count = 0;
  for (let i = 0; i + want.length <= words.length; i++) {
    if (want.every((w, k) => words[i + k] === w)) {
      at = count;
      break;
    }
    count += words[i]!.length;
  }
  if (at < 0) return null;
  const end = at + want.join("").length;
  // Each column over its characters gives what you typed there. Inside it,
  // a column with nothing sent is a space between its words, or a character
  // you added.
  let out = "";
  let k = 0;
  for (const col of gradeCopy(line.text, line.typed).columns) {
    const sent = col.sent.filter((m) => m.ok !== null).length;
    const yours = col.yours.map((m) => m.text).join("");
    if (sent > 0 ? k >= at && k < end : k > at && k < end) out += yours;
    k += sent;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Your copy of `value` across the station's lines: right if any copy of it
 *  is, else the last you typed anything for, else empty. Null when no line
 *  for copying held it. */
function copiedOf(lines: readonly TheirLine[], value: string): string | null {
  if (!value) return null;
  let best: string | null = null;
  for (const line of lines) {
    const got = copiedIn(line, value);
    if (got === null) continue;
    if (same(got, value)) return got;
    if (best === null || got !== "") best = got;
  }
  return best;
}

/** One of the station's items. One it never sent, as a QSO stopped early,
 *  has nothing to check. */
function theirRow(lines: readonly TheirLine[], label: string, value: string): ReportRow {
  const sent = lines.some((l) => copiedIn({ text: l.text, typed: "" }, value) !== null);
  if (!sent) return { from: "them", label, sent: "", copied: null, ok: null };
  const copied = copiedOf(lines, value);
  return { from: "them", label, sent: value, copied, ok: copied === null ? null : same(copied, value) };
}

function yourRow(label: string, meant: string, took: string, check = true): ReportRow {
  return { from: "you", label, sent: meant, copied: took, ok: check && meant ? same(took, meant) : null };
}

/** The station's items in a rag chew, with the report as it sent it. */
function chatRows(qso: Qso, lines: readonly TheirLine[], me: Meant): ReportRow[] {
  const { them } = qso;
  // 599 goes out as 5NN now and then: whichever its lines hold.
  const rst = lines.some((l) => l.text.split(/\s+/).includes("5NN")) && them.rst === "599" ? "5NN" : them.rst;
  return [
    theirRow(lines, "Call", them.call),
    theirRow(lines, "Report", rst),
    theirRow(lines, "Name", them.name),
    theirRow(lines, "QTH", them.qth),
    yourRow("Call", me.call, qso.you),
    yourRow("Report", "", qso.yourReport ?? "", false),
    yourRow("Name", me.name, qso.yourName),
    yourRow("QTH", me.qth, qso.yourQth ?? ""),
  ];
}

/** The items of a run's exchange, both ways. */
function runRows(qso: RunQso, lines: readonly TheirLine[], me: Meant): ReportRow[] {
  const { them, format } = qso;
  const got = qso.got ?? { name: "", number: "", region: "", report: "" };
  const st = regionOf(them);
  const rows: ReportRow[] = [theirRow(lines, "Call", them.call)];
  switch (format) {
    case "cwt":
      rows.push(theirRow(lines, "Name", them.name));
      rows.push(them.nr ? theirRow(lines, "Number", them.nr) : theirRow(lines, "State", st));
      break;
    case "sst":
      rows.push(theirRow(lines, "Name", them.name), theirRow(lines, "State", st));
      break;
    case "mst":
      rows.push(theirRow(lines, "Name", them.name), theirRow(lines, "Number", String(them.serial ?? 1)));
      break;
    case "pota":
      rows.push(theirRow(lines, "Report", them.rst.replace(/9/g, "N")), theirRow(lines, "State", st));
      break;
  }
  rows.push(yourRow("Call", me.call, qso.you));
  for (const item of FORMATS[format].yours) {
    if (item === "name") rows.push(yourRow("Name", me.name, got.name));
    if (item === "report") rows.push(yourRow("Report", "", got.report, false));
    if (item === "region") rows.push(yourRow("State", me.region, got.region));
    if (item === "number" && format === "mst") rows.push(yourRow("Number", String(qso.made + 1), got.number));
    if (item === "number" && format === "cwt") {
      rows.push(
        me.nr || !me.region
          ? yourRow("Number", me.nr, got.number || got.region)
          : yourRow("State", me.region, got.region || got.number),
      );
    }
  }
  return rows;
}

/** The exchange of `qso`, item by item, both ways. A QSO stopped before the
 *  station took any of your exchange has nothing of yours to check: you may
 *  not have sent it. */
export function exchangeReport(qso: AnyQso, lines: readonly TheirLine[], me: Meant): ReportRow[] {
  const rows = isRun(qso) ? runRows(qso, lines, me) : chatRows(qso, lines, me);
  const early = isRun(qso) ? qso.stage !== "exchanged" : ["cq", "asking", "called"].includes(qso.stage);
  const none = rows.every((r) => r.from !== "you" || r.label === "Call" || !r.copied);
  if (!early || !none) return rows;
  return rows.map((r) => (r.from === "you" && r.label !== "Call" ? { ...r, copied: null, ok: null } : r));
}
