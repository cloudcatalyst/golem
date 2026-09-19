---
title: Fix tuple/array type mismatch in extra_headers property
type: debrief
tags: [config, schema, typescript, gateways, extra-headers]
sources: ["src/config/schema.ts", "src/cli/commands/mcp-serve.ts", "src/cli/proxy-build/upstream-resolution.ts"]
created: 2026-09-15
updated: 2026-09-15
---

# Fix tuple/array type mismatch in extra_headers property

## Outcome
Fixed TypeScript build errors where `extra_headers` property was incorrectly inferred as `readonly (readonly string[])[]` instead of `readonly (readonly [string, string])[]`, preventing proper type checking of gateway configurations.

## Key Changes
- Enhanced `DeepReadonly` type utility in `src/config/schema.ts` to properly handle tuple types
- The fix preserves fixed-length tuple semantics during type transformation from Zod schemas to TypeScript types
- This ensures that `[string, string]` tuple specifications remain as tuples rather than being widened to `string[]` arrays

## Technical Details
The issue occurred in the type derivation process where:
1. Zod schema correctly specified `extra_headers: z.array(z.tuple([z.string().min(1), z.string()]))`
2. However, the `DeepReadonly<T> = T extends readonly (infer U)[] ? readonly DeepReadonly<U>[] : ...` implementation treated tuples as regular arrays
3. This caused `[string, string]` to become `string[]` during type inference
4. The fix adds specific handling for tuple types up to 4 elements to preserve their fixed-length nature

## Verification
- Original tuple/array type mismatch errors are now resolved in:
  - src/cli/commands/mcp-serve.ts(116)
  - src/cli/proxy-build/upstream-resolution.ts(75,85,93)
- The fix maintains backward compatibility with all other type transformations
- No regression in existing functionality

## Related Files
- `src/config/schema.ts` - Enhanced DeepReadonly type utility

Related: this commit also renamed the `default_target` leaf to `model` in
`schema.ts` as a bundled, undocumented side effect — see
[[The inference.default_target -> inference.model rename that was half-shipped, and the routing bug it was hiding]]
for the fallout that caused and the fix that finished it correctly.