// Rejects regex patterns with the shape that backtracks exponentially in
// JavaScript's engine: a repeated group whose body already repeats, such as
// (a+)+, (a*)* or (\w+\s?)+. This is a heuristic over the pattern text, not a
// proof: it misses some slow patterns and refuses some safe ones. The real
// guarantee is the launcher's watchdog, which kills a hook run that hangs.

interface GroupFrame {
  /** True when something inside the group repeats without an upper bound. */
  repeats: boolean;
}

/** True when the pattern repeats a group that contains an unbounded repetition. */
export function hasNestedRepetition(source: string): boolean {
  const stack: GroupFrame[] = [{ repeats: false }];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    const top = stack[stack.length - 1] as GroupFrame;
    if (ch === "\\") {
      i = afterAtom(source, i + 2, top);
    } else if (ch === "[") {
      i = afterAtom(source, skipClass(source, i + 1), top);
    } else if (ch === "(") {
      stack.push({ repeats: false });
      i = skipGroupPrefix(source, i + 1);
    } else if (ch === ")") {
      const inner = stack.length > 1 ? (stack.pop() as GroupFrame) : { repeats: false };
      const parent = stack[stack.length - 1] as GroupFrame;
      const quantifier = readQuantifier(source, i + 1);
      if (quantifier.unbounded && inner.repeats) return true;
      parent.repeats ||= inner.repeats || quantifier.unbounded;
      i = quantifier.end;
    } else {
      i = afterAtom(source, i + 1, top);
    }
  }
  return false;
}

/** Reads the quantifier after an atom ending at `end`, marks the frame and returns where scanning resumes. */
function afterAtom(source: string, end: number, frame: GroupFrame): number {
  const quantifier = readQuantifier(source, end);
  if (quantifier.unbounded) frame.repeats = true;
  return quantifier.end;
}

/** `*`, `+` and `{n,}` repeat without bound; `?`, `{n}` and `{n,m}` do not. A lazy `?` suffix is skipped. */
function readQuantifier(source: string, at: number): { unbounded: boolean; end: number } {
  const ch = source[at];
  let unbounded = false;
  let end = at;
  if (ch === "*" || ch === "+") {
    unbounded = true;
    end = at + 1;
  } else if (ch === "?") {
    end = at + 1;
  } else if (ch === "{") {
    const match = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(at));
    if (match) {
      unbounded = match[2] !== undefined && match[3] === "";
      end = at + match[0].length;
    }
  }
  if (end > at && source[end] === "?") end++;
  return { unbounded, end };
}

/** Index just past the `]` closing a character class that starts at `at`. */
function skipClass(source: string, at: number): number {
  let i = at;
  if (source[i] === "]") i++;
  while (i < source.length && source[i] !== "]") i += source[i] === "\\" ? 2 : 1;
  return i + 1;
}

/** Skips `?:`, `?=`, `?!`, `?<=`, `?<!` and `?<name>` after an opening parenthesis. */
function skipGroupPrefix(source: string, at: number): number {
  if (source[at] !== "?") return at;
  const match = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(source.slice(at));
  return match ? at + match[0].length : at + 1;
}
