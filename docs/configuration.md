# Configuration

Local state lives under `MODEL_ROUTER_HOME` when it is set, otherwise the platform config
directory: `~/Library/Application Support/model-router` on macOS,
`$XDG_CONFIG_HOME/model-router` (default `~/.config/model-router`) on Linux, and
`%APPDATA%\model-router` on Windows.

`MODEL_ROUTER_HOME/config.json` example:

```json
{
  "accounts": [
    {
      "id": "acct_personal_cursor",
      "label": "personal cursor",
      "provider": "cursor",
      "agent": "cursor",
      "ownership": "personal",
      "collectorPreference": ["official-cli", "local-session", "browser-dashboard"],
      "enabledModels": ["cursor:grok-4.6"],
      "enabled": true,
      "credentialRef": "env:CURSOR_API_KEY"
    }
  ],
  "coordinator": {
    "url": "https://example.invalid",
    "readerCredentialRef": "env:COORDINATOR_READER_TOKEN"
  },
  "typesafe": {
    "apiKeyRef": "keychain:model-router-typesafe"
  },
  "enrichment": {
    "enabled": true
  },
  "liveEffort": {
    "enabled": false
  }
}
```

Credential values stay in the environment or keychain. The router stores references
only (`env:NAME` or `keychain:NAME`). `keychain:NAME` reads the macOS login Keychain
generic password with service `NAME` (`security find-generic-password -s NAME -w`); add
one with `security add-generic-password -a "$USER" -s NAME -w`. For `typesafe.apiKeyRef`,
`TYPESAFE_API_KEY` is used when the reference has no value. Shared `reserveFloor` cannot be set below `0.40`.
`collectorPreference` lists collector kinds in preference order. `router run` uses only
`local-session` collectors unless you pass `--usage`, which runs the full chain
(official-cli/api, local-session, browser).
`enrichment.enabled` defaults to `true`. Set it to `false` to prevent `router run` from
resolving pull request size through GitHub; `--no-enrich` disables it for one invocation.
`liveEffort.enabled` defaults to `false`. Set it to `true` to let the router change the
reasoning effort of a running Opus 5.5 (`anthropic:claude-opus`) or GPT 6 Astra
(`openai:gpt-6-astra`) pane instead of opening a new one; see "Live effort switching" in the
README. When `false`, phases always open a new pane and `router effort` reports `disabled`.
`models` (optional) declares extra model profiles in the same shape as the entries in
`packages/router/config/models.json`, so a model the built-in catalog does not ship can be
routed without editing the plugin checkout (which an update replaces). Each entry is
validated with the catalog schema and added to the built-in catalog. An `id` that is already
built in, or that appears twice in `models`, is an error naming the entry; `router accounts`
reports it, and also warns when an account enables a model ID that nothing defines (such an
ID is never routed to). User models only add; they cannot replace a built-in profile.

### Example: OpenCode Go (Kimi K3.1 Pro)

OpenCode Go models are data, not code: an `opencode` account plus a user model whose
`launchName` is the `provider/model` name from `opencode models`. The full file is
[`docs/examples/opencode-go.config.json`](examples/opencode-go.config.json):

```json
{
  "accounts": [
    {
      "id": "acct_opencode_go",
      "label": "opencode go",
      "provider": "opencode-go",
      "agent": "opencode",
      "ownership": "personal",
      "collectorPreference": ["local-session"],
      "enabledModels": ["opencode-go:kimi-k3.1-pro"],
      "enabled": true
    }
  ],
  "models": [
    {
      "id": "opencode-go:kimi-k3.1-pro",
      "provider": "opencode-go",
      "agent": "opencode",
      "launchName": "opencode-go/kimi-k3.1-pro",
      "supportedEfforts": ["none"],
      "capabilities": {
        "planning": 0.75,
        "coding": 0.8,
        "debugging": 0.75,
        "creativity": 0.7,
        "research": 0.7
      },
      "relativeQuotaCost": 0.5,
      "relativeLatency": 1
    }
  ]
}
```

- The router starts it as `opencode mini --model opencode-go/kimi-k3.1-pro` (OpenCode 2.x
  accepts `--model` only on `mini`, not the root TUI). Log in to OpenCode Go
  with `opencode auth login` first; the router stores no OpenCode credential.
- `supportedEfforts` is `["none"]` because the OpenCode TUI has no effort flag.
- `capabilities`, `relativeQuotaCost` and `relativeLatency` are estimates; adjust them.
- Usage: no OpenCode Go collector exists, so usage is `unknown` (source `none`), which is not
  an error. A `personal` account stays eligible and is ranked as if its quota were full
  (projected remaining `1.0`), so TypeSafe weighs it on capabilities and cost. A `shared`
  account with unknown usage is excluded (`unknown-usage`), as for every provider. Merge
  other models into the same `models` array the same way.

`MODEL_ROUTER_COORDINATOR_URL` overrides the file URL.
Coordinator URLs must use HTTPS; HTTP is accepted only for `localhost`, `127.0.0.1`, or
`[::1]` during local development.
