// Parser and evaluator for a plugin's `when` expression.
// Grammar: or := and ("or" and)* ; and := not ("and" not)* ; not := "not" not | cmp ;
// cmp := atom (("<"|"<="|">"|">="|"=="|"!=") number)? ; atom := name | true | false | "(" or ")".
// Evaluation uses Kleene three-valued logic, which is monotone: a definite result
// computed while some checks are still unknown cannot change once they resolve.
// The planner relies on that to skip expensive checks.

import type { Signal, Tri } from "./types.ts";

export type Expr =
  | { t: "lit"; v: boolean }
  | { t: "ref"; name: string }
  | { t: "cmp"; name: string; op: CmpOp; n: number }
  | { t: "not"; e: Expr }
  | { t: "and" | "or"; l: Expr; r: Expr };

type CmpOp = "<" | "<=" | ">" | ">=" | "==" | "!=";

const MAX_EXPR_CHARS = 2000;
const TOKEN_RE = /\s*(?:(\()|(\))|(<=|>=|==|!=|<|>)|(-?\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*))/y;

export class ExprError extends Error {}

export function parseExpr(source: string): Expr {
  if (source.length > MAX_EXPR_CHARS) throw new ExprError(`expression longer than ${MAX_EXPR_CHARS} chars`);
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const parseOr = (): Expr => {
    let left = parseAnd();
    while (peek() === "or") {
      next();
      left = { t: "or", l: left, r: parseAnd() };
    }
    return left;
  };
  const parseAnd = (): Expr => {
    let left = parseNot();
    while (peek() === "and") {
      next();
      left = { t: "and", l: left, r: parseNot() };
    }
    return left;
  };
  const parseNot = (): Expr => {
    if (peek() === "not") {
      next();
      return { t: "not", e: parseNot() };
    }
    return parseCmp();
  };
  const parseCmp = (): Expr => {
    const atom = parseAtom();
    const op = peek();
    if (op && isCmpOp(op)) {
      next();
      if (atom.t !== "ref") throw new ExprError(`'${op}' needs a check name on its left`);
      const num = next();
      if (num === undefined || !/^-?\d/.test(num)) throw new ExprError(`'${op}' needs a number on its right`);
      return { t: "cmp", name: atom.name, op, n: Number(num) };
    }
    return atom;
  };
  const parseAtom = (): Expr => {
    const tok = next();
    if (tok === undefined) throw new ExprError("expression ends too early");
    if (tok === "(") {
      const inner = parseOr();
      if (next() !== ")") throw new ExprError("missing ')'");
      return inner;
    }
    if (tok === "true" || tok === "false") return { t: "lit", v: tok === "true" };
    if (/^[A-Za-z_]/.test(tok) && !KEYWORDS.has(tok)) return { t: "ref", name: tok };
    throw new ExprError(`unexpected '${tok}'`);
  };

  const expr = parseOr();
  if (pos !== tokens.length) throw new ExprError(`unexpected '${tokens[pos]}'`);
  return expr;
}

const KEYWORDS = new Set(["and", "or", "not", "true", "false"]);

function isCmpOp(tok: string): tok is CmpOp {
  return tok === "<" || tok === "<=" || tok === ">" || tok === ">=" || tok === "==" || tok === "!=";
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  TOKEN_RE.lastIndex = 0;
  let index = 0;
  while (index < source.length) {
    if (/^\s*$/.test(source.slice(index))) break;
    TOKEN_RE.lastIndex = index;
    const m = TOKEN_RE.exec(source);
    if (!m) throw new ExprError(`cannot read expression at '${source.slice(index, index + 12)}'`);
    tokens.push((m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]) as string);
    index = TOKEN_RE.lastIndex;
  }
  if (tokens.length === 0) throw new ExprError("empty expression");
  return tokens;
}

/** Every check name an expression refers to. */
export function exprRefs(expr: Expr, out = new Set<string>()): Set<string> {
  switch (expr.t) {
    case "ref":
    case "cmp":
      out.add(expr.name);
      break;
    case "not":
      exprRefs(expr.e, out);
      break;
    case "and":
    case "or":
      exprRefs(expr.l, out);
      exprRefs(expr.r, out);
      break;
  }
  return out;
}

/**
 * Evaluates with missing or unknown signals as null.
 * A bare score reference is unknown; validation rejects that shape up front.
 */
export function evalExpr(expr: Expr, signals: Readonly<Record<string, Signal | undefined>>): Tri {
  switch (expr.t) {
    case "lit":
      return expr.v;
    case "ref": {
      const v = signals[expr.name]?.value;
      return typeof v === "boolean" ? v : null;
    }
    case "cmp": {
      const v = signals[expr.name]?.value;
      return typeof v === "number" ? compare(v, expr.op, expr.n) : null;
    }
    case "not": {
      const v = evalExpr(expr.e, signals);
      return v === null ? null : !v;
    }
    case "and": {
      const l = evalExpr(expr.l, signals);
      if (l === false) return false;
      const r = evalExpr(expr.r, signals);
      if (r === false) return false;
      return l === true && r === true ? true : null;
    }
    case "or": {
      const l = evalExpr(expr.l, signals);
      if (l === true) return true;
      const r = evalExpr(expr.r, signals);
      if (r === true) return true;
      return l === false && r === false ? false : null;
    }
  }
}

function compare(v: number, op: CmpOp, n: number): boolean {
  switch (op) {
    case "<":
      return v < n;
    case "<=":
      return v <= n;
    case ">":
      return v > n;
    case ">=":
      return v >= n;
    case "==":
      return v === n;
    case "!=":
      return v !== n;
  }
}
