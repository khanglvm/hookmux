// Static checks on a `when` expression: it parses, names only declared checks,
// uses boolean checks bare and score checks only inside comparisons.

import { getCheck } from "../checks/registry.ts";
import { type Expr, ExprError, parseExpr } from "../core/expr.ts";
import type { CheckSpec } from "../core/types.ts";

export function evalExprShape(label: string, source: string, checks: Record<string, CheckSpec>): string[] {
  let expr: Expr;
  try {
    expr = parseExpr(source);
  } catch (error) {
    return [`${label}: ${error instanceof ExprError ? error.message : String(error)}`];
  }
  const problems: string[] = [];
  const visit = (e: Expr): void => {
    if (e.t === "ref" || e.t === "cmp") {
      const spec = checks[e.name];
      if (!spec) {
        problems.push(`${label}: '${e.name}' is not a declared check`);
        return;
      }
      const output = getCheck(spec.kind)?.output;
      if (e.t === "ref" && output === "score")
        problems.push(`${label}: '${e.name}' is a score; compare it, e.g. ${e.name} >= 0.7`);
      if (e.t === "cmp" && output === "bool")
        problems.push(`${label}: '${e.name}' is true/false; use it without a comparison`);
    } else if (e.t === "not") visit(e.e);
    else if (e.t === "and" || e.t === "or") {
      visit(e.l);
      visit(e.r);
    }
  };
  visit(expr);
  return problems;
}
