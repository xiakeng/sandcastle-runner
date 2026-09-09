# TypeScript agent code standards research

Research date: 2026-09-09. Scope: guidance for a concise
`docs/agents/code-standards.md`; no proposed implementation or tooling change.

## Conclusion

The standards file should contain only project-specific judgment that an AI
cannot delegate to Prettier, ESLint, or `tsc`. The strongest recurring guidance
from popular TypeScript repositories is to trace the real flow before editing,
put each invariant at its owning boundary, model external and intermediate
states truthfully, make errors and resource ownership explicit, reuse existing
code, and verify observable behavior at the smallest stable seam.

This matches the official VS Code guidance to keep instructions concise,
project-specific, and focused on rules that standard linters and formatters do
not already enforce. [VS Code custom-instruction guidance](https://code.visualstudio.com/docs/agent-customization/custom-instructions#_tips-for-writing-effective-instructions)

## Source sample and adoption evidence

Stars are repository-level evidence observed on 2026-09-09. They show that the
hosting project or instruction collection is widely used; GitHub exposes no
per-file adoption counter, so they do not prove how often a particular
instruction file is loaded.

| Source | Popularity evidence | Useful design guidance |
| --- | ---: | --- |
| [VS Code Copilot instructions](https://github.com/microsoft/vscode/blob/b3a7dc40ed7065f2b14d66ada45c917e1329ae03/.github/copilot-instructions.md#L45-L65) | 191,504 stars ([repository](https://github.com/microsoft/vscode)) | Follow imports and tests before changing code; preserve architectural layers; run the narrowest validation that covers the risk. Avoid exporting symbols without a real cross-component consumer, make service dependencies explicit, and keep event notification separate from control flow. [Quality and ownership rules](https://github.com/microsoft/vscode/blob/b3a7dc40ed7065f2b14d66ada45c917e1329ae03/.github/copilot-instructions.md#L131-L152) |
| [Jest coding-agent instructions](https://github.com/jestjs/jest/blob/69b089574f10e607a93ad1b3eb56b4876e2a43fb/.github/copilot-instructions.md#L121-L141) | 45,469 stars ([repository](https://github.com/jestjs/jest)) | Judge encapsulation at the consumer boundary, not by making every internal object elaborate. Validate at system boundaries, narrow thrown values instead of casting, avoid exceptions as normal control flow, and write comments only for a non-obvious reason or invariant. Its flow map also demonstrates that instructions should tell agents where user-visible behavior crosses packages. [Flow guidance](https://github.com/jestjs/jest/blob/69b089574f10e607a93ad1b3eb56b4876e2a43fb/.github/copilot-instructions.md#L143-L195) |
| [pnpm `AGENTS.md`](https://github.com/pnpm/pnpm/blob/b44439419e6f0e2e2c768db1c6fffae35827b49f/AGENTS.md#L133-L140) | 36,467 stars ([repository](https://github.com/pnpm/pnpm)) | Search for existing helpers before writing code and keep a dependency at the narrowest owner. Errors should carry stable meaning and useful context, impossible states should fail explicitly, configuration should flow through its owning layer, handlers should return data rather than print it, and independent async work may run concurrently while required work is awaited. [TypeScript conventions](https://github.com/pnpm/pnpm/blob/b44439419e6f0e2e2c768db1c6fffae35827b49f/AGENTS.md#L303-L313) |
| [GitHub Awesome Copilot TypeScript MCP instructions](https://github.com/github/awesome-copilot/blob/fc5530604551d3eeb7a0797994c94c66a189ba74/instructions/typescript-mcp-server.instructions.md#L34-L49) | 38,795 stars for the community instruction collection ([repository](https://github.com/github/awesome-copilot)) | Keep externally invoked operations focused, validate input before processing, return structured errors, document capability limits, and close resources on transport termination. The MCP-specific library prescriptions are not transferable to this dependency-free CLI. |
| [OpenAI Node SDK `AGENTS.md`](https://github.com/openai/openai-node/blob/7b7d6ca71130d37ec09792c50056b47861f2eccf/AGENTS.md#L10-L48) | 11,166 stars ([repository](https://github.com/openai/openai-node)) | Reproduce behavior through the public entry point, fix an invariant once at its owner, separate incomplete wire state from enriched public state, and prefer narrowing over assertions that hide an unproven contract. Preserve meaningful falsy values and distinguish omission from `null` or `undefined`. [Compatibility guidance](https://github.com/openai/openai-node/blob/7b7d6ca71130d37ec09792c50056b47861f2eccf/AGENTS.md#L50-L74) |

These sources were selected for concrete adoption and direct AI-facing files,
not because every repository-specific rule should be copied. For example, VS
Code's localization services, Jest's VM helpers, pnpm's custom error class, and
the Awesome Copilot MCP dependencies do not belong in Sandcastle Runner.

## Local fit

### Mechanical rules already owned by tools

Do not repeat these as prose unless an exception or design rationale is needed:

- Prettier owns whitespace, wrapping, quote selection, punctuation, and other
  AST-preserving formatting. The repository already runs it through
  `format:check`. [Prettier scope](https://prettier.io/docs/)
- ESLint owns configured syntax and static-pattern diagnostics. The repository
  already enables `eslint:recommended`, `recommendedTypeChecked`, and
  `stylisticTypeChecked`; the latter is explicitly a concise/consistent-code
  ruleset, not a substitute for design guidance.
  [typescript-eslint shared configs](https://typescript-eslint.io/users/configs/)
- `tsc --noEmit` owns compiler-checkable type correctness. This repository uses
  `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `noFallthroughCasesInSwitch`, `noImplicitOverride`, and
  `noUncheckedSideEffectImports`. In particular, the compiler already enforces
  the distinction between an absent optional property and one set to
  `undefined`. [TypeScript option semantics](https://www.typescriptlang.org/tsconfig/exactOptionalPropertyTypes.html)

The standards should say to run `npm run check`, not restate the rules those
tools already report. If a future semantic rule can be enforced reliably, put
it in tooling and remove the prose duplicate.

### Contextual rules the agent still needs

1. **Read and preserve the contract.** Use the exact vocabulary in
   `CONTEXT.md`; trace callers, imports, and affected tests before editing.
   Existing specifications and ADRs outrank generic advice.
2. **Keep one owner for each fact and side effect.** Respect the six V1
   boundaries (`Tracker`, `CodeHost`, `GitWorkspace`, `AgentExecutor`, `Clock`,
   and `OperatorIO`). Put validation, normalization, mutation, and cleanup at
   the boundary that owns them instead of compensating in callers.
3. **Model state truthfully.** Validate configuration, tracker/code-host data,
   agent output, and operator input at trust boundaries. Represent distinct
   workflow states explicitly; do not use truthiness or type assertions to
   collapse missing, partial, cancelled, failed, or completed states.
4. **Make failure and lifetime visible.** Never swallow errors. Attach operation
   and target context, preserve the specified retry/pause semantics, await every
   required effect, and make process, worktree, stream, timer, and other resource
   ownership and cleanup explicit. Parallelize only independent operations while
   retaining deterministic selection and integration order.
5. **Prefer the smallest existing solution.** Reuse repository helpers and Node
   platform facilities before adding code or dependencies. Add an abstraction
   only for a real external boundary or a coherent responsibility already
   required by the change; keep exports private until another component needs
   them.
6. **Let names and types explain what; comments explain why.** Use glossary terms
   consistently. Comment only a hidden invariant, non-obvious constraint,
   deliberate exception, or ownership reason; do not narrate the code or its
   history.
7. **Verify behavior at the risk-bearing seam.** Follow
   `docs/agents/test-value-gate.md`. For a bug, first reproduce the public
   behavior and add the smallest regression that fails before the fix. Prefer
   the complete `Run` seam with scripted external-boundary fakes, controlled
   time, and observable operation order over private-helper or mock assertions.
   Use the smallest artifact-appropriate check for non-behavioral changes.

## Recommended `code-standards.md` outline

Keep the final file short, imperative, and link to existing authorities instead
of copying them:

1. **Authority and scope**: `CONTEXT.md`, specifications/ADRs, then this file;
   state that Prettier, ESLint, and `tsc` own mechanical diagnostics.
2. **Design and ownership**: trace the flow; one authoritative source for each
   fact; preserve the six external boundaries; minimal exports and abstractions;
   reuse before adding dependencies.
3. **Types, state, and trust boundaries**: validate external data, narrow rather
   than assert, preserve absence/falsy distinctions, make invalid states explicit.
4. **Errors, async work, and cleanup**: contextual errors, no swallowing,
   deterministic concurrency, awaited effects, single explicit resource owner.
5. **Names and comments**: glossary vocabulary, intent-revealing names, comments
   for non-obvious reasons only.
6. **Verification**: `npm run check`, then a short link to the existing Test Value
   Gate and orchestration testing contract.
