/**
 * WS-A: request pipeline — redaction -> compression -> forward (owned by agent-proxy).
 *
 * Hard rule: the redaction stage runs FIRST and is never weakened or reordered
 * after compression (CLAUDE.md).
 */
