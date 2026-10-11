// File: src/lib/agda/handlers.js
//
// Changed from upstream: this is SeungheonOh/plfa-playground's
// src/lib/agda/handlers.js at ae0aa84c24363a8d6dadc292b6eb8f88f7f38705
// (docs/provenance.md).  It applies Agda's answers to the editor: the
// highlighting, the goals, the running info, and the edits a give, a
// refine or a case split makes.  It takes each answer as the engine
// delivers it (@agda-native-ide/engine), validated, in Agda's own JSON,
// where it took the language server's messages from the router and
// decoded the server's own forms of them, which a server started with
// --raw never sends; the page's state is the controller's, from the
// engine's answers (issue 62).  The replacement a give or a case split
// makes is the engine's rule, so the editor and the engine's snapshot
// make the same edit.

import { caseSplitText, giveReplacement } from "@agda-native-ide/engine";

import { clearHighlight, clearRunningInfo, emitRunningInfo } from "./effects";
import { buildHighlightEffects } from "./highlight";
import { buildGoalTransaction, getAgdaGoalById } from "./goals";

/** @import { EditorView } from '@codemirror/view' */
/** @import { AgdaResponse, Command } from '@agda-native-ide/engine' */

/**
 * Apply one of Agda's answers to the editor.
 * @param {EditorView} view
 * @param {AgdaResponse} response
 * @param {Command} command  the command the answer is to
 */
export function applyAgdaResponse(view, response, command) {
  switch (response.kind) {
    case "ClearRunningInfo":
      view.dispatch({ effects: clearRunningInfo.of() });
      return;
    case "RunningInfo":
      view.dispatch({
        effects: emitRunningInfo.of({
          message: response.message,
          debugLevel: response.debugLevel,
        }),
      });
      return;
    case "ClearHighlighting":
      // Agda (~2.9)'s codebase has no instance of (Resp_ClearHighlighting
      // TokenBased); it clears what is not only token-based.
      if (response.tokenBased === "NotOnlyTokenBased")
        view.dispatch({ effects: clearHighlight.of(false) });
      return;
    case "HighlightingInfo":
      if (response.info.remove)
        view.dispatch({ effects: clearHighlight.of(true) });
      view.dispatch({
        effects: buildHighlightEffects(view.state, response.info.payload),
      });
      return;
    case "InteractionPoints":
      // A goal a give or a refine introduced has no range in the text
      // Agda loaded, so the editor cannot place it until the next load.
      view.dispatch(
        buildGoalTransaction(
          view.state,
          /** @type {Agda._InteractionPoint[]} */ (
            response.interactionPoints.filter((point) => point.range.length > 0)
          ),
        ),
      );
      return;
    case "GiveAction": {
      const goal = getAgdaGoalById(view.state, response.interactionPoint.id);
      if (!goal) return;
      const expression =
        command.kind === "give" || command.kind === "refine"
          ? command.expression
          : "";
      const replacement = giveReplacement(expression, response.giveResult);
      view.dispatch({
        changes: { from: goal.from, to: goal.to, insert: replacement },
        selection: { anchor: goal.from + replacement.length },
      });
      return;
    }
    case "MakeCase": {
      const goal = getAgdaGoalById(view.state, response.interactionPoint.id);
      if (!goal || response.clauses.length === 0) return;
      const line = view.state.doc.lineAt(goal.from);
      const source = caseSplitText(line.text, response.clauses);
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: source },
        selection: { anchor: line.from + source.length },
      });
      return;
    }
  }
}
