// File: packages/engine/src/core/give-rule.ts
//
// The give rule, the fork's `getFastGoalCheck` (src/lib/controller.svelte.ts
// at plfa-playground ae0aa84c) as a function of texts alone: a single edit
// wholly inside one live goal's braces, in the text before and the text
// after, that leaves the goal non-empty, is checked by Agda's
// `Cmd_give WithoutForce` for that goal; anything else (a declaration, an
// import, an edit spanning two goals, an edit outside every goal, a goal
// emptied, a goal's text that holds a hole's or a comment's delimiter)
// reloads the module.  The rule is conservative by construction: a give
// stands for exactly the edit it was taken for.

/** What a goal's text cannot hold for a give to stand for the edit: a
 * load would read these as new goals or comments, a give as a term. */
const DELIMITERS = ["{!", "!}", "{-", "-}", "--"];

/** A goal's span in a text, in UTF-16 offsets, braces included. */
export interface GoalSpan {
  id: number;
  from: number;
  to: number;
}

export type CheckPlan =
  | { kind: "unchanged" }
  | { kind: "give"; goal: number; expression: string; span: GoalSpan }
  | { kind: "load"; reason: string };

/** What a check of `next` must send, given the text Agda's live state
 * reflects (`previous`) and its live goals' spans in it. */
export function planCheck(previous: string, goals: readonly GoalSpan[], next: string): CheckPlan {
  let prefix = 0;
  const shortest = Math.min(previous.length, next.length);
  while (prefix < shortest && previous[prefix] === next[prefix]) prefix++;
  if (prefix === previous.length && prefix === next.length) return { kind: "unchanged" };

  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;

  const previousChangeEnd = previous.length - suffix;
  const nextChangeEnd = next.length - suffix;
  const delta = next.length - previous.length;

  for (const goal of goals) {
    const innerFrom = goal.from + 2;
    const previousInnerTo = goal.to - 2;
    const nextTo = goal.to + delta;
    const nextInnerTo = nextTo - 2;
    if (
      previous.slice(goal.from, innerFrom) !== "{!" ||
      previous.slice(previousInnerTo, goal.to) !== "!}" ||
      next.slice(goal.from, innerFrom) !== "{!" ||
      next.slice(nextInnerTo, nextTo) !== "!}" ||
      prefix < innerFrom ||
      previousChangeEnd > previousInnerTo ||
      nextChangeEnd > nextInnerTo
    )
      continue;
    const expression = next.slice(innerFrom, nextInnerTo).trim();
    if (!expression) return { kind: "load", reason: `the edit empties goal ${goal.id}` };
    const delimiter = DELIMITERS.find((mark) => expression.includes(mark));
    if (delimiter) return { kind: "load", reason: `goal ${goal.id}'s text holds ${delimiter}` };
    return { kind: "give", goal: goal.id, expression, span: { id: goal.id, from: goal.from, to: nextTo } };
  }
  return { kind: "load", reason: "the edit is not wholly inside one live goal" };
}
