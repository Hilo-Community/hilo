# Hilo app icons

`Hilo.icon` contains the editable Icon Composer project for the hand mark. `Icon Exports/`
contains its six original PNG variants (Default, Dark, TintedLight, TintedDark, ClearLight
and ClearDark). Keep these exports intact when regenerating the application icons.

From the repository root, `pnpm icons` generates the Tauri platform icons from the Default
export and the browser favicons from the Default and Dark exports. The browser selects the
dark favicon when `prefers-color-scheme: dark` matches.

For macOS bundles, the Tauri `beforeBundleCommand` uses Xcode 26 or later to compile `Hilo.icon`
into `Assets.car`. On macOS Tahoe and later, macOS chooses the variant using its icon and widget
style setting. The bundled `.icns` provides the default icon for earlier macOS versions.

The macOS icon places the original artwork at 824 × 824 pixels inside a transparent
1024 × 1024 canvas (100 pixels per edge), so it fits the Dock without appearing oversized.
This padding applies only to the `.icns`; the other platform exports keep their original sizing.
