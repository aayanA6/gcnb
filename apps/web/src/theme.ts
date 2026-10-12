// A theme is one token file in /themes. Every token becomes a CSS variable
// (--colors-me, --radii-bubble, ...) and components read only those variables,
// so adding a theme is adding a JSON file.
export type Theme = {
  name: string
  description: string
  dark: boolean
  fontsUrl?: string
  colors: Record<string, string>
  fonts: Record<string, string>
  radii: Record<string, string>
  borders: Record<string, string>
  shadows: Record<string, string>
  wallpaper: string
}

const files = import.meta.glob<Theme>('../../../themes/*.json', { eager: true, import: 'default' })

export const themes: Record<string, Theme> = Object.fromEntries(
  Object.entries(files).map(([path, t]) => [path.split('/').pop()!.replace(/\.json$/, ''), t]),
)

export function applyTheme(t: Theme) {
  const root = document.documentElement
  for (const group of ['colors', 'fonts', 'radii', 'borders', 'shadows'] as const)
    for (const [k, v] of Object.entries(t[group])) root.style.setProperty(`--${group}-${k}`, v)
  root.style.setProperty('--wallpaper', t.wallpaper)
  root.style.colorScheme = t.dark ? 'dark' : 'light'

  let link = document.getElementById('theme-fonts') as HTMLLinkElement | null
  if (!link) {
    link = Object.assign(document.createElement('link'), { id: 'theme-fonts', rel: 'stylesheet' })
    document.head.append(link)
  }
  if (t.fontsUrl) link.href = t.fontsUrl
}
