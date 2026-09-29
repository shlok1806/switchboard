# Third-party notices

The Switchboard Dashboard copies source code from the projects below into
`src/`, and depends on the packages listed after them. Every copied file keeps
a header comment where it was changed. No GPL or AGPL code is included.

## Source code copied into this repo

| Project | Licence | Copyright | Files |
| --- | --- | --- | --- |
| Beautiful UI (github.com/slev12397/beautiful-ui, registry beautifului.dev) | MIT | (c) 2026 Shane Levine | `src/app/beautifui/foundation.css`, `src/components/atoms/*` (Button, Chip, ProgressRing, SegmentedControl, Shimmer, StatusPill), `src/components/primitives/*` (ApprovalCard, ChatComposer, CodeBlock, DiffTable, GlideMenu, LoadingState, StreamingText, TaskRows, ThinkingState, ToolChips) |
| shadcn/ui (github.com/shadcn-ui/ui) | MIT | (c) 2023 shadcn | `src/components/ui/*` except the prompt-kit files below, `src/components/app-sidebar.tsx`, `nav-main.tsx`, `nav-user.tsx` (from the `sidebar-07` block), `src/hooks/use-mobile.ts` |
| prompt-kit (github.com/ibelick/prompt-kit) | MIT | (c) 2025 Julien Thibeaut | `src/components/ui/steps.tsx`, `tool.tsx`, `reasoning.tsx`, `text-shimmer.tsx`, `prompt-input.tsx` |
| Kibo UI (github.com/shadcnblocks/kibo) | MIT | (c) 2023 - present shadcnblocks | `src/components/kibo-ui/status`, `relative-time`, `snippet`, `banner` |

## Packages (installed from npm, not copied)

| Package | Licence | Copyright |
| --- | --- | --- |
| Radix UI (`radix-ui`, `@radix-ui/react-use-controllable-state`) | MIT | (c) 2022 WorkOS |
| cmdk | MIT | (c) 2022 Paco Coursey |
| Sonner | MIT | (c) 2023 Emil Kowalski |
| Motion | MIT | (c) 2024 Motion B.V. |
| NumberFlow (`@number-flow/react`) | MIT | (c) 2024 Maxwell Barvian |
| react-resizable-panels | MIT | (c) 2018 Brian Vaughn |
| Lucide (`lucide-react`) | ISC | (c) Lucide Contributors |
| shadow-plugin | MIT | (c) 2026 Florian Kiem |
| tw-animate-css | MIT | (c) 2025 Wombosvideo |
| class-variance-authority, clsx, tailwind-merge | Apache-2.0 / MIT / MIT | their authors |
| Tailwind CSS, Vite, React | MIT | their authors |
| Inter, Space Grotesk, JetBrains Mono (via `@fontsource-variable/*`) | SIL OFL 1.1 | their authors |

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

## ISC License (Lucide)

```
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

The SIL Open Font License 1.1 text ships with each font package in
`node_modules/@fontsource-variable/*/LICENSE`.
