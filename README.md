# Telegram Web A

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/meanwebuser/telegram-tt-beauty)

## Public deployment

The Render button deploys one Docker container: the web client and its Telegram
WebSocket proxy share the same public URL. It uses the committed `dist` release
artifact, so deployment does not require local `.env` values.

This project won the first prize 🥇 at [Telegram Lightweight Client Contest](https://contest.com/javascript-web-3) and now is an official Telegram client available to anyone at [web.telegram.org/a](https://web.telegram.org/a).

According to the original contest rules, it has nearly zero dependencies and is fully based on its own [Teact](https://github.com/Ajaxy/teact) framework (which re-implements React paradigm). It also uses a custom version of [GramJS](https://github.com/gram-js/gramjs) as an MTProto implementation.

The project incorporates lots of technologically advanced features, modern Web APIs and techniques: WebSockets, Web Workers and WebAssembly, multi-level caching and PWA, voice recording and media streaming, cryptography and raw binary data operations, optimistic and progressive interfaces, complicated CSS/Canvas/SVG animations, reactive data streams, and so much more.

Feel free to explore, provide feedback and contribute.

## MCP architecture and security boundary

The Telegram MCP integration has two explicit operating modes:

- **Local mode** keeps the MCP bridge in the browser/client process. It is
  intended for a single operator and uses the local Telegram session already
  authenticated by the client.
- **Server mode** puts the MCP bridge behind an HTTP server. OAuth authenticates
  the caller and the server must still bind the request to the authorized
  browser/session context before accessing Telegram data.

In both modes, a Telegram envelope is untrusted input. The parser validates the
envelope shape, version, payload, and tool name against the canonical
`TELEGRAM_TOOL_NAMES` allowlist before a call can reach the MCP runtime. Unknown
or path-like names are rejected at this boundary; the runtime's availability
check remains a defense in depth.

The bridge is read-only by default. Mutating operations (such as sending or
editing a message) require an explicit human confirmation plus mutation
evidence bound to the exact payload and request context. OAuth proves caller
identity; it does not by itself grant mutation authority or bypass the
allowlist, session binding, or evidence gate.

The public `/mcp` and OAuth routes are deployment-dependent: source support does
not mean that a hostname currently serves MCP. Until the server-side upstream
and its deployment are verified, the supported browser path is the authenticated
`/_mcp-bridge/<connection-id>/mcp` relay. See the [network and locality
contract](docs/network-and-locality.md) for the current boundary and caveats.

## Local setup

```sh
mv .env.example .env

npm i
```

Obtain API ID and API hash on [my.telegram.org](https://my.telegram.org) and populate the `.env` file.

## Dev mode

```sh
npm run dev
```

### Invoking API from console

Start your dev server and locate GramJS worker in the console context.

All constructors and functions available in global `GramJs` variable.

Run `npm run gramjs:tl full` to get access to all available Telegram methods.

Example usage:
``` javascript
await invoke(new GramJs.help.GetAppConfig())
```

### Dependencies
* [GramJS](https://github.com/gram-js/gramjs) ([MIT License](https://github.com/gram-js/gramjs/blob/master/LICENSE))
* [fflate](https://github.com/101arrowz/fflate) ([MIT License](https://github.com/101arrowz/fflate/blob/master/LICENSE))
* [cryptography](https://github.com/spalt08/cryptography) ([Apache License 2.0](https://github.com/spalt08/cryptography/blob/master/LICENSE))
* [emoji-data](https://github.com/iamcal/emoji-data) ([MIT License](https://github.com/iamcal/emoji-data/blob/master/LICENSE))
* [twemoji-parser](https://github.com/jdecked/twemoji-parser) ([MIT License](https://github.com/jdecked/twemoji-parser/blob/master/LICENSE.md))
* [rlottie](https://github.com/Samsung/rlottie) ([MIT License](https://github.com/Samsung/rlottie/blob/master/COPYING))
* [opus-recorder](https://github.com/chris-rudmin/opus-recorder) ([Various Licenses](https://github.com/chris-rudmin/opus-recorder/blob/master/LICENSE.md))
* [qr-code-styling](https://github.com/kozakdenys/qr-code-styling) ([MIT License](https://github.com/kozakdenys/qr-code-styling/blob/master/LICENSE))
* [music-metadata](https://github.com/Borewit/music-metadata) ([MIT License](https://github.com/Borewit/music-metadata/blob/master/LICENSE.txt))
* [lowlight](https://github.com/wooorm/lowlight) ([MIT License](https://github.com/wooorm/lowlight/blob/main/license))
* [idb-keyval](https://github.com/jakearchibald/idb-keyval) ([Apache License 2.0](https://github.com/jakearchibald/idb-keyval/blob/main/LICENCE))
* [fasttextweb](https://github.com/karmdesai/fastTextWeb)
* fastblur

## Bug reports and Suggestions
If you find an issue with this app, let Telegram know using the [Suggestions Platform](https://bugs.telegram.org/c/4002).
