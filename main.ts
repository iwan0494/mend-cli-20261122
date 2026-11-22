// mend: one patch tool for every AI edit format.
//
// Reads a patch in unified diff, SEARCH/REPLACE, V4A or JSON form and
// applies it to the tree in the working directory, all or nothing, as
// SPEC.md (version 1) says. Node 22, standard library only.
//
// The working directory is the root of the tree. Every check runs
// `node main.ts [arguments]` once there and compares the exit code,
// everything on stdout and every file afterwards.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// A parse problem: the whole run ends with exit 2 and this one line.
class ParseProblem {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

// One edit that could not be applied: reported on exit 1.
class ApplyProblem {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

const isBlank = (s: string): boolean => s.trim() === '';

// A patch's lines: split at \n, one trailing \r removed from each, and
// the empty piece after a final \n dropped. Line numbers count from 1.
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const out = text.split('\n');
  if (text.endsWith('\n')) out.pop();
  return out.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

const stripTrailingWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

// ---- file text as lines -------------------------------------------------

interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function readState(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const firstNl = text.indexOf('\n');
  const br = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function writeState(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.finalBreak ? st.br : '');
}

function linesToText(lines: string[], br: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

// ---- line matching, SPEC section 5 --------------------------------------

function lineMatchesAt(fileLine: string, patLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === patLine;
  if (tier === 1) return stripTrailingWs(fileLine) === stripTrailingWs(patLine);
  return stripBothWs(fileLine) === stripBothWs(patLine);
}

// Positions at or after `from` where `pat` occurs in `lines` at `tier`.
function occurrencesAt(lines: string[], pat: string[], tier: number, from = 0): number[] {
  const found: number[] = [];
  if (pat.length === 0) return found;
  for (let i = from; i + pat.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < pat.length; j += 1) {
      if (!lineMatchesAt(lines[i + j]!, pat[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

// The first tier (0, then 1, then 2; only 0 when strict) at which `pat`
// occurs at least once at or after `from`, with its positions.
function firstTier(
  lines: string[],
  pat: string[],
  strict: boolean,
  from = 0,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrencesAt(lines, pat, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// One line of a replacement: a context line is written as the file's own
// matched line; any other line may be re-indented at tier 2.
interface NewLine {
  text: string;
  context: boolean;
  oldIndex: number;
}

function buildReplacement(
  fileLines: string[],
  at: number,
  oldLines: string[],
  fresh: NewLine[],
  tier: number,
): string[] {
  const out: string[] = [];
  const firstOld = oldLines.length > 0 ? oldLines[0]! : '';
  const pfx = leadingWs(firstOld);
  const fpfx = oldLines.length > 0 ? leadingWs(fileLines[at] ?? '') : '';
  for (const item of fresh) {
    if (item.context) {
      out.push(fileLines[at + item.oldIndex] ?? item.text);
      continue;
    }
    let text = item.text;
    if (tier === 2 && text !== '' && text.trim() !== '' && text.startsWith(pfx)) {
      text = fpfx + text.slice(pfx.length);
    }
    out.push(text);
  }
  return out;
}

// ---- the tree edits leave behind ----------------------------------------

class WorkTree {
  private readonly seen = new Map<string, string | null>();
  readonly pending = new Map<string, string | null>();

  before(p: string): string | null {
    if (!this.seen.has(p)) {
      let value: string | null = null;
      try {
        if (statSync(p).isFile()) value = readFileSync(p, 'utf8');
      } catch {
        value = null;
      }
      this.seen.set(p, value);
    }
    return this.seen.get(p)!;
  }

  current(p: string): string | null {
    return this.pending.has(p) ? this.pending.get(p)! : this.before(p);
  }
}

interface WorkEdit {
  // Every path the edit names, old before new, as the patch wrote them
  // (after the prefix section 6 removes). All are safety-checked first.
  paths: string[];
  // A move edit's [old, new]; null otherwise.
  move: [string, string] | null;
  apply: (tree: WorkTree) => void;
}

function checkPaths(paths: string[]): void {
  for (const p of paths) {
    if (!isSafePath(p)) throw new ApplyProblem('unsafe', p);
  }
}

// Replace `oldLines` at `at` in `state` by the replacement lines, keeping
// the file's line break and final break.
function spliceState(state: FileState, at: number, oldLen: number, replacement: string[]): FileState {
  const lines = [...state.lines.slice(0, at), ...replacement, ...state.lines.slice(at + oldLen)];
  return { lines, br: state.br, finalBreak: state.finalBreak };
}

// ---- JSON edits, SPEC section 9 -----------------------------------------

type JsonObject = Record<string, unknown>;

function jsonEditFrom(value: unknown): WorkEdit | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as JsonObject;
  if (typeof obj.path !== 'string') return null;
  const path = obj.path;
  if (obj.command === 'create' && typeof obj.file_text === 'string') {
    const text = obj.file_text;
    return {
      paths: [path],
      move: null,
      apply: (tree) => {
        checkPaths([path]);
        if (tree.current(path) !== null) throw new ApplyProblem('exists', path);
        tree.pending.set(path, text);
      },
    };
  }
  if (
    obj.command === 'str_replace' &&
    typeof obj.old_str === 'string' &&
    obj.old_str !== '' &&
    (obj.new_str === undefined || typeof obj.new_str === 'string')
  ) {
    const oldStr = obj.old_str;
    const newStr = (obj.new_str as string | undefined) ?? '';
    return {
      paths: [path],
      move: null,
      apply: (tree) => {
        checkPaths([path]);
        const before = tree.current(path);
        if (before === null) throw new ApplyProblem('missing', path);
        const nl = before.indexOf('\n');
        const crlf = nl > 0 && before[nl - 1] === '\r';
        const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
        const text = toLf(before);
        const old = toLf(oldStr);
        let count = 0;
        for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
        if (count === 0) throw new ApplyProblem('no-match', path);
        if (count > 1) throw new ApplyProblem('ambiguous', path);
        const at = text.indexOf(old);
        const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
        tree.pending.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
      },
    };
  }
  if (
    obj.command === 'insert' &&
    typeof obj.insert_line === 'number' &&
    Number.isInteger(obj.insert_line) &&
    typeof obj.new_str === 'string'
  ) {
    const atLine = obj.insert_line;
    const added = splitPatch(obj.new_str);
    return {
      paths: [path],
      move: null,
      apply: (tree) => {
        checkPaths([path]);
        const before = tree.current(path);
        if (before === null) throw new ApplyProblem('missing', path);
        const state = readState(before);
        if (atLine < 0 || atLine > state.lines.length) throw new ApplyProblem('no-match', path);
        const lines = [...state.lines];
        lines.splice(atLine, 0, ...added);
        tree.pending.set(path, writeState({ lines, br: state.br, finalBreak: state.finalBreak }));
      },
    };
  }
  return null;
}

function parseJsonEdits(text: string, lines: string[]): WorkEdit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseProblem('error: parse 1');
  const edits: WorkEdit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseProblem(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(parsed)) throw new ParseProblem(`error: parse ${first + 1}`);
    for (const item of parsed) {
      const edit = jsonEditFrom(item);
      if (edit === null) throw new ParseProblem(`error: parse ${first + 1}`);
      edits.push(edit);
    }
    return edits;
  }
  lines.forEach((line, i) => {
    if (isBlank(line)) return;
    let edit: WorkEdit | null = null;
    try {
      edit = jsonEditFrom(JSON.parse(line));
    } catch {
      edit = null;
    }
    if (edit === null) throw new ParseProblem(`error: parse ${i + 1}`);
    edits.push(edit);
  });
  return edits;
}

// ---- unified diffs, SPEC section 6 --------------------------------------

interface HunkEntry {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  slash: boolean;
  rawBlank: boolean;
}

interface Hunk {
  a: number;
  oldLines: string[];
  fresh: NewLine[];
  hasCtxOrAdd: boolean;
  lastCtxAddSlash: boolean;
  lastAddSlash: boolean;
}

interface RawSection {
  diffOld: string | undefined;
  diffNew: string | undefined;
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  dashSeen: boolean;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string | null {
  let raw = line.slice(4);
  const tab = raw.indexOf('\t');
  if (tab >= 0) raw = raw.slice(0, tab);
  raw = raw.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) raw = raw.slice(2);
  return raw;
}

function parseDiffGit(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) return null;
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@( .*|$)/;

function collectBody(lines: string[], start: number): { entries: HunkEntry[]; next: number } {
  const entries: HunkEntry[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      entries.push({ kind: 'ctx', text: '', slash: false, rawBlank: true });
      j += 1;
      continue;
    }
    if (l[0] === ' ') {
      entries.push({ kind: 'ctx', text: l.slice(1), slash: false, rawBlank: false });
      j += 1;
      continue;
    }
    if (l[0] === '-') {
      entries.push({ kind: 'del', text: l.slice(1), slash: false, rawBlank: false });
      j += 1;
      continue;
    }
    if (l[0] === '+') {
      entries.push({ kind: 'add', text: l.slice(1), slash: false, rawBlank: false });
      j += 1;
      continue;
    }
    if (l[0] === '\\') {
      if (entries.length > 0) entries[entries.length - 1]!.slash = true;
      j += 1;
      continue;
    }
    break;
  }
  while (entries.length > 0 && entries[entries.length - 1]!.rawBlank) entries.pop();
  return { entries, next: j };
}

function makeHunk(a: number, entries: HunkEntry[]): Hunk {
  const oldLines: string[] = [];
  const fresh: NewLine[] = [];
  for (const e of entries) {
    if (e.kind === 'ctx') {
      fresh.push({ text: e.text, context: true, oldIndex: oldLines.length });
      oldLines.push(e.text);
    } else if (e.kind === 'del') {
      oldLines.push(e.text);
    } else {
      fresh.push({ text: e.text, context: false, oldIndex: -1 });
    }
  }
  let hasCtxOrAdd = false;
  let lastCtxAddSlash = false;
  let lastAddSlash = false;
  for (const e of entries) {
    if (e.kind === 'ctx' || e.kind === 'add') {
      hasCtxOrAdd = true;
      lastCtxAddSlash = e.slash;
    }
    if (e.kind === 'add') lastAddSlash = e.slash;
  }
  return { a, oldLines, fresh, hasCtxOrAdd, lastCtxAddSlash, lastAddSlash };
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let state = readState(text);
  let d = 0;
  for (const hunk of hunks) {
    if (hunk.oldLines.length > 0) {
      const found = firstTier(state.lines, hunk.oldLines, strict, 0);
      if (found === null) throw new ApplyProblem('no-match', path);
      const target = hunk.a - 1 + d;
      let best = found.positions[0]!;
      for (const pos of found.positions) {
        if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      }
      const replacement = buildReplacement(state.lines, best, hunk.oldLines, hunk.fresh, found.tier);
      let finalBreak = state.finalBreak;
      if (best + hunk.oldLines.length === state.lines.length) {
        finalBreak = hunk.hasCtxOrAdd ? !hunk.lastCtxAddSlash : true;
      }
      const spliced = spliceState(state, best, hunk.oldLines.length, replacement);
      state = { lines: spliced.lines, br: spliced.br, finalBreak };
    } else {
      const at = Math.min(Math.max(hunk.a + d, 0), state.lines.length);
      const replacement = hunk.fresh.map((f) => f.text);
      let finalBreak = state.finalBreak;
      if (at === state.lines.length && hunk.hasCtxOrAdd) finalBreak = !hunk.lastCtxAddSlash;
      const spliced = spliceState(state, at, 0, replacement);
      state = { lines: spliced.lines, br: spliced.br, finalBreak };
    }
    d += hunk.fresh.length - hunk.oldLines.length;
  }
  return writeState(state);
}

function sectionToEdit(sec: RawSection, strict: boolean): WorkEdit {
  const oldPath = sec.dashOld !== undefined ? sec.dashOld : sec.renameOld !== undefined ? sec.renameOld : sec.diffOld;
  const newPath = sec.dashNew !== undefined ? sec.dashNew : sec.renameNew !== undefined ? sec.renameNew : sec.diffNew;
  const isCreate = oldPath === null || sec.createFlag;
  const isDelete = newPath === null || sec.deleteFlag;
  if (isCreate) {
    const target = newPath ?? '';
    return {
      paths: [target],
      move: null,
      apply: (tree) => {
        checkPaths([target]);
        if (tree.current(target) !== null) throw new ApplyProblem('exists', target);
        const added: string[] = [];
        let lastAddSlash = false;
        for (const hunk of sec.hunks) {
          for (const e of hunk.fresh) {
            // Creation files hold only the + lines; context lines are ignored.
            if (!e.context) added.push(e.text);
          }
          if (hunk.fresh.some((f) => !f.context)) lastAddSlash = hunk.lastAddSlash;
        }
        const finalBreak = added.length === 0 ? false : !lastAddSlash;
        tree.pending.set(target, linesToText(added, '\n', finalBreak));
      },
    };
  }
  if (isDelete) {
    const target = oldPath ?? '';
    return {
      paths: [target],
      move: null,
      apply: (tree) => {
        checkPaths([target]);
        if (tree.current(target) === null) throw new ApplyProblem('missing', target);
        tree.pending.set(target, null);
      },
    };
  }
  if (oldPath !== undefined && newPath !== undefined && oldPath !== newPath) {
    const from = oldPath;
    const to = newPath;
    return {
      paths: [from, to],
      move: [from, to],
      apply: (tree) => {
        checkPaths([from, to]);
        const before = tree.current(from);
        if (before === null) throw new ApplyProblem('missing', from);
        if (tree.current(to) !== null) throw new ApplyProblem('exists', to);
        const result = applyHunks(before, sec.hunks, strict, from);
        tree.pending.set(from, null);
        tree.pending.set(to, result);
      },
    };
  }
  const target = (oldPath ?? newPath) ?? '';
  return {
    paths: [target],
    move: null,
    apply: (tree) => {
      checkPaths([target]);
      const before = tree.current(target);
      if (before === null) throw new ApplyProblem('missing', target);
      tree.pending.set(target, applyHunks(before, sec.hunks, strict, target));
    },
  };
}

function parseUnified(lines: string[], strict: boolean): WorkEdit[] {
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  let header = false;
  const begin = (diffOld?: string, diffNew?: string): RawSection => {
    if (cur !== null) sections.push(cur);
    cur = {
      diffOld,
      diffNew,
      dashOld: undefined,
      dashNew: undefined,
      renameOld: undefined,
      renameNew: undefined,
      dashSeen: false,
      createFlag: false,
      deleteFlag: false,
      hunks: [],
    };
    header = true;
    return cur;
  };
  const takePair = (sec: RawSection, i: number): void => {
    sec.dashOld = headerPath(lines[i]!);
    sec.dashNew = headerPath(lines[i + 1]!);
    sec.dashSeen = true;
  };
  const takeHunk = (i: number): { hunk: Hunk; next: number } => {
    const m = HUNK_HEAD.exec(lines[i]!);
    if (m === null) throw new ParseProblem(`error: parse ${i + 1}`);
    const body = collectBody(lines, i + 1);
    return { hunk: makeHunk(Number(m[1]), body.entries), next: body.next };
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const parsed = parseDiffGit(line);
      if (parsed === null) throw new ParseProblem(`error: parse ${i + 1}`);
      begin(parsed[0], parsed[1]);
      continue;
    }
    if (cur === null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const sec = begin();
        takePair(sec, i);
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) throw new ParseProblem(`error: parse ${i + 1}`);
      continue;
    }
    if (header) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        if (cur.dashSeen) {
          const sec = begin();
          takePair(sec, i);
          i += 1;
          continue;
        }
        takePair(cur, i);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ')) throw new ParseProblem(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.dashNew = headerPath(line);
        continue;
      }
      if (line.startsWith('@@')) {
        const { hunk, next } = takeHunk(i);
        cur.hunks.push(hunk);
        header = false;
        i = next - 1;
        continue;
      }
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.createFlag = true;
      else if (line.startsWith('deleted file mode')) cur.deleteFlag = true;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec = begin();
      takePair(sec, i);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const { hunk, next } = takeHunk(i);
      cur.hunks.push(hunk);
      i = next - 1;
      continue;
    }
  }
  if (cur !== null) sections.push(cur);
  if (sections.length === 0) throw new ParseProblem('error: parse 1');
  return sections.map((sec) => sectionToEdit(sec, strict));
}

// ---- SEARCH/REPLACE blocks, SPEC section 7 -------------------------------

function parseSearchReplace(lines: string[], strict: boolean): WorkEdit[] {
  const searches: number[] = [];
  lines.forEach((l, i) => {
    if (l.trimEnd() === '<<<<<<< SEARCH') searches.push(i);
  });
  if (searches.length === 0) throw new ParseProblem('error: parse 1');
  const edits: WorkEdit[] = [];
  let prevReplace = -1;
  let prevPath: string | undefined;
  for (const s of searches) {
    let path: string | undefined;
    for (let j = s - 1; j > prevReplace; j -= 1) {
      const candidate = lines[j]!;
      if (!isBlank(candidate) && !candidate.trim().startsWith('```')) {
        path = candidate.trim();
        break;
      }
    }
    if (path === undefined) {
      if (prevPath !== undefined) path = prevPath;
      else throw new ParseProblem(`error: parse ${s + 1}`);
    }
    let sep = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') throw new ParseProblem(`error: parse ${s + 1}`);
      if (lines[k]!.trimEnd() === '=======') {
        sep = k;
        break;
      }
    }
    if (sep < 0) throw new ParseProblem(`error: parse ${s + 1}`);
    let rep = -1;
    for (let k = sep + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new ParseProblem(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, sep);
    const newLines = lines.slice(sep + 1, rep);
    prevReplace = rep;
    prevPath = path;
    const target = path;
    edits.push({
      paths: [target],
      move: null,
      apply: (tree) => {
        checkPaths([target]);
        if (oldLines.length === 0) {
          if (tree.current(target) !== null) throw new ApplyProblem('exists', target);
          tree.pending.set(target, linesToText(newLines, '\n', newLines.length > 0));
          return;
        }
        const before = tree.current(target);
        if (before === null) throw new ApplyProblem('missing', target);
        const state = readState(before);
        const found = firstTier(state.lines, oldLines, strict, 0);
        if (found === null) throw new ApplyProblem('no-match', target);
        if (found.positions.length > 1) throw new ApplyProblem('ambiguous', target);
        const at = found.positions[0]!;
        const fresh: NewLine[] = newLines.map((text) => ({ text, context: false, oldIndex: -1 }));
        const replacement = buildReplacement(state.lines, at, oldLines, fresh, found.tier);
        const spliced = spliceState(state, at, oldLines.length, replacement);
        tree.pending.set(target, writeState(spliced));
      },
    });
  }
  return edits;
}

// ---- V4A patches, SPEC section 8 -----------------------------------------

interface ChunkBody {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

interface V4aChunk {
  anchor: string | null;
  body: ChunkBody[];
  eof: boolean;
}

function chunkOldFresh(body: ChunkBody[]): { oldLines: string[]; fresh: NewLine[] } {
  const oldLines: string[] = [];
  const fresh: NewLine[] = [];
  for (const e of body) {
    if (e.kind === 'ctx') {
      fresh.push({ text: e.text, context: true, oldIndex: oldLines.length });
      oldLines.push(e.text);
    } else if (e.kind === 'del') {
      oldLines.push(e.text);
    } else {
      fresh.push({ text: e.text, context: false, oldIndex: -1 });
    }
  }
  return { oldLines, fresh };
}

const isSectionStart = (line: string): boolean =>
  line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');

function parseV4a(lines: string[], strict: boolean): WorkEdit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseProblem('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseProblem(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseProblem(`error: parse ${lines.length + 1}`);
  const edits: WorkEdit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i += 1;
      const body: { text: string; num: number }[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        body.push({ text: lines[i]!, num: i + 1 });
        i += 1;
      }
      while (body.length > 0 && isBlank(body[body.length - 1]!.text)) body.pop();
      const fileLines: string[] = [];
      for (const entry of body) {
        if (entry.text === '') fileLines.push('');
        else if (entry.text.startsWith('+')) fileLines.push(entry.text.slice(1));
        else throw new ParseProblem(`error: parse ${entry.num}`);
      }
      edits.push({
        paths: [path],
        move: null,
        apply: (tree) => {
          checkPaths([path]);
          if (tree.current(path) !== null) throw new ApplyProblem('exists', path);
          tree.pending.set(path, linesToText(fileLines, '\n', fileLines.length > 0));
        },
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last && !isSectionStart(lines[i]!)) {
        if (!isBlank(lines[i]!)) throw new ParseProblem(`error: parse ${i + 1}`);
        i += 1;
      }
      edits.push({
        paths: [path],
        move: null,
        apply: (tree) => {
          checkPaths([path]);
          if (tree.current(path) === null) throw new ApplyProblem('missing', path);
          tree.pending.set(path, null);
        },
      });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateNum = i + 1;
      i += 1;
      let moveTo: string | undefined;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      while (i < last && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l === '*** End of File') {
          // It ends a chunk; with no chunk in progress there is nothing
          // to end, so it is not a line a section may hold.
          if (cur === null) throw new ParseProblem(`error: parse ${i + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
          i += 1;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          if (l === '') cur.body.push({ kind: 'ctx', text: '' });
          else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1) });
          else if (l[0] === '-') cur.body.push({ kind: 'del', text: l.slice(1) });
          else cur.body.push({ kind: 'add', text: l.slice(1) });
          i += 1;
          continue;
        }
        throw new ParseProblem(`error: parse ${i + 1}`);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length > 0) {
        const tail = chunks[chunks.length - 1]!;
        while (tail.body.length > 0) {
          const end = tail.body[tail.body.length - 1]!;
          if (end.kind === 'ctx' && end.text === '') tail.body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === undefined) throw new ParseProblem(`error: parse ${updateNum}`);
      const target = path;
      const dest = moveTo;
      edits.push({
        paths: dest === undefined ? [target] : [target, dest],
        move: dest === undefined ? null : [target, dest],
        apply: (tree) => {
          checkPaths(dest === undefined ? [target] : [target, dest]);
          const before = tree.current(target);
          if (before === null) throw new ApplyProblem('missing', target);
          if (dest !== undefined && tree.current(dest) !== null) throw new ApplyProblem('exists', dest);
          let state = readState(before);
          let cursor = 0;
          for (const chunk of chunks) {
            if (chunk.anchor !== null) {
              const anchorFound = firstTier(state.lines, [chunk.anchor], strict, cursor);
              if (anchorFound === null) throw new ApplyProblem('no-match', target);
              cursor = anchorFound.positions[0]! + 1;
            }
            const { oldLines, fresh } = chunkOldFresh(chunk.body);
            if (chunk.eof) {
              if (oldLines.length === 0) {
                const at = state.lines.length;
                const replacement = fresh.map((f) => f.text);
                const spliced = spliceState(state, at, 0, replacement);
                state = spliced;
                cursor = at + replacement.length;
              } else {
                let at: number | null = null;
                let tierFound = 0;
                for (const tier of strict ? [0] : [0, 1, 2]) {
                  const spots = occurrencesAt(state.lines, oldLines, tier, cursor).filter(
                    (p) => p + oldLines.length === state.lines.length,
                  );
                  if (spots.length > 0) {
                    at = spots[0]!;
                    tierFound = tier;
                    break;
                  }
                }
                if (at === null) throw new ApplyProblem('no-match', target);
                const replacement = buildReplacement(state.lines, at, oldLines, fresh, tierFound);
                const spliced = spliceState(state, at, oldLines.length, replacement);
                state = spliced;
                cursor = at + replacement.length;
              }
            } else if (oldLines.length === 0) {
              const at = Math.min(cursor, state.lines.length);
              const replacement = fresh.map((f) => f.text);
              const spliced = spliceState(state, at, 0, replacement);
              state = spliced;
              cursor = at + replacement.length;
            } else {
              const found = firstTier(state.lines, oldLines, strict, cursor);
              if (found === null) throw new ApplyProblem('no-match', target);
              const at = found.positions[0]!;
              const replacement = buildReplacement(state.lines, at, oldLines, fresh, found.tier);
              const spliced = spliceState(state, at, oldLines.length, replacement);
              state = spliced;
              cursor = at + replacement.length;
            }
          }
          const result = writeState(state);
          if (dest !== undefined) {
            tree.pending.set(target, null);
            tree.pending.set(dest, result);
          } else {
            tree.pending.set(target, result);
          }
        },
      });
      continue;
    }
    throw new ParseProblem(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new ParseProblem('error: parse 1');
  return edits;
}

// ---- format detection, SPEC section 4 ------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---- invocation, SPEC section 1 -------------------------------------------

interface Options {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseOptions(args: string[]): Options {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        throw new ParseProblem('error: usage');
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) throw new ParseProblem('error: usage');
  return {
    format: format ?? 'auto',
    check,
    strict,
    patch: pos.length === 0 || pos[0] === '-' ? null : pos[0]!,
  };
}

// ---- running the edits, SPEC sections 2 and 10 ----------------------------

function run(args: string[]): { code: number; out: string[] } {
  let opts: Options;
  try {
    opts = parseOptions(args);
  } catch (e) {
    if (e instanceof ParseProblem) return { code: 2, out: [e.line] };
    throw e;
  }
  let text = '';
  try {
    text = readFileSync(opts.patch ?? 0, 'utf8');
  } catch {
    if (opts.patch !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = opts.format === 'auto' ? detectFormat(lines) : opts.format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: WorkEdit[];
  try {
    if (kind === 'json') edits = parseJsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, opts.strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, opts.strict);
    else edits = parseV4a(lines, opts.strict);
    if (edits.length === 0) throw new ParseProblem('error: parse 1');
  } catch (e) {
    if (e instanceof ParseProblem) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new WorkTree();
  const fails: ApplyProblem[] = [];
  const moves: [string, string][] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.pending);
    const movesBefore = moves.length;
    try {
      edit.apply(tree);
      if (edit.move !== null) moves.push(edit.move);
    } catch (e) {
      if (!(e instanceof ApplyProblem)) throw e;
      tree.pending.clear();
      for (const [k, v] of snapshot) tree.pending.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const moved: [string, string][] = [];
  for (const pair of moves) {
    const wasOld = tree.before(pair[0]);
    const nowOld = tree.current(pair[0]);
    const wasNew = tree.before(pair[1]);
    const nowNew = tree.current(pair[1]);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) moved.push(pair);
  }
  const inMove = new Set<string>();
  for (const pair of moved) {
    inMove.add(pair[0]);
    inMove.add(pair[1]);
  }
  const rows: { key: string; text: string }[] = [];
  for (const p of tree.pending.keys()) {
    if (inMove.has(p)) continue;
    const was = tree.before(p);
    const now = tree.pending.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const pair of moved) rows.push({ key: pair[1], text: `R ${pair[0]} -> ${pair[1]}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!opts.check) {
    for (const p of tree.pending.keys()) {
      const was = tree.before(p);
      const now = tree.pending.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
