# Third-party notices

The Switchboard Dashboard copies source code from the projects below into
`src/`, and depends on the packages listed after them. Every copied file keeps
a header comment where it was changed. No GPL or AGPL code is included.

## Design

The look is Switchboard's own: the design system in `src/styles/tokens.css`
(ADR 0016, light and dark) that every vendored component reads. Vendored
components are re-skinned through those tokens only.

## Source code copied into this repo

| Project | Licence | Copyright | Files |
| --- | --- | --- | --- |
| Kibo UI (github.com/shadcnblocks/kibo, registry item `kanban` at kibo-ui.com/r/kanban.json) | MIT | (c) 2023 - present shadcnblocks | `src/components/kibo-ui/kanban` (the Tasks board), `banner` |
| Beautiful UI (github.com/slev12397/beautiful-ui, registry beautifului.dev) | MIT | (c) 2026 Shane Levine | `src/components/atoms/*` (Button), `src/components/primitives/*` (CodeBlock, LoadingState) |
| shadcn/ui (github.com/shadcn-ui/ui) | MIT | (c) 2023 shadcn | `src/components/ui/*` except the prompt-kit files below, `src/hooks/use-mobile.ts` |
| prompt-kit (github.com/ibelick/prompt-kit) | MIT | (c) 2025 Julien Thibeaut | `src/components/ui/reasoning.tsx` |

Every file above is re-skinned and says so in a header comment where it changed.

## Packages (installed from npm, not copied)

| Package | Licence | Copyright |
| --- | --- | --- |
| dnd-kit (`@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`) | MIT | (c) 2021 Claudéric Demers |
| tunnel-rat | MIT | (c) 2022 Poimandres |
| Radix UI (`radix-ui`, `@radix-ui/react-use-controllable-state`) | MIT | (c) 2022 WorkOS |
| cmdk | MIT | (c) 2022 Paco Coursey |
| Sonner | MIT | (c) 2023 Emil Kowalski |
| tw-animate-css | MIT | (c) 2025 Wombosvideo |
| class-variance-authority, clsx, tailwind-merge | Apache-2.0 / MIT / MIT | their authors |
| Tailwind CSS, Vite, React | MIT | their authors |
| Spline Sans (`@fontsource-variable/spline-sans`) | SIL OFL 1.1 | (c) 2021 The Spline Sans Project Authors |
| Spline Sans Mono (`@fontsource-variable/spline-sans-mono`) | SIL OFL 1.1 | (c) 2022 The Spline Sans Mono Project Authors |
| Lucide (`lucide-react`) | ISC | (c) Lucide Contributors 2022; portions (c) 2013-2022 Cole Bemis (Feather, MIT) |

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
