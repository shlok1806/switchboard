# Third-party notices

The Switchboard Dashboard copies source code from the projects below into
`src/`, and depends on the packages listed after them. Every copied file keeps
a header comment where it was changed. No GPL or AGPL code is included.

## Design taken from shlokthakkar.com

The look is the ShlokOS desktop from the owner's own site (repo
`shlok1806/shlok-portfolio`, local copy `~/PersonalWebsite-plugin`), used by
its author, not a third party:

- `src/styles/tokens.css`: the four presets (Motif, CDE, Console, twm) as HSL
  tokens, copied from its `app/globals.css`.
- `src/index.css`: the `bevel-out` / `bevel-in` / `bevel-thin` classes, the
  root-window stipple, the Motif scrollbars, the stepped `win-in` and caret
  keyframes, from the same file.
- `src/components/pixel-icon.tsx`: the 16x16 one-bit pixmaps and their SVG
  renderer, from its `lib/os/icons.tsx`, with new pixmaps drawn on the same grid.
- `src/components/shell/window.tsx` and `panel.tsx`: the window frame and the
  taskbar, rebuilt after its `components/os/Window.tsx` and `Panel.tsx`.

Vendored components are re-skinned through that token layer the way its
`docs/adr/0001-vendor-opensourceui-through-the-token-layer.md` describes:
tokens only, bevels instead of shadows and blur, no rounded corners, pixmaps
instead of an icon set.

## Source code copied into this repo

| Project | Licence | Copyright | Files |
| --- | --- | --- | --- |
| Kibo UI (github.com/shadcnblocks/kibo, registry item `kanban` at kibo-ui.com/r/kanban.json) | MIT | (c) 2023 - present shadcnblocks | `src/components/kibo-ui/kanban` (the Tasks board), `status`, `relative-time`, `snippet`, `banner` |
| Beautiful UI (github.com/slev12397/beautiful-ui, registry beautifului.dev) | MIT | (c) 2026 Shane Levine | `src/app/beautifui/foundation.css`, `src/components/atoms/*` (Button, Chip, SegmentedControl, StatusPill), `src/components/primitives/*` (ChatComposer, CodeBlock, LoadingState, ToolChips) |
| shadcn/ui (github.com/shadcn-ui/ui) | MIT | (c) 2023 shadcn | `src/components/ui/*` except the prompt-kit files below, `src/hooks/use-mobile.ts` |
| prompt-kit (github.com/ibelick/prompt-kit) | MIT | (c) 2025 Julien Thibeaut | `src/components/ui/tool.tsx`, `reasoning.tsx` |

Every file above is re-skinned and says so in a header comment where it changed.

## Packages (installed from npm, not copied)

| Package | Licence | Copyright |
| --- | --- | --- |
| dnd-kit (`@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`) | MIT | (c) 2021 Claudéric Demers |
| tunnel-rat | MIT | (c) 2022 Poimandres |
| Radix UI (`radix-ui`, `@radix-ui/react-use-controllable-state`) | MIT | (c) 2022 WorkOS |
| cmdk | MIT | (c) 2022 Paco Coursey |
| Sonner | MIT | (c) 2023 Emil Kowalski |
| react-resizable-panels | MIT | (c) 2018 Brian Vaughn |
| shadow-plugin | MIT | (c) 2026 Florian Kiem |
| tw-animate-css | MIT | (c) 2025 Wombosvideo |
| class-variance-authority, clsx, tailwind-merge | Apache-2.0 / MIT / MIT | their authors |
| Tailwind CSS, Vite, React | MIT | their authors |
| Inter (`@fontsource-variable/inter`), Space Mono (`@fontsource/space-mono`) | SIL OFL 1.1 | their authors |

No GPL or AGPL code is included. Planka, Plane and Focalboard (AGPL) were not
used.

## MIT License (applies to every MIT entry above, with its copyright line)

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The SIL Open Font License 1.1 text ships with each font package in
`node_modules/@fontsource-variable/inter/LICENSE and node_modules/@fontsource/space-mono/LICENSE`.
