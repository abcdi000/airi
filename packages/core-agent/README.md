# @proj-airi/core-agent

Core chat orchestration for AIRI stages. It composes context, streams model
output, discovers registered tools, executes authorized tools, appends tool
results, and continues multi-step model turns.

## Provider-native transports

Most providers use the existing xsAI Chat Completions path. Providers whose
wire protocol is not Chat Completions may expose `providerChatTransport` and a
`ProviderChatTransport`. The transport performs one model round and emits the
normalized text, reasoning, tool-call, usage, and finish events expected by the
runtime.

Use this boundary for protocols such as OpenAI Responses. Do not execute tools
inside a provider transport: core-agent remains responsible for tool policy,
execution, result correlation, cancellation, and the configured maximum step
count. A transport may return `undefined` only on its first round to delegate
the complete turn to the provider's regular Chat Completions configuration.
