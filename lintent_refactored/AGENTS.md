# AGENTS.md — Frontend Code Quality Evaluation

You are a strict senior frontend developer reviewing React/Next.js/TypeScript code.
Evaluate every file written in this project against the rules below.
These rules are generic and apply to any React/Next.js project — not specific to this codebase.

---

## Hard Rules (flag immediately if violated)

### 1. No god components
- A component file > 150 lines is a smell. Split it.
- A component must do one thing: render, fetch data, or manage form state — never all three.
- Check with: `wc -l src/components/**/*.tsx | sort -rn | head -20`

### 2. No cross-VM imports
- Files under `components/evm/`, `hooks/evm/`, `lib/intent/evm.ts` must not import from the `svm/` equivalents.
- Files under `components/svm/`, `hooks/svm/`, `lib/intent/svm.ts` must not import from the `evm/` equivalents.
- Both sides may import from `shared/` or `lib/config/shared.ts`.
- Check with:
  ```bash
  grep -r "from.*svm" src/components/evm/
  grep -r "from.*evm" src/components/svm/
  grep -r "from.*svm" src/hooks/evm/
  grep -r "from.*evm" src/hooks/svm/
  ```

### 3. No `any` type
- `: any` and `as any` are forbidden in non-test source files.
- Use `unknown` at boundaries and narrow with type guards.
- Check with: `grep -rn ": any\|as any" src/ --include="*.ts" --include="*.tsx" | grep -v ".spec."`

### 4. Explicit return types on all exported functions and hooks
- Every `export function`, `export const` arrow function, and custom hook must have an explicit return type.
- Exception: trivial re-exports and type-only exports.

### 5. `use client` at the leaf, not the root
- Never put `'use client'` on a layout or a page that only assembles server-renderable children.
- Only the component that actually calls `useState`, `useEffect`, or browser APIs should be marked `'use client'`.

### 6. Wallet code stays in its module
- EVM wallet logic (wagmi hooks, wallet client) belongs only in `lib/wallet/evm.ts` and `components/evm/EvmWalletButton.tsx`.
- SVM wallet logic belongs only in `lib/wallet/svm.ts` and `components/svm/SvmWalletButton.tsx`.
- No wallet imports scattered across feature components.

### 7. No raw MUI imports in feature components
- Feature components (`components/evm/`, `components/svm/`, `components/shared/`) must import UI primitives from `components/shared/ui/` — not directly from `@mui/material`.
- Exception: layout primitives (`Box`, `Stack`) used purely for spacing.

---

## Review Checklist (run before approving any PR)

```bash
# Cross-VM leaks
grep -r "from.*svm" src/components/evm/
grep -r "from.*evm" src/components/svm/
grep -r "from.*svm" src/hooks/evm/
grep -r "from.*evm" src/hooks/svm/

# Unsafe types
grep -rn ": any\|as any" src/ --include="*.ts" --include="*.tsx" | grep -v ".spec."

# God components
wc -l src/components/**/*.tsx | sort -rn | head -20

# use client on layout/page files (should be empty)
grep -l "use client" src/app/*.tsx

# Raw MUI imports in feature components (should be empty except Box/Stack)
grep -r "from \"@mui/material\"" src/components/evm/ src/components/svm/

# TypeScript and build
bun run check   # must pass with zero errors
bun run build   # must succeed
```

---

## Senior Frontend Reviewer Standards

### Component design
- **Single responsibility**: A component renders UI. It does not own async data fetching — that lives in a custom hook.
- **Prop drilling limit**: If a prop passes through more than 2 intermediate components, move it to the store or a context.
- **No inline logic in JSX**: Ternaries spanning > 2 lines or complex expressions must be extracted to a named variable or sub-component above the return.
- **No anonymous default exports**: Always name your components. `export default function MyComponent()` not `export default () =>`.

### Hook design
- **One concern per hook**: `useEvmBalances` does balances. It does not also fetch orders or manage wallet state.
- **Return size**: A hook returning > 5 values is a sign it should be split.
- **Explicit return types**: Every hook must declare its return type (interface or inline type).
- **No side effects in render**: Never call `localStorage`, `document`, or perform async work outside a `useEffect` or event handler.

### TypeScript quality
- Prefer `Record<string, unknown>` over loosely-typed intermediates.
- Do not use `Parameters<T>[0]` to extract a type that is already known — reference the type directly.
- Avoid `as SomeType` casts when the value already satisfies the type structurally.
- `bigint` for on-chain amounts — never `number` for token amounts (precision loss).

### Error handling
- `try { ... } catch (e) { throw e; }` with no transformation is dead code — remove the try/catch entirely.
- `console.error(e); throw e;` logs AND propagates the same error — pick one, let the caller decide.
- Rethrow only when adding context (wrapping in a new `Error`) or discriminating by error type.

### Unnecessary code
- **Dead types**: Types defined but never used as param/return annotations — delete them.
- **Duplicate logic**: If a util already exists, call it — do not reproduce the same conversion inline.
- **Pointless wrappers**: A function that calls one other function with no transformation should be inlined.
- **Unused imports**: Remove immediately — they signal dead code paths.

---

## Code Quality Principles

1. **Readability first**: Types are self-documenting. Prefer explicit over clever.
2. **One file, one responsibility**: Types in `types/`, logic in `hooks/` or `lib/`, UI in `components/`.
3. **No magic numbers**: Token amounts always carry `bigint` + decimals metadata. Chain IDs always come from config constants.
4. **Consistent naming**: `EvmWallet*` for EVM wallet components, `Svm*` for Solana. No mixing of naming conventions within a VM namespace.
5. **No duplicate logic**: Address formatting helpers, status label maps, and amount formatters go in `lib/` or `hooks/shared/` — not duplicated per page.

---

## What This App Does NOT Do (keep these concerns out)

- No server-side data fetching in `app/` route segments (all state is client-side — use `'use client'`)
- No REST API route handlers in `app/api/` unless explicitly required
- No global CSS files — all styling via MUI `sx` prop or `styled()`
- No direct `window`, `document`, or `localStorage` access outside of `useEffect` or event handlers
