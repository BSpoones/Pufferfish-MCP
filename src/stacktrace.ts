/**
 * Compacts Java stack traces inside console/log text before it reaches the model.
 *
 * A Minecraft crash or plugin exception routinely drags in dozens of `at ...` frames that are
 * pure framework plumbing (Netty's event loop, the JDK's own internals, Mixin's transformer,
 * the mod-loader bootstrap) plus, in a crash storm, the SAME trace repeated on every tick. None
 * of that is what a caller reading a console dump is looking for - the two things that matter
 * are the exception type/message and the first few frames that are actually application code
 * (a plugin, a mod, net.minecraft.* game logic). This never removes information a caller can't
 * get back on request (raw output is still one `full: true`/no-compaction call away wherever
 * this is wired in) - it only reorders what's expensive against what's useful by default.
 */

/** Prefixes treated as noise: framework/bootstrap plumbing that is (almost) never the actual bug. */
const DEFAULT_NOISY_PREFIXES = [
  "java.base/",
  "java.lang.",
  "java.util.concurrent.",
  "java.util.stream.",
  "jdk.internal.",
  "sun.nio.",
  "sun.reflect.",
  "io.netty.",
  "kotlinx.coroutines.",
  "org.spongepowered.asm.mixin.",
  "org.spongepowered.tools.",
  "cpw.mods.modlauncher.",
  "cpw.mods.cl.",
  "net.minecraftforge.fml.loading.",
  "net.minecraftforge.fml.core.",
  "net.fabricmc.loader.",
];

/** Matches a Java stack-trace frame line, e.g. `\tat com.foo.Bar.baz(Bar.java:42)`. */
const FRAME_RE = /^(\s*)at\s+(\S+)\(/;
/** Matches the JVM's own "... N more" elision line at the end of a `Caused by` chain. */
const MORE_RE = /^\s*\.\.\.\s+\d+\s+more\s*$/;
/** Starts a NEW trace block - a bare exception header, with no `Caused by:` prefix. */
const TRACE_HEADER_RE = /^(\s*)[\w$.]+(Exception|Error|Throwable)\b.*$/;
/**
 * Continues the CURRENT block - a `Caused by:` line chained onto the trace already being read.
 * Kept distinct from TRACE_HEADER_RE: an independent trace that happens to immediately follow
 * another (no plain log line between them, as in a crash storm) must start its OWN block, not
 * get swallowed into the previous one just because it also matches "looks like an exception".
 */
const CAUSED_BY_RE = /^(\s*)Caused by:\s*.*$/;

export interface CompactOptions {
  /** Extra prefixes to treat as noise, in addition to the built-in framework list. */
  extraNoisyPrefixes?: string[];
  /** Consecutive noisy frames shorter than this are left alone - not worth losing minor context for. */
  elideThreshold?: number;
  /** How many times a repeated trace signature may appear in full before later ones collapse. */
  keepFullOccurrences?: number;
}

function isNoisyFrame(methodRef: string, noisyPrefixes: string[]): boolean {
  return noisyPrefixes.some((p) => methodRef.startsWith(p));
}

/**
 * Collapses runs of consecutive noisy frames within ONE trace into a single summary line.
 * Application frames (a plugin, a mod, `net.minecraft.*` game code) are always kept verbatim -
 * this only ever removes lines that matched a noisy prefix.
 */
function collapseNoisyRuns(lines: string[], noisyPrefixes: string[], elideThreshold: number): string[] {
  const out: string[] = [];
  let run: { indent: string; lines: string[] } | null = null;

  const flush = () => {
    if (!run) return;
    if (run.lines.length >= elideThreshold) {
      out.push(`${run.indent}... ${run.lines.length} frame(s) elided (framework/bootstrap internals)`);
    } else {
      // Below the threshold, genuinely not worth summarising - keep the original lines verbatim.
      out.push(...run.lines);
    }
    run = null;
  };

  for (const line of lines) {
    const frame = FRAME_RE.exec(line);
    if (frame && isNoisyFrame(frame[2], noisyPrefixes)) {
      const indent = frame[1];
      if (run && run.indent === indent) run.lines.push(line);
      else {
        flush();
        run = { indent, lines: [line] };
      }
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out;
}

/** First exception line + first two real (non-elided) frames - enough to fingerprint a repeat without false-merging distinct traces that happen to share a type. */
function traceSignature(block: string[]): string {
  const header = block[0] ?? "";
  const frames = block.filter((l) => FRAME_RE.test(l)).slice(0, 2);
  return [header.trim(), ...frames.map((f) => f.trim())].join(" | ");
}

/**
 * Splits text into alternating "plain log" and "stack trace block" segments. A block starts at
 * a bare exception header and continues through consecutive frame / `... N more` / `Caused by:`
 * lines - it ends at the first line that is none of those, INCLUDING a fresh bare exception
 * header (that starts its own new block, rather than being swallowed as a false "Caused by").
 */
function splitBlocks(lines: string[]): Array<{ isTrace: boolean; lines: string[] }> {
  const segments: Array<{ isTrace: boolean; lines: string[] }> = [];
  let i = 0;
  while (i < lines.length) {
    if (TRACE_HEADER_RE.test(lines[i])) {
      const block: string[] = [lines[i]];
      i++;
      while (i < lines.length && (FRAME_RE.test(lines[i]) || MORE_RE.test(lines[i]) || CAUSED_BY_RE.test(lines[i]))) {
        block.push(lines[i]);
        i++;
      }
      segments.push({ isTrace: true, lines: block });
      continue;
    }
    const plain: string[] = [];
    while (i < lines.length && !TRACE_HEADER_RE.test(lines[i])) {
      plain.push(lines[i]);
      i++;
    }
    segments.push({ isTrace: false, lines: plain });
  }
  return segments;
}

/**
 * Compacts every stack trace found in `text`:
 *  - noisy framework frames within a trace collapse to one summary line per run
 *  - a trace whose signature (exception + first frames) repeats beyond `keepFullOccurrences`
 *    collapses entirely to a one-line reference back to the first full occurrence
 * Non-trace lines pass through completely untouched.
 */
export function compactStackTraces(text: string, opts: CompactOptions = {}): string {
  if (!text) return text;
  const noisyPrefixes = [...DEFAULT_NOISY_PREFIXES, ...(opts.extraNoisyPrefixes ?? [])];
  const elideThreshold = opts.elideThreshold ?? 3;
  const keepFull = opts.keepFullOccurrences ?? 1;

  const lines = text.split("\n");
  const segments = splitBlocks(lines);
  const seen = new Map<string, number>();
  const out: string[] = [];

  for (const seg of segments) {
    if (!seg.isTrace) {
      out.push(...seg.lines);
      continue;
    }
    const sig = traceSignature(seg.lines);
    const count = (seen.get(sig) ?? 0) + 1;
    seen.set(sig, count);
    if (count > keepFull) {
      out.push(`${seg.lines[0].trim()}  [duplicate of an earlier trace - seen ${count}x, collapsed]`);
      continue;
    }
    out.push(...collapseNoisyRuns(seg.lines, noisyPrefixes, elideThreshold));
  }
  return out.join("\n");
}
