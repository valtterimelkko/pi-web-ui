# Session-render characterisation fixtures

Invented, runtime-shaped `NormalizedEvent` streams (`<runtime>.normalized.json`) used to pin Pi Web UI's session
rendering while it moves into `packages/session-core` and `packages/session-ui` (command-centre step 1a). Nothing here
comes from a real session: names, paths, models and text are made up.

`__golden__/` is a chain of file snapshots, each stage's output being the next stage's input:

| Golden | Written by | Pins |
|---|---|---|
| `<runtime>.pi-events.json` | `server/tests/unit/websocket/session-render-characterisation.test.ts` | `normEventToPiFormat` |
| `<runtime>.screen-view.json` | `shared/tests/session-render-characterisation.test.ts` | the screen-view projection (collapsed, expanded, Markdown) |
| `<runtime>.messages.json` | `client/tests/unit/store/sessionRender.characterisation.test.ts` | the history fold (`history_start` … `history_end`) and the `LiveMessage` adapter |

The folded messages also feed the screenshot harness (`client/session-render-harness/`), whose baselines live in
`tests/visual/__screenshots__/` and run with `npm run test:visual:session-render` (set `SESSION_RENDER_CHROMIUM` to a
Chromium binary when Playwright's own download is absent). Regenerate goldens only on purpose (`vitest -u`,
`--update-snapshots`), never to make a refactor pass.
