# Third-Party Notices

OpenRGB Companion uses third-party open-source software.

This document highlights the direct dependencies used by this repository.
Transitive dependencies may add further license notices; their original licenses
and copyright notices remain applicable.

## openrgb-rs2 / `openrgb2`

- Project: https://github.com/Achtuur/openrgb-rs2
- Purpose: OpenRGB SDK client library
- License metadata: GPL-2.0
- OpenRGB Companion currently depends on `openrgb2 = "0.3.0"`.

The openrgb-rs2 project is distributed under the GNU General Public License v2.
Its repository contains the full license text and upstream copyright notices.

## Tauri

- Project: https://tauri.app/
- Components used: `tauri`, `tauri-build`, `@tauri-apps/api`, `@tauri-apps/cli`
- License: MIT OR Apache-2.0

## React / React DOM

- Project: https://react.dev/
- License: MIT

## Vite / @vitejs/plugin-react

- Project: https://vite.dev/
- License: MIT

## TypeScript

- Project: https://www.typescriptlang.org/
- License: Apache-2.0

## serde / serde_json

- Project: https://serde.rs/
- License: MIT OR Apache-2.0

## DefinitelyTyped React type definitions

- Packages: `@types/react`, `@types/react-dom`
- Project: https://github.com/DefinitelyTyped/DefinitelyTyped
- License: MIT

## OpenRGB

OpenRGB itself is **not bundled** with OpenRGB Companion.

- Project: https://gitlab.com/CalcProgrammer1/OpenRGB
- Website: https://openrgb.org/

OpenRGB Companion connects to an independently installed OpenRGB instance through
the OpenRGB SDK Server and reads/writes supported OpenRGB configuration files.

## Scheduler Plugin

The OpenRGB Scheduler Plugin is **not bundled** with OpenRGB Companion.
Scheduler-related UI is shown only when a supported installed Scheduler Plugin
configuration is detected.

---

For exact dependency versions used by a given build, refer to `package.json`,
`src-tauri/Cargo.toml`, and the dependency metadata resolved by the build tools.
