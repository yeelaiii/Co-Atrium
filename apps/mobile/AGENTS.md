This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

## Platform Focus: Mobile Only

This app targets iOS and Android. It is **not** a web app — do not optimize for, test against, or add support for the web platform.

- Design for touch: minimum ~44pt tap targets, no hover states, no mouse/keyboard-centric interactions.
- Handle mobile concerns: safe areas (`react-native-safe-area-context`), notches, keyboard avoidance, orientation, and varied screen sizes/densities.
- Use native-feeling patterns: native navigation transitions, bottom tabs/sheets, pull-to-refresh, haptics, and platform-appropriate gestures.
- Avoid web-only APIs and CSS (`div`, `window`, `document`, `localStorage`, CSS-only styling). Use React Native components and `StyleSheet`.
- Don't add `react-native-web`-specific code, web fallbacks, or `.web.tsx` files, and don't spend effort on responsive desktop layouts.
- Use platform branching (`Platform.OS`, `.ios.tsx` / `.android.tsx`) only between iOS and Android.
- Prioritize mobile performance: list virtualization (`FlatList`/`FlashList`), image sizing/caching, minimal re-renders, and battery/network awareness (offline and flaky connections).

# Co-Atrium: brand and colour guide for the mobile app

Use this file with `co-atrium-colour-tokens.json` (the source of truth for exact values) when building or styling the Co-Atrium mobile app.

## What the product is
Co-Atrium is a coordination tool for architecture and construction teams. It reduces time wasted on documentation and retrieval: capturing site photos, RFIs, instructions and changes, and finding them again later. Users are architects, contractors, site supervisors and subcontractors, many on phones, on site, in a hurry.

## Brand feel
Calm, precise, trustworthy, a little warm. Like a well-kept drawing set, not a flashy tech app. Plenty of space, flat surfaces, strong contrast, no gradients, no drop-shadow stacks.

## Logo
- Mark: two columns of four horizontal bars (floors) either side of an open gap (the atrium). One bar on the right is orange: the one record you can always find.
- Files: `co-atrium-mark.svg`, `co-atrium-mark-reversed.svg`, `co-atrium-logo.svg`, `co-atrium-logo-reversed.svg`, `co-atrium-wordmark.svg`, `co-atrium-app-icon.svg` (1024x1024, full-bleed, let the OS apply rounding).
- Name is always written "Co-Atrium" (capital C, capital A, hyphen). The hyphen is orange in the wordmark.
- Use the normal logo on light backgrounds and the reversed logo on dark ones. Keep clear space around the mark of at least one bar height. Do not recolour, stretch or rotate.
- Inside the app, use the mark alone in headers and splash; use the full logo on onboarding and sign-in.

## Core palette
| Name | Hex | Role |
|---|---|---|
| Ink | `#14262B` | Primary text on light, dark surfaces |
| Cream | `#F4F1EA` | Light background, text on dark |
| Orange | `#E4572E` | Brand highlight: logo, graphics, large display only |
| Orange strong | `#B93A16` | Light-theme buttons, links, active states |
| Orange light | `#F0714A` | Dark-theme buttons, links, active states |

## Semantic tokens
Use semantic names in code, never raw hex in components. Values per theme are in the JSON.

Light theme: background `#F4F1EA`, surface `#FBF9F4`, border `#DDD8CC`, textPrimary `#14262B`, textSecondary `#4A5B60`, accent `#B93A16`, textOnAccent `#FFFFFF`.

Dark theme: background `#0E1C20`, surface `#14262B`, border `#2A4046`, textPrimary `#F4F1EA`, textSecondary `#A9B8BB`, accent `#F0714A`, textOnAccent `#14262B`.

Status colours (success, warning, error, info) have separate light and dark values in the JSON. Never rely on colour alone: pair with an icon and a text label.

## Rules
1. Follow the system light or dark setting by default, and provide both themes.
2. Primary buttons: `accent` fill with `textOnAccent` label. One primary button per screen.
3. Do not use `brandOrange` (`#E4572E`) for body text, small text, or as the fill behind white text. It does not reach 4.5:1 contrast. Use it for the logo, illustrations, empty-state art and large numerals.
4. Tapped, selected or "found" items (for example the retrieved record) get an `accent` marker, echoing the orange bar in the logo. Use it sparingly: orange should stay rare.
5. Cards are flat `surface` on `background` with a 1px `border`. Corner radius 12, buttons 10.
6. Minimum touch target 44x44. Visible focus ring using `focusRing`.
7. Type: Manrope. Bold (700) for titles and the wordmark, SemiBold (600) for buttons and labels, Regular (400) for body. Body 16, secondary 14, caption 12.
8. Site photos and annotations are the main content. Keep chrome quiet (cream, ink, hairline borders) so photos and markup stand out. Annotation markup defaults to `accent` with a white outline for legibility on photos.