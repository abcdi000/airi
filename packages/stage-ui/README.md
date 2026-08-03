# Stage UI

Shared core for stage

## Histoire (UI storyboard)

https://histoire.dev/

```shell
pnpm -F @proj-airi/stage-ui run story:dev
```

### Project structure

1. If a story is bound to a specific component, it can be placed beside the component in the `src` folder. e.g., `MyComponent.story.vue`
2. If a story is not bound to a specific component, then it should be placed in the `stories` folder. e.g., `MyStory.story.vue`

## Offline model providers

Client-side provider definitions live in `src/libs/providers/providers`. They
are registered through the existing provider registry, converted into the
shared Provider metadata consumed by settings pages, and persisted by
`src/stores/providers.ts`.

The `sub2api` provider supports both Responses and Chat Completions without a
Lumi Server process. Its Responses transport delegates tool authorization and
execution to `@proj-airi/core-agent`; direct image input is opt-in so existing
text models continue to use Lumi's independent vision provider.
