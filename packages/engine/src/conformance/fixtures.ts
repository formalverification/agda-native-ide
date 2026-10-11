// File: packages/engine/src/conformance/fixtures.ts
//
// The conformance suite's sources: small modules over Agda's builtins
// alone, so both engines read the same text and nothing else (the page's
// drive ships the builtins' interfaces; native Agda has its own).  Each
// exercises one thing the contract states: open goals and a `?`, Unicode
// outside the Basic Multilingual Plane before a goal on its line, a
// literate module whose prose holds goal-like text, a second module to
// switch to, and a slow normalization for the deadline.

export const LIBRARY = "name: conformance\ninclude: .\n";

export const GOALS = `module Goals where

open import Agda.Builtin.Nat
open import Agda.Builtin.Equality

identity : {A : Set} → A → A
identity x = {! !}

plus-zero : (n : Nat) → n + 0 ≡ n
plus-zero zero = refl
plus-zero (suc n) = ?
`;

export const SECOND = `module Second where

open import Agda.Builtin.Nat

data Colour : Set where
  red green : Colour

choose : Colour → Nat
choose c = {! !}
`;

export const UNICODE = `module Unicode where

data 𝔹 : Set where
  𝕥 𝕗 : 𝔹

not : 𝔹 → 𝔹
not 𝕥 = 𝕗
not 𝕗 = 𝕥

twice : (𝔹 → 𝔹) → 𝔹 → 𝔹
twice f 𝕓 = {! !}
`;

export const LITERATE = `# A literate module

Prose is not code, so \`{! !}\` and \`?\` here are not goals, and neither is ℕ.

\`\`\`agda
module Literate where

open import Agda.Builtin.Nat

double : Nat → Nat
double n = {! !}
\`\`\`

More prose.
`;

export const SLOW = `module Slow where

data N : Set where
  z : N
  s : N → N

_⊕_ : N → N → N
z ⊕ n = n
s m ⊕ n = s (m ⊕ n)

slow : N → N
slow z = s z
slow (s n) = slow n ⊕ slow n
`;

/** A term whose normal form takes Agda far longer than any deadline the
 * runners give it: slow doubles per successor. */
export const SLOW_TERM = `slow ${"(s ".repeat(40)}z${")".repeat(40)}`;

export const FIXTURES: Record<string, string> = {
  "conformance.agda-lib": LIBRARY,
  "Goals.agda": GOALS,
  "Second.agda": SECOND,
  "Unicode.agda": UNICODE,
  "Literate.lagda.md": LITERATE,
  "Slow.agda": SLOW,
};
